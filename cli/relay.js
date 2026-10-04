import net from 'node:net';
import os from 'node:os';

import { encodeFrame, FrameType, frameReader } from './frames.js';

/**
 * Serves one control connection to the phone until it closes. `ports` maps device ports to host ports;
 * every OPEN from the phone becomes a TCP connection to localhost:<host port>.
 */
export function runRelay(control, ports, log = () => {}, verbose = false) {
  return new Promise((resolve) => {
    const streams = new Map(); // stream id → { socket, pending: Buffer[] | null, up, down }

    const send = (type, stream, payload) => {
      if (!control.destroyed) control.write(encodeFrame(type, stream, payload));
    };
    const closeStream = (id, notify) => {
      const entry = streams.get(id);
      if (!entry) return;
      streams.delete(id);
      entry.socket.destroy();
      if (notify) send(FrameType.close, id);
      if (verbose) log(`#${id} closed by ${notify ? 'server' : 'app'}: app→server ${entry.up} B, server→app ${entry.down} B`);
    };

    const onFrame = (type, id, payload) => {
      if (type === FrameType.open) {
        const devicePort = payload.readUInt16BE(0);
        const hostPort = ports.get(devicePort);
        if (hostPort === undefined) {
          // Only forward what was asked for: an unmapped port could otherwise loop back into the relay.
          if (verbose) log(`#${id} refused: device port ${devicePort} is not forwarded`);
          send(FrameType.close, id);
          return;
        }
        if (verbose) log(`#${id} open: device :${devicePort} → localhost:${hostPort}`);
        const socket = net.connect(hostPort, '127.0.0.1');
        // Data can arrive from the phone before the local connection is up; hold it until then.
        const entry = { socket, pending: [], up: 0, down: 0 };
        streams.set(id, entry);
        socket.on('connect', () => {
          for (const chunk of entry.pending) socket.write(chunk);
          entry.pending = null;
        });
        socket.on('data', (chunk) => {
          entry.down += chunk.length;
          send(FrameType.data, id, chunk);
        });
        socket.on('close', () => closeStream(id, true));
        socket.on('error', (error) => {
          if (error.code === 'ECONNREFUSED') log(`nothing listening on localhost:${hostPort} (is the dev server running?)`);
        });
      } else if (type === FrameType.data) {
        const entry = streams.get(id);
        if (!entry) return;
        if (verbose && entry.up === 0) log(`#${id} request: ${payload.toString('latin1').split('\r\n')[0].slice(0, 120)}`);
        entry.up += payload.length;
        if (entry.pending) entry.pending.push(Buffer.from(payload));
        else entry.socket.write(payload);
      } else if (type === FrameType.close) {
        closeStream(id, false);
      }
    };

    control.on('data', frameReader(onFrame));
    control.on('close', () => {
      for (const id of [...streams.keys()]) closeStream(id, false);
      resolve();
    });
    control.on('error', () => {});
    // The host name labels the relayed Metro in the phone's dev launcher ("Metro over USB · <host>").
    const host = os.hostname().replace(/\.local$/, '');
    send(FrameType.hello, 0, Buffer.from(JSON.stringify({ ports: [...ports.keys()], host })));
  });
}
