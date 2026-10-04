import Foundation
import Network

// Debug builds only: release builds compile this file to nothing.
#if DEBUG

/**
 * Lets a debug build reach Metro (and other dev servers) on the Mac through the USB cable.
 *
 * iOS has no `adb reverse`: usbmuxd only lets the Mac connect *into* a port on the phone. So the direction is
 * flipped: the app listens on the phone's loopback, the Mac-side CLI dials in over usbmux on the control port,
 * and every connection the app makes to 127.0.0.1:<port> is carried over that one control connection as frames.
 *
 * Frame: [payload length: u32 BE][type: u8][stream: u32 BE][payload]
 *   HELLO  (Mac → phone)  payload = JSON {"ports": [8081, …], "host": "MacBook-Pro"}: device ports to listen on
 *   OPEN   (phone → Mac)  payload = u16 BE device port; the Mac connects to its mapped host port
 *   DATA   (both)         payload = bytes for the stream
 *   CLOSE  (both)         stream ended
 */
@objc public final class MetroUsb: NSObject {
  @objc public static let shared = MetroUsb()

  static let controlPort: UInt16 = 27753
  static let defaultPorts: [UInt16] = [8081]

  private enum FrameType: UInt8 {
    case hello = 1, open = 2, data = 3, close = 4
  }

  private let queue = DispatchQueue(label: "metro-usb")
  private var controlListeners: [NWListener] = []
  private var control: NWConnection?
  private var localListeners: [UInt16: [NWListener]] = [:]
  private var streams: [UInt32: NWConnection] = [:]
  private var nextStream: UInt32 = 1
  private var inbox = Data()
  private var started = false

  @objc public func start() {
    #if targetEnvironment(simulator)
    // The Simulator shares the Mac's network, so it reaches Metro directly. A relay there would also bind the Mac's
    // own 127.0.0.1:8081 and shadow the real Metro for everything else on the Mac. Only for testing the relay itself.
    guard ProcessInfo.processInfo.environment["METRO_USB_SIMULATOR"] == "1" else { return }
    let ports: [UInt16] = []
    #else
    let ports = Self.defaultPorts
    #endif
    queue.async {
      guard !self.started else { return }
      self.started = true
      // The relay is a process-wide singleton, so strong captures are fine.
      self.controlListeners = self.listen(on: Self.controlPort) { connection in self.acceptControl(connection) }
      ports.forEach(self.listenLocal)
      self.log("listening; run the Mac-side relay and open http://localhost:\(Self.defaultPorts[0])")
    }
  }

  // MARK: - Listeners (bound to loopback: nothing on Wi-Fi or cellular can reach them)

  /// Listens on 127.0.0.1 and ::1, since "localhost" may resolve to either.
  private func listen(on port: UInt16, accept: @escaping (NWConnection) -> Void) -> [NWListener] {
    guard let nwPort = NWEndpoint.Port(rawValue: port) else { return [] }
    let hosts: [NWEndpoint.Host] = [.ipv4(.loopback), .ipv6(.loopback)]
    return hosts.compactMap { host -> NWListener? in
      let parameters = NWParameters.tcp
      // Bind the address itself, not just prefer the loopback interface: the latter still listens on every interface.
      parameters.requiredLocalEndpoint = .hostPort(host: host, port: nwPort)
      parameters.allowLocalEndpointReuse = true
      guard let listener = try? NWListener(using: parameters) else {
        log("could not listen on \(host):\(port)")
        return nil
      }
      listener.newConnectionHandler = accept
      listener.stateUpdateHandler = { [weak self] state in
        if case .failed(let error) = state { self?.log("listener \(host):\(port) failed: \(error)") }
      }
      listener.start(queue: queue)
      return listener
    }
  }

  private func listenLocal(_ port: UInt16) {
    guard localListeners[port] == nil, port != Self.controlPort else { return }
    localListeners[port] = listen(on: port) { [weak self] connection in self?.acceptLocal(connection, port: port) }
  }

  // MARK: - Control connection (from the Mac)

