/**
 * Rosetta host entry point.
 *
 * Logos spawns this script with stdin/stdout reserved for the framed JSON
 * protocol and stderr free for diagnostic output. The script wires:
 *
 *   stdin  → FrameDecoder → Dispatcher
 *   stdout ← FrameEncoder ← Dispatcher
 *
 * The Dispatcher hands `host/*` and `extension/*` calls to the Logos-side
 * lifecycle code and tunnels every `vscode/*` call through the glue layer
 * into the vendored VS Code extension host.
 */

import { Dispatcher } from "../glue/dispatcher.js";
import { FrameDecoder, encodeFrame } from "../glue/framing.js";
import type { Frame } from "../protocol.js";

const decoder = new FrameDecoder();
const dispatcher = new Dispatcher({
  send(frame: Frame) {
    const buf = encodeFrame(frame);
    process.stdout.write(buf);
  },
});

process.stdin.on("data", (chunk: Buffer) => {
  decoder.push(chunk);
  for (const frame of decoder.drain()) {
    dispatcher.handle(frame).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[rosetta] dispatch error: ${message}\n`);
    });
  }
});

process.stdin.on("end", () => {
  dispatcher.shutdown().finally(() => process.exit(0));
});

process.on("uncaughtException", (err) => {
  process.stderr.write(`[rosetta] uncaught: ${err.stack ?? err.message}\n`);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[rosetta] unhandled rejection: ${String(reason)}\n`);
});
