import type { Frame } from "../protocol.js";

export function encodeFrame(frame: Frame): Buffer {
  const json = JSON.stringify(frame);
  const len = Buffer.byteLength(json, "utf8");
  const out = Buffer.alloc(4 + len);
  out.writeUInt32BE(len, 0);
  out.write(json, 4, "utf8");
  return out;
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  *drain(): Generator<Frame> {
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) return;
      const slice = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      try {
        yield JSON.parse(slice.toString("utf8")) as Frame;
      } catch {
        // Drop malformed frame; keep the host alive.
      }
    }
  }
}
