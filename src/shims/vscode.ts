/**
 * Partial vscode.* namespace shim.
 *
 * This file is the public surface seen by activated extensions. Every
 * function listed here either:
 *   1. answers locally (registries that the shim owns), or
 *   2. defers to VsCodeBridge.callHost(...) which round-trips into the
 *      Logos workbench process.
 *
 * It is deliberately incomplete. Each `// TODO(rosetta-api):` marker is a
 * pointer to where the next chunk of vscode API surface plugs in. Adding
 * a method is mechanical:
 *
 *   1. Pick the namespace section below.
 *   2. Add the method, returning either local state or
 *      `bridge.callHost("namespace.method", [...])`.
 *   3. Implement the matching `vscode/host-call` handler in the Logos
 *      workbench (see `src/electron/ipc/rosetta.ts`).
 */

import type { VsCodeBridge } from "../glue/vscodeBridge.js";
import type { WebviewBridge, WebviewHandle } from "../webview/bridge.js";

export type ShimOptions = {
  bridge: VsCodeBridge;
  webview: WebviewBridge;
  extensionId: string;
};

type Disposable = { dispose(): void };

export function createVscodeShim(opts: ShimOptions) {
  const { bridge, webview } = opts;

  const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();

  const commands = {
    registerCommand(id: string, callback: (...args: unknown[]) => unknown): Disposable {
      commandRegistry.set(id, callback);
      bridge.callHost("commands.register", [id]).catch(() => undefined);
      return {
        dispose() {
          commandRegistry.delete(id);
          bridge.callHost("commands.unregister", [id]).catch(() => undefined);
        },
      };
    },
    async executeCommand<T>(id: string, ...args: unknown[]): Promise<T | undefined> {
      const local = commandRegistry.get(id);
      if (local) return (local(...args) as T) ?? undefined;
      return (await bridge.callHost("commands.execute", [id, args])) as T | undefined;
    },
  };

  const window = {
    showInformationMessage(message: string): Promise<undefined> {
      return bridge.callHost("window.showInformationMessage", [message]) as Promise<undefined>;
    },
    showWarningMessage(message: string): Promise<undefined> {
      return bridge.callHost("window.showWarningMessage", [message]) as Promise<undefined>;
    },
    showErrorMessage(message: string): Promise<undefined> {
      return bridge.callHost("window.showErrorMessage", [message]) as Promise<undefined>;
    },
    createOutputChannel(name: string) {
      const channelId = `${opts.extensionId}::${name}`;
      bridge.callHost("window.createOutputChannel", [channelId, name]).catch(() => undefined);
      return {
        name,
        append(value: string) {
          bridge.callHost("window.outputChannel.append", [channelId, value]).catch(() => undefined);
        },
        appendLine(value: string) {
          bridge.callHost("window.outputChannel.appendLine", [channelId, value]).catch(() => undefined);
        },
        clear() {
          bridge.callHost("window.outputChannel.clear", [channelId]).catch(() => undefined);
        },
        show() {
          bridge.callHost("window.outputChannel.show", [channelId]).catch(() => undefined);
        },
        dispose() {
          bridge.callHost("window.outputChannel.dispose", [channelId]).catch(() => undefined);
        },
      };
    },
    createWebviewPanel(viewType: string, title: string, _column: unknown, _opts?: unknown) {
      const handle: WebviewHandle = webview.createPanel({ viewType, title, html: "" });
      return makeWebviewPanel(webview, handle);
    },
    // TODO(rosetta-api): showQuickPick, showInputBox, createTreeView, createStatusBarItem,
    // withProgress, registerWebviewViewProvider.
  };

  const workspace = {
    get workspaceFolders() {
      return undefined;
    },
    async openTextDocument(uri: string) {
      return bridge.callHost("workspace.openTextDocument", [uri]);
    },
    onDidChangeTextDocument: noopEvent,
    onDidOpenTextDocument: noopEvent,
    onDidCloseTextDocument: noopEvent,
    fs: {
      async readFile(uri: string) {
        return bridge.callHost("workspace.fs.readFile", [uri]);
      },
      async writeFile(uri: string, content: Uint8Array) {
        return bridge.callHost("workspace.fs.writeFile", [uri, Array.from(content)]);
      },
      async stat(uri: string) {
        return bridge.callHost("workspace.fs.stat", [uri]);
      },
    },
    // TODO(rosetta-api): findFiles, getConfiguration, registerTextDocumentContentProvider.
  };

  const languages = {
    registerHoverProvider(_selector: unknown, _provider: unknown): Disposable {
      // TODO(rosetta-api): forward registration to host so it can dispatch
      // language requests back to this extension via vscode/bridge.
      return { dispose() {} };
    },
    registerCompletionItemProvider(_selector: unknown, _provider: unknown): Disposable {
      return { dispose() {} };
    },
    registerDefinitionProvider(_selector: unknown, _provider: unknown): Disposable {
      return { dispose() {} };
    },
  };

  const debug = {
    // TODO(rosetta-api): registerDebugConfigurationProvider, startDebugging, etc.
    onDidStartDebugSession: noopEvent,
    onDidTerminateDebugSession: noopEvent,
  };

  const extensions = {
    getExtension(_id: string) {
      return undefined;
    },
    all: [] as readonly unknown[],
  };

  return {
    version: "1.106.0-rosetta",
    commands,
    window,
    workspace,
    languages,
    debug,
    extensions,
    Uri: {
      file(p: string) {
        return { fsPath: p, scheme: "file" };
      },
      parse(s: string) {
        return { fsPath: s, scheme: s.split(":")[0] ?? "file" };
      },
    },
    EventEmitter: class<T> {
      private listeners: Array<(value: T) => void> = [];
      readonly event = (listener: (value: T) => void): Disposable => {
        this.listeners.push(listener);
        return {
          dispose: () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
          },
        };
      };
      fire(value: T) {
        for (const l of this.listeners) {
          try {
            l(value);
          } catch {
            /* ignore */
          }
        }
      }
      dispose() {
        this.listeners = [];
      }
    },
    Disposable: class implements Disposable {
      constructor(private readonly fn: () => void) {}
      dispose() {
        this.fn();
      }
    },
  };
}

