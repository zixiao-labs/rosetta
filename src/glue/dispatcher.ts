import {
  EXTENSION_ACTIVATE,
  EXTENSION_DEACTIVATE,
  HOST_INITIALIZE,
  HOST_READY,
  HOST_SHUTDOWN,
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

export type DispatcherOptions = {
  send(frame: Frame): void;
};

export class Dispatcher {
  private readonly send: (frame: Frame) => void;
  private bridge: VsCodeBridge | null = null;
  private webview: WebviewBridge | null = null;
  private registry: ExtensionRegistry | null = null;
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
    await this.bridge.start(params);
    this.initialized = true;
    this.send({
      type: "notification",
      method: HOST_READY,
      params: { protocolVersion: "1.0" },
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
    this.initialized = false;
  }
}
