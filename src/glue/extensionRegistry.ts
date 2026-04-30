import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionActivateParams } from "../protocol.js";
import type { VsCodeBridge } from "./vscodeBridge.js";
import type { WebviewBridge } from "../webview/bridge.js";
import { createVscodeShim } from "../shims/vscode.js";

type ActiveRecord = {
  id: string;
  module: { activate?: (ctx: unknown) => unknown; deactivate?: () => unknown };
  context: ExtensionContext;
};

type ExtensionContext = {
  extensionPath: string;
  extensionUri: { fsPath: string };
  subscriptions: Array<{ dispose(): unknown }>;
  globalState: KeyValue;
  workspaceState: KeyValue;
};

class KeyValue {
  private map = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.map.get(key) as T) ?? defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  keys(): readonly string[] {
    return [...this.map.keys()];
  }
}

export type ExtensionRegistryOptions = {
  bridge: VsCodeBridge;
  webview: WebviewBridge;
};

export class ExtensionRegistry {
  private readonly bridge: VsCodeBridge;
  private readonly webview: WebviewBridge;
  private readonly active = new Map<string, ActiveRecord>();

  constructor(opts: ExtensionRegistryOptions) {
    this.bridge = opts.bridge;
    this.webview = opts.webview;
  }

  async activate(params: ExtensionActivateParams): Promise<{ ok: true }> {
    if (this.active.has(params.extensionId)) {
      return { ok: true };
    }
    const main = params.manifest.main ?? "extension.js";
    const entry = path.resolve(params.extensionRoot, main);
    const url = pathToFileURL(entry).href;

    const shim = createVscodeShim({
      bridge: this.bridge,
      webview: this.webview,
      extensionId: params.extensionId,
    });

    // Inject the shim before importing the extension. We do not patch the
    // global module loader here; the bundler-friendly approach is for Logos
    // to write a tiny preamble that re-exports the shim under "vscode" via
    // an import map at install time. For now we expose it on globalThis so
    // a minimal hand-rolled extension can pick it up via
    //   const vscode = globalThis.__logos_vscode__;
    (globalThis as unknown as { __logos_vscode__?: unknown }).__logos_vscode__ = shim;

    const mod = (await import(url)) as ActiveRecord["module"];
    const context: ExtensionContext = {
      extensionPath: params.extensionRoot,
      extensionUri: { fsPath: params.extensionRoot },
      subscriptions: [],
      globalState: new KeyValue(),
      workspaceState: new KeyValue(),
    };
    if (typeof mod.activate === "function") {
      await mod.activate(context);
    }
    this.active.set(params.extensionId, { id: params.extensionId, module: mod, context });
    return { ok: true };
  }

  async deactivate(extensionId: string): Promise<void> {
    const record = this.active.get(extensionId);
    if (!record) return;
    try {
      if (typeof record.module.deactivate === "function") {
        await record.module.deactivate();
      }
      for (const sub of record.context.subscriptions) {
        try {
          sub.dispose();
        } catch {
          /* ignore disposal errors */
        }
      }
    } finally {
      this.active.delete(extensionId);
    }
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.active.keys()]) {
      await this.deactivate(id);
    }
  }
}
