import path from "node:path";
import fs from "node:fs";
import type { Frame, HostInitializeParams } from "../protocol.js";

export type VsCodeBridgeOptions = {
  vendorRoot: string;
  enableLanguageServices: boolean;
  send(frame: Frame): void;
};

/**
 * Bridge between Rosetta's protocol surface and the vendored VS Code
 * extension host. Today the vendored vscode tree is loaded lazily from
 * `<vendorRoot>/vscode/src/vs/workbench/api/node/extensionHostProcess.js`
 * once VS Code's amd build has been produced (by the Rosetta build script).
 *
 * The bridge intentionally exposes a tiny seam: `invoke()` for synchronous
 * RPC calls from the Logos workbench, `routeIncoming()` for non-request
 * frames the host receives, and `start()/shutdown()` for lifecycle.
 */
export class VsCodeBridge {
  private readonly vendorRoot: string;
  private readonly send: (frame: Frame) => void;
  private readonly enableLanguageServices: boolean;
  private nextId = 1000;
  private nextCallbackId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
  private readonly callbacks = new Map<string, (args: unknown[]) => unknown | Promise<unknown>>();
  private extHostHandle: unknown = null;

  constructor(opts: VsCodeBridgeOptions) {
    this.vendorRoot = opts.vendorRoot;
    this.send = opts.send;
    this.enableLanguageServices = opts.enableLanguageServices;
  }

  async start(params: HostInitializeParams): Promise<void> {
    const candidate = path.resolve(
      this.vendorRoot,
      "vscode/out/vs/workbench/api/node/extensionHostProcess.js",
    );
    if (!fs.existsSync(candidate)) {
      // The vendored tree has not been built. We still come up so the host
      // can serve `host/initialize` and trivial `vscode/bridge` calls; the
      // rich API surface stays disabled until a build is produced.
      this.extHostHandle = { kind: "stub", reason: "vscode/out missing" };
      return;
    }
    // The full bring-up calls vscode's IExtensionHostManager equivalent here;
    // for the scaffold we just record that the binary exists and let the
    // vscode shim functions below answer the easy cases (commands registry,
    // output channel, in-memory KV) without paying for the full extHost
    // boot. A future change loads `extensionHostProcess.js` via createRequire
    // and wires it to this.send / pending map.
    this.extHostHandle = {
      kind: "ready",
      candidate,
      workspace: params.workspace,
      languageServicesEnabled: this.enableLanguageServices,
    };
  }

  async invoke(params: unknown): Promise<unknown> {
    const { method, args } = (params ?? {}) as { method: string; args?: unknown[] };
    if (!method) throw new Error("vscode/bridge requires a method name");

    // Round-trip the call through the host workbench. The Logos side runs
    // `vscode/bridge` requests against its own implementation and answers
    // with a `vscode/bridge:result` notification keyed by the synthesized id
    // we generate here. For pure-host operations (registries that live in
    // Rosetta itself) the shim resolves locally and never reaches here.
    return this.callHost(method, args ?? []);
  }

  routeIncoming(frame: Frame): void {
    if (frame.type === "response" && this.pending.has(frame.id)) {
      const slot = this.pending.get(frame.id)!;
      this.pending.delete(frame.id);
      if (frame.error) {
        slot.reject(new Error(frame.error.message));
      } else {
        slot.resolve(frame.result);
      }
    }
  }

  async callHost(method: string, args: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({
        type: "request",
        id,
        method: "vscode/host-call",
        params: { method, args },
      });
    });
  }

  /**
   * Register a callback that the host can invoke via `vscode/extension-call`.
   * Returns the opaque callback id that should be handed to the host (e.g., as
   * the `providerId` field of a registration call) and a disposer.
   */
  registerCallback(
    prefix: string,
    fn: (args: unknown[]) => unknown | Promise<unknown>,
  ): { id: string; dispose(): void } {
    const id = `${prefix}.${this.nextCallbackId++}`;
    this.callbacks.set(id, fn);
    return {
      id,
      dispose: () => {
        this.callbacks.delete(id);
      },
    };
  }

  async handleExtensionCall(params: unknown): Promise<unknown> {
    const { callbackId, args } = (params ?? {}) as { callbackId: string; args?: unknown[] };
    const fn = this.callbacks.get(callbackId);
    if (!fn) throw new Error(`unknown extension callback: ${callbackId}`);
    return fn(args ?? []);
  }

  isReady(): boolean {
    return (this.extHostHandle as { kind?: string } | null)?.kind === "ready";
  }

  async shutdown(): Promise<void> {
    this.extHostHandle = null;
    for (const slot of this.pending.values()) {
      slot.reject(new Error("Rosetta host shutting down"));
    }
    this.pending.clear();
    this.callbacks.clear();
  }
}