function noopEvent(): Disposable {
  return { dispose() {} };
}

function makeWebviewPanel(bridge: WebviewBridge, handle: WebviewHandle) {
  const messageListeners: Array<(msg: unknown) => void> = handle.messageListeners;
  let disposed = false;
  const onDidReceiveMessage = (listener: (msg: unknown) => void): Disposable => {
    messageListeners.push(listener);
    return {
      dispose() {
        const idx = messageListeners.indexOf(listener);
        if (idx >= 0) messageListeners.splice(idx, 1);
      },
    };
  };
  return {
    viewType: handle.viewType,
    title: handle.title,
    webview: {
      get html() {
        return handle.html;
      },
      set html(value: string) {
        handle.html = value;
        bridge.postMessage(handle.handle, { kind: "set-html", html: value });
      },
      postMessage(message: unknown) {
        if (disposed) return false;
        bridge.postMessage(handle.handle, { kind: "user", message });
        return true;
      },
      onDidReceiveMessage,
    },
    onDidDispose(listener: () => void): Disposable {
      const fired = () => listener();
      // The webview bridge dispatches "dispose" via invoke().
      // We mirror disposal locally.
      const wrapped = () => {
        if (disposed) return;
        disposed = true;
        fired();
      };
      messageListeners.push((msg) => {
        if ((msg as { kind?: string } | undefined)?.kind === "host-disposed") {
          wrapped();
        }
      });
      return {
        dispose() {
          /* listener stays alive until panel disposal */
        },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      bridge.postMessage(handle.handle, { kind: "extension-disposed" });
    },
  };
}
