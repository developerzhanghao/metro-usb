// Wire format shared with the phone side (ios/MetroUsb.swift):
// [payload length: u32 BE][type: u8][stream: u32 BE][payload]

export const FrameType = { hello: 1, open: 2, data: 3, close: 4 };
export const CONTROL_PORT = 27753;

export function encodeFrame(type, stream, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(9);
  header.writeUInt32BE(payload.length, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32BE(stream, 5);
  return Buffer.concat([header, payload]);
}

/** Feeds bytes in, calls `onFrame(type, stream, payload)` for each complete frame. */
export function frameReader(onFrame) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 9) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 9 + length) return;
      onFrame(buffer.readUInt8(4), buffer.readUInt32BE(5), buffer.subarray(9, 9 + length));
      buffer = buffer.subarray(9 + length);
    }
  };
}