  private func acceptControl(_ connection: NWConnection) {
    // One Mac at a time; a new one (e.g. after the CLI restarts) replaces the old.
    dropControl()
    control = connection
    inbox = Data()
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready: self?.log("Mac connected")
      case .failed, .cancelled: if self?.control === connection { self?.dropControl() }
      default: break
      }
    }
    connection.start(queue: queue)
    receiveControl(connection)
  }

  private func dropControl() {
    guard let connection = control else { return }
    control = nil
    connection.cancel()
    streams.values.forEach { $0.cancel() }
    streams.removeAll()
    DispatchQueue.main.async { MetroUsbIntegrations.stopAdvertising() }
    log("Mac disconnected")
  }

  private func receiveControl(_ connection: NWConnection) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
      guard let self, self.control === connection else { return }
      if let data { self.inbox.append(data); self.drainInbox() }
      if isComplete || error != nil { self.dropControl(); return }
      self.receiveControl(connection)
    }
  }

  private func drainInbox() {
    while inbox.count >= 9 {
      let length = Int(inbox.readUInt32(at: 0))
      guard inbox.count >= 9 + length else { return }
      let type = FrameType(rawValue: inbox[inbox.startIndex + 4])
      let stream = inbox.readUInt32(at: 5)
      let payload = inbox.subdata(in: (inbox.startIndex + 9)..<(inbox.startIndex + 9 + length))
      inbox.removeSubrange(inbox.startIndex..<(inbox.startIndex + 9 + length))
      handle(type, stream: stream, payload: payload)
    }
  }

  private func handle(_ type: FrameType?, stream: UInt32, payload: Data) {
    switch type {
    case .hello:
      let hello = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] ?? [:]
      let ports = (hello["ports"] as? [Int] ?? []).compactMap { UInt16(exactly: $0) }
      ports.forEach(listenLocal)
      if let metro = ports.first { macReady(metroPort: metro, host: hello["host"] as? String) }
    case .data:
      streams[stream]?.send(content: payload, completion: .contentProcessed { _ in })
    case .close:
      streams.removeValue(forKey: stream)?.cancel()
    case .open, .none:
      break
    }
  }

  // MARK: - Making the relayed Metro easy to reach

  /// Once a Mac is on the line: list its Metro in dev launchers (Bonjour), and open it if nothing is running yet.
  private func macReady(metroPort: UInt16, host: String?) {
    let name = host.map { "Metro over USB · \($0)" } ?? "Metro over USB"
    DispatchQueue.main.async { MetroUsbIntegrations.advertiseMetro(onPort: metroPort, name: name) }

    // Only open it when Metro is actually up on the Mac; otherwise the launcher would just show an error.
    guard let status = URL(string: "http://127.0.0.1:\(metroPort)/status"),
          let app = URL(string: "http://localhost:\(metroPort)") else { return }
    var request = URLRequest(url: status, timeoutInterval: 5)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
      guard let data, String(decoding: data, as: UTF8.self).contains("packager-status:running") else {
        self?.log("Metro isn't running on the Mac yet; open it from the dev launcher once it is")
        return
      }
      DispatchQueue.main.async {
        if MetroUsbIntegrations.open(inDevLauncherIfIdle: app) { self?.log("opening \(app)") }
      }
    }.resume()
  }

  // MARK: - Local connections (from the app, e.g. the bundle request to 127.0.0.1:8081)

  private func acceptLocal(_ connection: NWConnection, port: UInt16) {
    guard control != nil else {
      // No Mac on the other end: fail fast so the app shows its usual "can't reach Metro" instead of hanging.
      connection.cancel()
      return
    }
    let stream = nextStream
    nextStream &+= 1
    streams[stream] = connection
    connection.start(queue: queue)
    var portBytes = Data(count: 2)
    portBytes[0] = UInt8(port >> 8)
    portBytes[1] = UInt8(port & 0xff)
    send(.open, stream: stream, payload: portBytes)
    receiveLocal(connection, stream: stream)
  }

  private func receiveLocal(_ connection: NWConnection, stream: UInt32) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
      guard let self, self.streams[stream] === connection else { return }
      if let data, !data.isEmpty { self.send(.data, stream: stream, payload: data) }
      if isComplete || error != nil {
        self.streams.removeValue(forKey: stream)
        connection.cancel()
        self.send(.close, stream: stream, payload: Data())
        return
      }
      self.receiveLocal(connection, stream: stream)
    }
  }

  private func send(_ type: FrameType, stream: UInt32, payload: Data) {
    guard let control else { return }
    var frame = Data(capacity: 9 + payload.count)
    frame.appendUInt32(UInt32(payload.count))
    frame.append(type.rawValue)
    frame.appendUInt32(stream)
    frame.append(payload)
    control.send(content: frame, completion: .contentProcessed { _ in })
  }

  private func log(_ message: String) {
    NSLog("[metro-usb] %@", message)
  }
}

private extension Data {
  func readUInt32(at offset: Int) -> UInt32 {
    let i = startIndex + offset
    return UInt32(self[i]) << 24 | UInt32(self[i + 1]) << 16 | UInt32(self[i + 2]) << 8 | UInt32(self[i + 3])
  }

  mutating func appendUInt32(_ value: UInt32) {
    append(contentsOf: [UInt8(value >> 24), UInt8((value >> 16) & 0xff), UInt8((value >> 8) & 0xff), UInt8(value & 0xff)])
  }
}
#endif
