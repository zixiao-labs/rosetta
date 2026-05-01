import {
  EXTENSION_ACTIVATE,
  EXTENSION_DEACTIVATE,
  HOST_INITIALIZE,
  HOST_READY,
  HOST_SHUTDOWN,
  MARKETPLACE_DOWNLOAD,
  MARKETPLACE_GET,
  MARKETPLACE_SEARCH,
  MARKETPLACE_SOURCES,
  VSCODE_BRIDGE,
  VSCODE_EXTENSION_CALL,
  WEBVIEW_RPC,
  type ExtensionActivateParams,
  type Frame,
  type HostInitializeParams,
  type RequestFrame,
} from "../protocol.js";
import { ExtensionRegistry } from "./extensionRegistry.js";
import { VsCodeBridge } from "./vscodeBridge.js";
import { WebviewBridge } from "../webview/bridge.js";
import { MarketplaceManager, type MarketplaceConfig } from "../marketplace/index.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";

export type DispatcherOptions = {
  send(frame: Frame): void;
};

export class Dispatcher {
  private readonly send: (frame: Frame) => void;
  private bridge: VsCodeBridge | null = null;
  private webview: WebviewBridge | null = null;
  private registry: ExtensionRegistry | null = null;
  private marketplace: MarketplaceManager | null = null;
  private userDataDir: string | null = null;
  private initialized = false;

  constructor(opts: DispatcherOptions) {
    this.send = opts.send;
  }

