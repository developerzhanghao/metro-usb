#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { CONTROL_PORT } from './frames.js';
import { runRelay } from './relay.js';
import { connectToDevice, watchDevices } from './usbmux.js';

const HELP = `metro-usb: let a debug app on a cabled iPhone reach dev servers on this Mac, no Wi-Fi needed.

Usage: npx metro-usb [--port <device>[:<host>]]... [--verbose] [--no-start] [--direct] [-- <command>...]

Run it in your app's folder. If Metro isn't running yet, it starts it for you (\`expo start\`, or
\`react-native start\` without Expo) in this terminal; Ctrl+C stops both.

  --no-start          only relay; don't start Metro
  -- <command>        start this instead, e.g. \`npx metro-usb -- npx expo start --clear\`

  --port 8081         forward the phone's localhost:8081 to this Mac's localhost:8081 (default)
  --port 8787         repeat to forward more (e.g. a local API)
  --verbose, -v       log every connection the app makes and how many bytes went each way
  --direct            connect to the relay on this Mac's own loopback instead of over USB, for testing it in the
                      iOS Simulator (launched with METRO_USB_SIMULATOR=1). There --port 18081:8081 maps ports,
                      but only requests to 18081 go through the relay: Metro's manifest points the bundle and
                      hot reload at its own port, which the Simulator reaches directly.

In the app, open http://localhost:8081.`;

// Everything after "--" is a command to run alongside the relay (usually Metro).
const separator = process.argv.indexOf('--', 2);
const ownArgs = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
const command = separator === -1 ? [] : process.argv.slice(separator + 1);

const { values } = parseArgs({
  args: ownArgs,
  options: {
    port: { type: 'string', multiple: true },
    direct: { type: 'boolean', default: false },
    'no-start': { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const ports = new Map();
for (const spec of values.port ?? ['8081']) {
  const [device, host = device] = spec.split(':').map(Number);
  if (!Number.isInteger(device) || !Number.isInteger(host) || device === CONTROL_PORT) {
    console.error(`bad --port ${spec}`);
    process.exit(1);
  }
  // Metro writes its own port into the manifest (bundle and hot-reload URLs), so on a phone the relay must listen
  // on that same port. Mapping is only meaningful for --direct testing.
  if (device !== host && !values.direct) {
    console.error(`--port ${spec}: on a phone the port must be the same on both sides (Metro's manifest uses its own port). Use --port ${host}.`);
    process.exit(1);
  }
  ports.set(device, host);
}
const mapping = [...ports].map(([device, host]) => (device === host ? `${device}` : `${device}→${host}`)).join(', ');
const log = (message) => console.log(`[metro-usb] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function metroIsRunning(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/status', timeout: 2000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body.includes('packager-status:running')));
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

/**
 * When we start Metro ourselves, the phone is only connected once Metro answers: the phone checks Metro the moment
 * it connects (to open it automatically) and would otherwise find nothing there yet.
 */
async function waitForMetro(port) {
  log(`waiting for the dev server on localhost:${port}…`);
  while (!(await metroIsRunning(port))) await sleep(500);
  log('dev server is up');
}

function runCommand([program, ...args]) {
  const child = spawn(program, args, { stdio: 'inherit' });
  child.on('error', (error) => {
    console.error(`[metro-usb] couldn't start ${program}: ${error.message}`);
    process.exit(1);
  });
  // Stop together: Ctrl+C reaches both (same terminal), so wait for the command to finish rather than dying first.
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

/** The project's own Metro launcher: Expo if installed, else the React Native CLI. */
function defaultCommand() {
  for (const [bin, args] of [['expo', ['start']], ['react-native', ['start']]]) {
    const file = path.join(process.cwd(), 'node_modules', '.bin', bin);
    if (fs.existsSync(file)) return [file, ...args];
  }
  return null;
}

async function startMetroIfNeeded() {
  const metroPort = [...ports.values()][0];
  if (command.length > 0) {
    runCommand(command);
  } else if (values['no-start'] || (await metroIsRunning(metroPort))) {
    return;
  } else {
    const fallback = defaultCommand();
    if (!fallback) {
      log(`Metro isn't running and no expo / react-native was found here; start it yourself on port ${metroPort}`);
      return;
    }
    log(`starting Metro: ${path.basename(fallback[0])} ${fallback.slice(1).join(' ')}`);
    runCommand(fallback);
  }
  await waitForMetro(metroPort);
}

const metroReady = startMetroIfNeeded();

/** Keeps a control connection to one phone alive: retries while the app isn't running, reconnects after it closes. */
async function serve(name, connect, isAttached) {
  await metroReady;
  let waiting = false;
  while (isAttached()) {
    let control;
    try {
      control = await connect();
    } catch {
      if (!waiting) log(`${name}: waiting for the app (open the debug build)…`);
      waiting = true;
      await sleep(1000);
      continue;
    }
    waiting = false;
    log(`${name}: connected, forwarding ${mapping}. In the app use http://localhost:${[...ports.keys()][0]}`);
    await runRelay(control, ports, log, values.verbose);
    log(`${name}: disconnected`);
    await sleep(500);
  }
}

if (values.direct) {
  log(`direct mode: connecting to localhost:${CONTROL_PORT}`);
  serve('simulator', () => new Promise((resolve, reject) => {
    const socket = net.connect(CONTROL_PORT, '127.0.0.1', () => resolve(socket));
    socket.once('error', reject);
  }), () => true);
} else {
  const attached = new Map();
  log('waiting for an iPhone on USB…');
  await watchDevices({
    onAttach: (device) => {
      if (attached.has(device.id)) return;
      attached.set(device.id, device);
      const name = `iPhone ${device.serial.slice(-6)}`;
      log(`${name}: plugged in`);
      void serve(name, () => connectToDevice(device.id, CONTROL_PORT), () => attached.has(device.id))
        .then(() => log(`${name}: unplugged`));
    },
    onDetach: (id) => attached.delete(id),
  }).catch((error) => {
    console.error(`[metro-usb] ${error.message}`);
    process.exit(1);
  });
}
