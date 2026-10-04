import net from 'node:net';
import plist from 'plist';

// Minimal client for usbmuxd, the daemon (built into macOS; `usbmuxd` on Linux) that Xcode and iTunes use to
// talk to cabled iOS devices. It can only connect from this computer *into* a port on the device.

const SOCKET_PATH = '/var/run/usbmuxd';
const PROG = 'metro-usb';

function encode(message, tag) {
  const body = Buffer.from(plist.build({ ClientVersionString: PROG, ProgName: PROG, ...message }));
  const header = Buffer.alloc(16);
  header.writeUInt32LE(16 + body.length, 0); // total length
  header.writeUInt32LE(1, 4); // version 1 = plist protocol
  header.writeUInt32LE(8, 8); // message type 8 = plist
  header.writeUInt32LE(tag, 12);
  return Buffer.concat([header, body]);
}

/** Reads usbmuxd plist messages off a socket until `onMessage` returns true, then hands back any leftover bytes. */
function readMessages(socket, onMessage) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 16) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length) return;
        const message = plist.parse(buffer.subarray(16, length).toString('utf8'));
        buffer = buffer.subarray(length);
        if (onMessage(message)) {
          socket.off('data', onData);
          socket.off('error', reject);
          resolve(buffer);
          return;
        }
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

function open() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET_PATH, () => resolve(socket));
    socket.once('error', (error) => reject(new Error(`can't reach usbmuxd at ${SOCKET_PATH}: ${error.message}`)));
  });
}

/** Calls `onAttach(device)` / `onDetach(deviceId)` as USB-connected iOS devices come and go. */
export async function watchDevices({ onAttach, onDetach }) {
  const socket = await open();
  socket.write(encode({ MessageType: 'Listen' }, 1));
  readMessages(socket, (message) => {
    if (message.MessageType === 'Attached' && message.Properties?.ConnectionType === 'USB') {
      onAttach({ id: message.DeviceID, serial: message.Properties.SerialNumber });
    } else if (message.MessageType === 'Detached') {
      onDetach(message.DeviceID);
    }
    return false;
  });
  return () => socket.destroy();
}

/** A raw TCP connection to `port` on the device, tunnelled through the cable. */
export async function connectToDevice(deviceId, port) {
  const socket = await open();
  // usbmuxd wants the port in network byte order, packed into an integer.
  const swapped = ((port & 0xff) << 8) | ((port >> 8) & 0xff);
  socket.write(encode({ MessageType: 'Connect', DeviceID: deviceId, PortNumber: swapped }, 2));
  let result;
  const leftover = await readMessages(socket, (message) => {
    result = message;
    return true;
  });
  if (result.MessageType !== 'Result' || result.Number !== 0) {
    socket.destroy();
    // 3 = connection refused: nothing listening yet (app not running, or a release build).
    throw Object.assign(new Error(`usbmuxd refused the connection (code ${result.Number})`), { code: result.Number });
  }
  if (leftover.length) socket.unshift(leftover);
  return socket;
}