  async handle(frame: Frame): Promise<void> {
    if (frame.type !== "request") {
      // Notifications/responses are routed inside the bridge if it's up.
      this.bridge?.routeIncoming(frame);
      return;
    }

    try {
      const result = await this.dispatch(frame);
      this.send({ type: "response", id: frame.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({
        type: "response",
        id: frame.id,
        error: { code: -32000, message },
      });
    }
  }

  private async dispatch(req: RequestFrame): Promise<unknown> {
    switch (req.method) {
      case HOST_INITIALIZE:
        return this.initialize(req.params as HostInitializeParams);
      case HOST_SHUTDOWN:
        await this.shutdown();
        return { ok: true };
      case EXTENSION_ACTIVATE:
        return this.activate(req.params as ExtensionActivateParams);
      case EXTENSION_DEACTIVATE: {
        const { extensionId } = req.params as { extensionId: string };
        await this.registry?.deactivate(extensionId);
        return { ok: true };
      }
      case VSCODE_BRIDGE: {
        if (!this.bridge) throw new Error("host not initialized");
        return this.bridge.invoke(req.params);
      }
      case VSCODE_EXTENSION_CALL: {
        if (!this.bridge) throw new Error("host not initialized");
        return this.bridge.handleExtensionCall(req.params);
      }
      case WEBVIEW_RPC: {
        if (!this.webview) throw new Error("host not initialized");
        return this.webview.invoke(req.params);
      }
      case MARKETPLACE_SOURCES: {
        if (!this.marketplace) throw new Error("host not initialized");
        return { sources: this.marketplace.enabledSources() };
      }
      case MARKETPLACE_SEARCH: {
        if (!this.marketplace) throw new Error("host not initialized");
        return this.marketplaceSearch(req.params);
      }
      case MARKETPLACE_GET: {
        if (!this.marketplace) throw new Error("host not initialized");
        return this.marketplaceGet(req.params);
      }
      case MARKETPLACE_DOWNLOAD: {
        if (!this.marketplace) throw new Error("host not initialized");
        return this.marketplaceDownload(req.params);
      }
      default:
        throw new Error(`Unknown method: ${req.method}`);
    }
  }

  private async initialize(params: HostInitializeParams) {
    if (this.initialized) {
      throw new Error("Rosetta host already initialized");
    }
    this.bridge = new VsCodeBridge({
      vendorRoot: params.vendorRoot,
      enableLanguageServices: params.enableLanguageServices,
      send: (frame) => this.send(frame),
    });
    this.webview = new WebviewBridge({
      send: (frame) => this.send(frame),
    });
    this.registry = new ExtensionRegistry({
      bridge: this.bridge,
      webview: this.webview,
    });
    this.marketplace = new MarketplaceManager(toMarketplaceConfig(params.marketplace));
    this.userDataDir = params.userDataDir;
    await this.bridge.start(params);
    this.initialized = true;
    this.send({
      type: "notification",
      method: HOST_READY,
      params: {
        protocolVersion: "1.0",
        marketplaceSources: this.marketplace.enabledSources(),
      },
    });
    return { protocolVersion: "1.0" };
  }

  private async activate(params: ExtensionActivateParams) {
    if (!this.registry) throw new Error("host not initialized");
    return this.registry.activate(params);
  }

  async shutdown(): Promise<void> {
    await this.registry?.shutdown();
    await this.bridge?.shutdown();
    this.bridge = null;
    this.registry = null;
    this.webview = null;
    this.marketplace = null;
    this.userDataDir = null;
    this.initialized = false;
  }

  private async marketplaceSearch(rawParams: unknown): Promise<unknown> {
    const params = (rawParams ?? {}) as Parameters<MarketplaceManager["search"]>[0];
    const result = await this.marketplace!.search(params);
    return stripVsixBytes(result);
  }

  private async marketplaceGet(rawParams: unknown): Promise<unknown> {
    const params = (rawParams ?? {}) as Parameters<MarketplaceManager["get"]>[0];
    return this.marketplace!.get(params);
  }

  private async marketplaceDownload(rawParams: unknown): Promise<unknown> {
    const params = (rawParams ?? {}) as Parameters<MarketplaceManager["download"]>[0];
    const blob = await this.marketplace!.download(params);
    // Stash the VSIX in <userDataDir>/rosetta-cache/marketplace and hand
    // the path back. We never marshal megabytes of binary through the
    // 4-byte-prefixed JSON channel — that's not what it's for.
    const dir = path.join(
      this.userDataDir ?? os.tmpdir(),
      "rosetta-cache",
      "marketplace",
    );
    await fs.mkdir(dir, { recursive: true });
    const safeId = blob.extensionId.replace(/[^A-Za-z0-9._-]/g, "_");
    const file = path.join(dir, `${safeId}-${blob.version}.vsix`);
    // The VSIX cache is shared across concurrent download() calls (the
    // workbench may install the same extension on multiple windows at
    // once). Writing directly to `file` would race: a reader could
    // observe a partial write, or two writers could interleave bytes.
    // Stage the bytes in a unique temp file in the same directory and
    // rename atomically. If a previous run already produced a verified
    // copy at the final path, reuse it instead of overwriting.
    let needsWrite = true;
    try {
      const existing = await fs.stat(file);
      if (existing.size === blob.bytes) {
        const onDisk = await fs.readFile(file);
        const onDiskHash = createHash("sha256").update(onDisk).digest("hex");
        if (onDiskHash === blob.sha256) {
          needsWrite = false;
        }
      }
    } catch {
      // ENOENT or other read error — fall through and write fresh.
    }
    if (needsWrite) {
      const tmpFile = `${file}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
      try {
        await fs.writeFile(tmpFile, blob.vsix);
        await fs.rename(tmpFile, file);
      } catch (err) {
        await fs.unlink(tmpFile).catch(() => {});
        throw err;
      }
    }
    return {
      source: blob.source,
      extensionId: blob.extensionId,
      version: blob.version,
      bytes: blob.bytes,
      sha256: blob.sha256,
      vsixPath: file,
    };
  }
}

function toMarketplaceConfig(
  raw: HostInitializeParams["marketplace"],
): MarketplaceConfig {
  if (!raw) return {};
  const cfg: MarketplaceConfig = {};
  if (raw.openvsx === false) cfg.openvsx = false;
  else if (raw.openvsx) {
    cfg.openvsx = raw.openvsx.baseUrl ? { baseUrl: raw.openvsx.baseUrl } : {};
  }
  if (raw.vsMarketplace === false) cfg.vsMarketplace = false;
  else if (raw.vsMarketplace) {
    cfg.vsMarketplace = {
      ...(raw.vsMarketplace.baseUrl ? { baseUrl: raw.vsMarketplace.baseUrl } : {}),
      ...(raw.vsMarketplace.fetchManifests !== undefined
        ? { fetchManifests: raw.vsMarketplace.fetchManifests }
        : {}),
    };
  }
  if (raw.defaultSource) cfg.defaultSource = raw.defaultSource;
  return cfg;
}

/**
 * Drop the `vsix` (Uint8Array) field from any download blob accidentally
 * embedded in a search response, just in case a future code path includes
 * it. Search results never carry bytes today; this is defense in depth.
 *
 * The function returns a deep copy that omits any property whose value is
 * a typed-array view or raw `ArrayBuffer`. The legitimate `assets.vsix`
 * URL is a string and is preserved. Non-plain objects (Date, Map, etc.)
 * are kept by reference because the marketplace pipeline only produces
 * JSON-shaped results — walking past those would risk mangling shapes the
 * caller still expects to receive.
 */
function stripVsixBytes<T>(value: T): T {
  return scrubBytes(value) as T;
}

function isBytes(value: unknown): boolean {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

function scrubBytes(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isBytes(value)) return undefined;
  if (Array.isArray(value)) {
    return value.filter((v) => !isBytes(v)).map(scrubBytes);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isBytes(v)) continue;
    out[k] = scrubBytes(v);
  }
  return out;
}
