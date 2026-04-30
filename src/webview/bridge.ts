import type { Frame } from "../protocol.js";

export type WebviewBridgeOptions = {
  send(frame: Frame): void;
};

/**
 * Webview RPC seam.
 *
 * VS Code webviews live in an isolated BrowserWindow on the workbench side.
 * Rosetta does not own the browser context — it only forwards
 * `webview/rpc` frames between the extension and the host, which then
 * forwards them to the actual webview. This class is the host-side
 * proxy that the vscode shim's `createWebviewPanel` calls into.
 */
export class WebviewBridge {
  private readonly send: (frame: Frame) => void;
  private nextHandle = 1;
  private readonly handles = new Map<number, WebviewHandle>();

  constructor(opts: WebviewBridgeOptions) {
    this.send = opts.send;
  }

  createPanel(opts: { viewType: string; title: string; html: string }): WebviewHandle {
    const handle = this.nextHandle++;
    const record: WebviewHandle = {
      handle,
      viewType: opts.viewType,
      title: opts.title,
      html: opts.html,
      messageListeners: [],
    };
    this.handles.set(handle, record);
    this.send({
      type: "notification",
      method: "webview/create",
      params: { handle, viewType: opts.viewType, title: opts.title, html: opts.html },
    });
    return record;
  }

  postMessage(handle: number, message: unknown): void {
    if (!this.handles.has(handle)) return;
    this.send({
      type: "notification",
      method: "webview/post-message",
      params: { handle, message },
    });
  }

  invoke(params: unknown): unknown {
    const { verb, handle, payload } = (params ?? {}) as {
      verb: string;
      handle: number;
      payload?: unknown;
    };
    const record = this.handles.get(handle);
    if (!record) return { ok: false, reason: "no such webview" };
    switch (verb) {
      case "deliver-message":
        for (const fn of record.messageListeners) {
          try {
            fn(payload);
          } catch {
            /* ignore listener errors */
          }
        }
        return { ok: true };
      case "dispose":
        this.handles.delete(handle);
        return { ok: true };
      default:
        return { ok: false, reason: `unknown webview verb: ${verb}` };
    }
  }
}

export type WebviewHandle = {
  handle: number;
  viewType: string;
  title: string;
  html: string;
  messageListeners: Array<(message: unknown) => void>;
};
