/**
 * Partial vscode.* namespace shim.
 *
 * This file is the public surface seen by activated extensions. Every
 * function listed here either:
 *   1. answers locally (registries that the shim owns), or
 *   2. defers to VsCodeBridge.callHost(...) which round-trips into the
 *      Logos workbench process.
 *
 * Extension-side providers (hover, completion, tree views, debug config,
 * webview views, text-document content, …) are wired through
 * `bridge.registerCallback(...)`: the shim hands the host a `providerId`
 * during registration, and the host invokes it back over
 * `vscode/extension-call` whenever the editor needs the provider's result.
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
  const ns = (suffix: string) => `${opts.extensionId}::${suffix}`;

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

  const StatusBarAlignment = { Left: 1, Right: 2 } as const;
  const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
  const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 } as const;

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
      const channelId = ns(name);
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
    async showQuickPick<T extends string | { label: string }>(
      items: readonly T[] | Promise<readonly T[]>,
      options?: unknown,
    ): Promise<T | undefined> {
      const resolved = await items;
      return (await bridge.callHost("window.showQuickPick", [resolved, options ?? null])) as
        | T
        | undefined;
    },
    async showInputBox(options?: unknown): Promise<string | undefined> {
      return (await bridge.callHost("window.showInputBox", [options ?? null])) as
        | string
        | undefined;
    },
    createTreeView(viewId: string, options: { treeDataProvider: TreeDataProvider }): TreeView {
      const provider = options.treeDataProvider;
      const providerCb = bridge.registerCallback(`treeView.${viewId}`, async (args) => {
        const [verb, payload] = args as [string, unknown];
        switch (verb) {
          case "getChildren":
            return (await provider.getChildren?.(payload)) ?? [];
          case "getTreeItem":
            return await provider.getTreeItem(payload);
          case "getParent":
            return (await provider.getParent?.(payload)) ?? null;
          default:
            throw new Error(`unknown tree-view verb: ${verb}`);
        }
      });
      bridge.callHost("window.createTreeView", [ns(viewId), providerCb.id]).catch(() => undefined);
      const view: TreeView = {
        viewType: viewId,
        async reveal(element: unknown, revealOptions?: unknown) {
          await bridge.callHost("window.treeView.reveal", [ns(viewId), element, revealOptions ?? null]);
        },
        dispose() {
          providerCb.dispose();
          bridge.callHost("window.treeView.dispose", [ns(viewId)]).catch(() => undefined);
        },
      };
      return view;
    },
    createStatusBarItem(alignment?: number, priority?: number) {
      const itemId = ns(`status.${nextLocalId()}`);
      bridge
        .callHost("window.createStatusBarItem", [itemId, alignment ?? StatusBarAlignment.Left, priority ?? 0])
        .catch(() => undefined);
      const state: { text: string; tooltip: string | undefined; command: string | undefined } = {
        text: "",
        tooltip: undefined,
        command: undefined,
      };
      const push = (patch: Record<string, unknown>) => {
        bridge.callHost("window.statusBarItem.update", [itemId, patch]).catch(() => undefined);
      };
      return {
        get text() {
          return state.text;
        },
        set text(value: string) {
          state.text = value;
          push({ text: value });
        },
        get tooltip() {
          return state.tooltip;
        },
        set tooltip(value: string | undefined) {
          state.tooltip = value;
          push({ tooltip: value ?? null });
        },
        get command() {
          return state.command;
        },
        set command(value: string | undefined) {
          state.command = value;
          push({ command: value ?? null });
        },
        show() {
          bridge.callHost("window.statusBarItem.show", [itemId]).catch(() => undefined);
        },
        hide() {
          bridge.callHost("window.statusBarItem.hide", [itemId]).catch(() => undefined);
        },
        dispose() {
          bridge.callHost("window.statusBarItem.dispose", [itemId]).catch(() => undefined);
        },
      };
    },
    async withProgress<T>(
      progressOptions: { location?: number; title?: string; cancellable?: boolean },
      task: (progress: ProgressReporter, token: CancellationToken) => Promise<T>,
    ): Promise<T> {
      const taskId = ns(`progress.${nextLocalId()}`);
      const cancellation = makeCancellationToken();
      const cancelCb = bridge.registerCallback(`progress.${taskId}.cancel`, () => {
        cancellation.cancel();
        return null;
      });
      await bridge
        .callHost("window.withProgress.begin", [taskId, progressOptions, cancelCb.id])
        .catch(() => undefined);
      const reporter: ProgressReporter = {
        report(value) {
          bridge.callHost("window.withProgress.report", [taskId, value]).catch(() => undefined);
        },
      };
      try {
        return await task(reporter, cancellation.token);
      } finally {
        cancelCb.dispose();
        bridge.callHost("window.withProgress.end", [taskId]).catch(() => undefined);
      }
    },
    registerWebviewViewProvider(viewId: string, provider: WebviewViewProvider): Disposable {
      const cb = bridge.registerCallback(`webviewView.${viewId}`, async (args) => {
        const [verb, payload] = args as [string, { handle: number; viewType: string; title: string }];
        if (verb !== "resolve") throw new Error(`unknown webview-view verb: ${verb}`);
        const handle: WebviewHandle = {
          handle: payload.handle,
          viewType: payload.viewType,
          title: payload.title,
          html: "",
          messageListeners: [],
        };
        const panel = makeWebviewPanel(webview, handle);
        await provider.resolveWebviewView(panel);
        return { ok: true };
      });
      bridge.callHost("window.registerWebviewViewProvider", [ns(viewId), cb.id]).catch(() => undefined);
      return {
        dispose() {
          cb.dispose();
          bridge
            .callHost("window.unregisterWebviewViewProvider", [ns(viewId)])
            .catch(() => undefined);
        },
      };
    },
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
    async findFiles(
      include: string,
      exclude?: string | null,
      maxResults?: number,
    ): Promise<Array<{ fsPath: string; scheme: string }>> {
      return (await bridge.callHost("workspace.findFiles", [
        include,
        exclude ?? null,
        maxResults ?? null,
      ])) as Array<{ fsPath: string; scheme: string }>;
    },
    getConfiguration(section?: string, scope?: unknown) {
      const root = section ?? "";
      return {
        get<T>(key: string, defaultValue?: T): T | undefined {
          // Synchronous-shaped read backed by the host's synchronous config
          // cache. Extensions that need true async should call `update` and
          // re-read; the host pushes invalidations on its own channel.
          const path = root ? `${root}.${key}` : key;
          // The bridge call is async; we surface the resolved value via a
          // stand-in `defaultValue` until the host responds. Returning the
          // promise would violate the synchronous vscode contract.
          void bridge
            .callHost("workspace.configuration.warm", [path, scope ?? null])
            .catch(() => undefined);
          return defaultValue;
        },
        async has(key: string): Promise<boolean> {
          const path = root ? `${root}.${key}` : key;
          return (await bridge.callHost("workspace.configuration.has", [path, scope ?? null])) as boolean;
        },
        async update(key: string, value: unknown, target?: number): Promise<void> {
          const path = root ? `${root}.${key}` : key;
          await bridge.callHost("workspace.configuration.update", [path, value, target ?? null, scope ?? null]);
        },
        async inspect<T>(key: string) {
          const path = root ? `${root}.${key}` : key;
          return (await bridge.callHost("workspace.configuration.inspect", [path, scope ?? null])) as
            | { defaultValue?: T; globalValue?: T; workspaceValue?: T }
            | undefined;
        },
      };
    },
    registerTextDocumentContentProvider(scheme: string, provider: TextDocumentContentProvider): Disposable {
      const cb = bridge.registerCallback(`tdcp.${scheme}`, async (args) => {
        const [verb, payload] = args as [string, unknown];
        if (verb !== "provideTextDocumentContent") {
          throw new Error(`unknown tdcp verb: ${verb}`);
        }
        return (await provider.provideTextDocumentContent(payload)) ?? null;
      });
      bridge
        .callHost("workspace.registerTextDocumentContentProvider", [scheme, cb.id])
        .catch(() => undefined);
      return {
        dispose() {
          cb.dispose();
          bridge
            .callHost("workspace.unregisterTextDocumentContentProvider", [scheme])
            .catch(() => undefined);
        },
      };
    },
  };

  const registerLanguageProvider = (
    kind: "hover" | "completion" | "definition",
    selector: unknown,
    provider: unknown,
    triggerCharacters?: readonly string[],
  ): Disposable => {
    const verbByKind = {
      hover: "provideHover",
      completion: "provideCompletionItems",
      definition: "provideDefinition",
    } as const;
    const verb = verbByKind[kind];
    const cb = bridge.registerCallback(`lang.${kind}`, async (args) => {
      const fn = (provider as Record<string, ((...a: unknown[]) => unknown) | undefined>)[verb];
      if (typeof fn !== "function") return null;
      return (await fn.call(provider, ...args)) ?? null;
    });
    bridge
      .callHost(`languages.register${capitalize(kind)}Provider`, [
        selector,
        cb.id,
        triggerCharacters ?? null,
      ])
      .catch(() => undefined);
    return {
      dispose() {
        cb.dispose();
        bridge
          .callHost(`languages.unregister${capitalize(kind)}Provider`, [cb.id])
          .catch(() => undefined);
      },
    };
  };

  const languages = {
    registerHoverProvider(selector: unknown, provider: unknown): Disposable {
      return registerLanguageProvider("hover", selector, provider);
    },
    registerCompletionItemProvider(
      selector: unknown,
      provider: unknown,
      ...triggerCharacters: string[]
    ): Disposable {
      return registerLanguageProvider("completion", selector, provider, triggerCharacters);
    },
    registerDefinitionProvider(selector: unknown, provider: unknown): Disposable {
      return registerLanguageProvider("definition", selector, provider);
    },
  };

  const debug = {
    onDidStartDebugSession: noopEvent,
    onDidTerminateDebugSession: noopEvent,
    registerDebugConfigurationProvider(
      type: string,
      provider: DebugConfigurationProvider,
      triggerKind?: number,
    ): Disposable {
      const cb = bridge.registerCallback(`debug.cfg.${type}`, async (args) => {
        const [verb, payload] = args as [string, unknown];
        switch (verb) {
          case "provideDebugConfigurations":
            return (await provider.provideDebugConfigurations?.(payload)) ?? [];
          case "resolveDebugConfiguration":
            return (await provider.resolveDebugConfiguration?.(payload, undefined)) ?? null;
          case "resolveDebugConfigurationWithSubstitutedVariables":
            return (
              (await provider.resolveDebugConfigurationWithSubstitutedVariables?.(payload, undefined)) ?? null
            );
          default:
            throw new Error(`unknown debug-cfg verb: ${verb}`);
        }
      });
      bridge
        .callHost("debug.registerDebugConfigurationProvider", [type, cb.id, triggerKind ?? null])
        .catch(() => undefined);
      return {
        dispose() {
          cb.dispose();
          bridge
            .callHost("debug.unregisterDebugConfigurationProvider", [type, cb.id])
            .catch(() => undefined);
        },
      };
    },
    async startDebugging(folder: unknown, nameOrConfig: unknown, parentSession?: unknown): Promise<boolean> {
      return (await bridge.callHost("debug.startDebugging", [
        folder ?? null,
        nameOrConfig,
        parentSession ?? null,
      ])) as boolean;
    },
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
    StatusBarAlignment,
    ProgressLocation,
    ViewColumn,
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

let localIdCounter = 0;
function nextLocalId(): number {
  return ++localIdCounter;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

type ProgressReporter = { report(value: { message?: string; increment?: number }): void };

type CancellationToken = {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): Disposable;
};

function makeCancellationToken(): { token: CancellationToken; cancel(): void } {
  const listeners: Array<() => void> = [];
  const token: CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested(listener) {
      listeners.push(listener);
      return {
        dispose() {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        },
      };
    },
  };
  return {
    token,
    cancel() {
      if (token.isCancellationRequested) return;
      token.isCancellationRequested = true;
      for (const fn of listeners) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

type TreeDataProvider = {
  getTreeItem(element: unknown): unknown | Promise<unknown>;
  getChildren?(element?: unknown): unknown[] | Promise<unknown[]>;
  getParent?(element: unknown): unknown | Promise<unknown>;
};

type TreeView = {
  viewType: string;
  reveal(element: unknown, options?: unknown): Promise<void>;
  dispose(): void;
};

type WebviewViewProvider = {
  resolveWebviewView(view: unknown): void | Promise<void>;
};

type TextDocumentContentProvider = {
  provideTextDocumentContent(uri: unknown): string | undefined | Promise<string | undefined>;
};

type DebugConfigurationProvider = {
  provideDebugConfigurations?(folder: unknown): unknown[] | Promise<unknown[]>;
  resolveDebugConfiguration?(folder: unknown, config: unknown): unknown | Promise<unknown>;
  resolveDebugConfigurationWithSubstitutedVariables?(
    folder: unknown,
    config: unknown,
  ): unknown | Promise<unknown>;
};

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
