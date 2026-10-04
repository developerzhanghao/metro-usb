import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';

import { encodeFrame, FrameType, frameReader } from './frames.js';
import { runRelay } from './relay.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * A stand-in for the phone side (ios/MetroUsb.swift): accepts app connections on a local port and carries them as
 * frames over the control socket, the same way the Swift code does.
 */
function fakePhone(control, devicePort) {
  const streams = new Map();
  let next = 1;
  control.on('data', frameReader((type, id, payload) => {
    if (type === FrameType.data) streams.get(id)?.write(payload);
    if (type === FrameType.close) streams.get(id)?.end();
  }));
  const appSide = net.createServer((socket) => {
    const id = next++;
    streams.set(id, socket);
    const port = Buffer.alloc(2);
    port.writeUInt16BE(devicePort);
    control.write(encodeFrame(FrameType.open, id, port));
    socket.on('data', (chunk) => control.write(encodeFrame(FrameType.data, id, chunk)));
    socket.on('end', () => control.write(encodeFrame(FrameType.close, id)));
  });
  return appSide;
}

test('frames survive being split and merged across reads', () => {
  const frames = [];
  const read = frameReader((type, stream, payload) => frames.push([type, stream, payload.toString()]));
  const bytes = Buffer.concat([encodeFrame(FrameType.data, 7, Buffer.from('hello')), encodeFrame(FrameType.close, 7)]);
  for (const byte of bytes) read(Buffer.from([byte]));
  assert.deepEqual(frames, [[FrameType.data, 7, 'hello'], [FrameType.close, 7, '']]);
});

test('an HTTP request from the app reaches the host server through the relay', async () => {
  const body = 'x'.repeat(2_000_000); // about the size of a dev JS bundle
  const metro = http.createServer((req, res) => res.end(req.url === '/index.bundle' ? body : 'nope'));
  const hostPort = await listen(metro);

  // The control connection: one end plays the phone, the other is handed to the relay as if it came over USB.
  const pair = net.createServer();
  const pairPort = await listen(pair);
  const phoneEnd = new Promise((resolve) => pair.once('connection', resolve));
  const macEnd = net.connect(pairPort, '127.0.0.1');
  const phoneControl = await phoneEnd;

  let hello;
  phoneControl.once('data', frameReader((type, _, payload) => { if (type === FrameType.hello) hello = JSON.parse(payload); }));
  const done = runRelay(macEnd, new Map([[8081, hostPort]]));

  const app = fakePhone(phoneControl, 8081);
  const appPort = await listen(app);
  const received = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: appPort, path: '/index.bundle' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve(text));
    }).on('error', reject);
  });

  assert.deepEqual(hello.ports, [8081]);
  assert.equal(typeof hello.host, 'string');
  assert.equal(received.length, body.length);

  phoneControl.destroy();
  await done;
  app.close();
  metro.close();
  pair.close();
});

test('a stream for a port that was not forwarded is closed, not connected', async () => {
  const pair = net.createServer();
  const pairPort = await listen(pair);
  const phoneEnd = new Promise((resolve) => pair.once('connection', resolve));
  const macEnd = net.connect(pairPort, '127.0.0.1');
  const phoneControl = await phoneEnd;

  const frames = [];
  phoneControl.on('data', frameReader((type, id) => frames.push([type, id])));
  const done = runRelay(macEnd, new Map([[8081, 1]]));
  const port = Buffer.alloc(2);
  port.writeUInt16BE(9999);
  phoneControl.write(encodeFrame(FrameType.open, 5, port));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(frames.slice(1), [[FrameType.close, 5]]);
  phoneControl.destroy();
  await done;
  pair.close();
});
