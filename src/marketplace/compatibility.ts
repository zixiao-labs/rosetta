/**
 * Compatibility surface — single source of truth for what Rosetta's
 * vscode.* shim can actually run today. Used by the marketplace layer to
 * filter search results so Logos's "Browse extensions" pane only ever
 * lists extensions whose declared activation events and `contributes.*`
 * keys map onto APIs we have implemented.
 *
 * Keep this file in lock-step with `src/shims/vscode.ts` and
 * `src/glue/vscodeBridge.ts`. The matching test is intentionally manual:
 * if you add a new shim method, add the corresponding `vscode.*` path
 * here so the gallery filter relaxes to match.
 *
 * The lists below are *positive* (allowlist). Anything not enumerated is
 * assumed unsupported, which is what we want: a new VS Code API surfacing
 * an extension we cannot run should fail closed.
 */
import type { ExtensionManifest } from "../protocol.js";

/**
 * `vscode.*` member paths the shim currently exposes. Dotted paths
 * mirror what extensions reference at the call site; namespace-only
 * entries (e.g. `commands`) imply the whole namespace is at least
 * partially present so a manifest declaring `contributes.commands` is
 * acceptable even when individual provider methods may differ.
 */
export const SUPPORTED_API_PATHS: ReadonlySet<string> = new Set([
  // Top-level constructors / values
  "version",
  "Uri",
  "Uri.file",
  "Uri.parse",
  "EventEmitter",
  "Disposable",
  "StatusBarAlignment",
  "ProgressLocation",
  "ViewColumn",

  // commands.*
  "commands",
  "commands.registerCommand",
  "commands.executeCommand",

  // window.*
  "window",
  "window.showInformationMessage",
  "window.showWarningMessage",
  "window.showErrorMessage",
  "window.showQuickPick",
  "window.showInputBox",
  "window.createOutputChannel",
  "window.createWebviewPanel",
  "window.createTreeView",
  "window.createStatusBarItem",
  "window.withProgress",
  "window.registerWebviewViewProvider",

  // workspace.*
  "workspace",
  "workspace.openTextDocument",
  "workspace.fs",
  "workspace.fs.readFile",
  "workspace.fs.writeFile",
  "workspace.fs.stat",
  "workspace.findFiles",
  "workspace.getConfiguration",
  "workspace.registerTextDocumentContentProvider",
  "workspace.onDidChangeTextDocument",
  "workspace.onDidOpenTextDocument",
  "workspace.onDidCloseTextDocument",

  // languages.*
  "languages",
  "languages.registerHoverProvider",
  "languages.registerCompletionItemProvider",
  "languages.registerDefinitionProvider",

  // debug.*
  "debug",
  "debug.onDidStartDebugSession",
  "debug.onDidTerminateDebugSession",
  "debug.registerDebugConfigurationProvider",
  "debug.startDebugging",

  // extensions.* (stub)
  "extensions",
  "extensions.getExtension",
  "extensions.all",
]);

/**
 * `contributes.<key>` values the shim/host can route. A manifest is
 * permitted to declare contributions in this set; anything else is
 * treated as a hard incompatibility.
 *
 * Many of these are purely declarative (themes, grammars, snippets,
 * keybindings) — they don't need shim code, only a workbench that
 * reads the manifest. We list them anyway because Rosetta's contract
 * with the workbench is to *not block* well-formed declarative-only
 * extensions.
 */
export const SUPPORTED_CONTRIBUTION_KEYS: ReadonlySet<string> = new Set([
  // Code-driven
  "commands",
  "configuration",
  "configurationDefaults",
  "menus",
  "views",
  "viewsContainers",
  "viewsWelcome",
  "debuggers",
  "breakpoints",

  // Declarative-only (no shim code required)
  "languages",
  "grammars",
  "snippets",
  "themes",
  "iconThemes",
  "productIconThemes",
  "colors",
  "keybindings",
  "jsonValidation",
  "problemMatchers",
  "problemPatterns",
  "semanticTokenScopes",
  "semanticTokenTypes",
  "semanticTokenModifiers",
]);

/**
 * `activationEvents` prefixes the host knows how to fire today. An
 * activation event of the form `<prefix>:...` is acceptable iff the
 * prefix appears here (or it is one of the bare events also listed).
 */
export const SUPPORTED_ACTIVATION_EVENTS: ReadonlySet<string> = new Set([
  "*",
  "onStartupFinished",
  "onLanguage",
  "onCommand",
  "onDebug",
  "onDebugInitialConfigurations",
  "onDebugResolve",
  "onView",
  "onWebviewPanel",
  "workspaceContains",
  "onFileSystem",
  // "onUri" is intentionally excluded: per docs/API_GAPS.md the URI
  // handler surface (`vscode.window.registerUriHandler`,
  // `vscode.env.uriScheme`, `vscode.env.openExternal`) is not yet
  // implemented, so OAuth/callback extensions cannot actually receive
  // the event. Re-add this entry only when those APIs land in
  // src/shims/vscode.ts and the corresponding row in API_GAPS.md flips
  // from ❌ blocked to ✅.
]);

/**
 * Activation-event prefixes / contribution keys we *recognize* as
 * out-of-scope for Rosetta and want to surface in the UI as a clear
 * "needs Stage 4 / Stage 5 work" reason rather than an opaque "unknown
 * key". Order matters only insofar as longer prefixes must come first.
 */
const KNOWN_UNSUPPORTED_ACTIVATION_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["onCustomEditor", "custom editors not implemented (Stage 4)"],
  ["onTerminalProfile", "terminals not implemented (Stage 4)"],
  ["onAuthenticationRequest", "vscode.authentication not implemented"],
  ["onTaskType", "vscode.tasks not implemented"],
  ["onNotebook", "vscode.notebooks not implemented"],
  ["onRenderer", "notebook renderers not implemented"],
  ["onSearch", "vscode.search APIs not implemented"],
  ["onChatParticipant", "vscode.chat not implemented"],
];

const KNOWN_UNSUPPORTED_CONTRIBUTIONS: Readonly<Record<string, string>> = {
  customEditors: "custom editors not implemented (Stage 4)",
  terminal: "terminals not implemented (Stage 4)",
  taskDefinitions: "vscode.tasks not implemented",
  notebooks: "vscode.notebooks not implemented",
  notebookRenderer: "notebook renderers not implemented",
  notebookPreload: "notebook renderers not implemented",
  authentication: "vscode.authentication not implemented",
  walkthroughs: "walkthroughs not implemented (Stage 4)",
  chatParticipants: "vscode.chat not implemented",
  languageModelTools: "vscode.lm not implemented",
  customEditorPriority: "custom editors not implemented (Stage 4)",
};

/**
 * Result of running a manifest through the compatibility filter.
 *
 *   `runnable === true`  → safe to surface in the gallery and activate
 *   `runnable === false` → activation will throw; the workbench should
 *                          show this in a separate "needs Rosetta work"
 *                          tab so the user knows Logos saw it.
 */
export type CompatibilityReport = {
  runnable: boolean;
  /** Human-readable summary, suitable for a tooltip. */
  reason: string;
  /** Specific contributes.* keys that block activation. */
  unsupportedContributions: string[];
  /** Specific activationEvents that block activation. */
  unsupportedActivationEvents: string[];
  /** Notes about what we'd need to add to make this extension run. */
  notes: string[];
};

export type CompatibilityInput = Pick<
  ExtensionManifest,
  "activationEvents" | "contributes" | "engines" | "capabilities"
> & {
  /** Some galleries return `extensionPack` / `extensionDependencies`. */
  extensionPack?: readonly string[];
  extensionDependencies?: readonly string[];
};

export function evaluateCompatibility(manifest: CompatibilityInput): CompatibilityReport {
  const unsupportedContributions: string[] = [];
  const unsupportedActivationEvents: string[] = [];
  const notes: string[] = [];

  // 1. contributes.*
  const contributes = manifest.contributes ?? {};
  for (const key of Object.keys(contributes)) {
    if (SUPPORTED_CONTRIBUTION_KEYS.has(key)) continue;
    unsupportedContributions.push(key);
    const why = KNOWN_UNSUPPORTED_CONTRIBUTIONS[key];
    if (why) notes.push(`contributes.${key}: ${why}`);
    else notes.push(`contributes.${key}: not enumerated in compatibility surface`);
  }

  // 2. activationEvents
  for (const ev of manifest.activationEvents ?? []) {
    if (SUPPORTED_ACTIVATION_EVENTS.has(ev)) continue;
    const colonIdx = ev.indexOf(":");
    const prefix = colonIdx === -1 ? ev : ev.slice(0, colonIdx);
    if (SUPPORTED_ACTIVATION_EVENTS.has(prefix)) continue;
    unsupportedActivationEvents.push(ev);
    const known = KNOWN_UNSUPPORTED_ACTIVATION_PREFIXES.find(([p]) => prefix === p);
    if (known) notes.push(`activationEvents:${ev} → ${known[1]}`);
    else notes.push(`activationEvents:${ev} → unknown prefix`);
  }

  // 3. capabilities.virtualWorkspaces=false is fine; untrustedWorkspaces
  //    we do not yet honor, so we surface a soft note but don't block.
  const cap = manifest.capabilities ?? {};
  if (cap.untrustedWorkspaces && cap.untrustedWorkspaces.supported === false) {
    notes.push("capabilities.untrustedWorkspaces=false (workspace trust not enforced; soft warning)");
  }

  // 4. engines.vscode — we currently advertise as 1.106.0-rosetta. We do
  //    not strictly enforce the range here; that's the workbench's job
  //    when downloading. We do note ranges that demand a future version
  //    so the user understands why an extension may misbehave.
  const engineRange = manifest.engines?.vscode;
  if (engineRange && /\^?1\.10[7-9]|\^?1\.[2-9]\d|\^?[2-9]/.test(engineRange)) {
    notes.push(`engines.vscode=${engineRange} requires VS Code newer than the bundled 1.106.x surface`);
  }

  // 5. extensionPack / extensionDependencies — we cannot resolve these
  //    inside Rosetta (the workbench drives downloads). Just record.
  if (manifest.extensionPack?.length) {
    notes.push(`extensionPack lists ${manifest.extensionPack.length} entries; resolution happens in Logos`);
  }
  if (manifest.extensionDependencies?.length) {
    notes.push(
      `extensionDependencies: ${manifest.extensionDependencies.join(", ")} (must also be runnable)`,
    );
  }

  const runnable =
    unsupportedContributions.length === 0 && unsupportedActivationEvents.length === 0;

  let reason: string;
  if (runnable) {
    reason = "All declared contributions and activation events are supported by Rosetta.";
  } else {
    const parts: string[] = [];
    if (unsupportedContributions.length) {
      parts.push(`contributes: ${unsupportedContributions.join(", ")}`);
    }
    if (unsupportedActivationEvents.length) {
      parts.push(`activationEvents: ${unsupportedActivationEvents.join(", ")}`);
    }
    reason = `Cannot run — unsupported ${parts.join("; ")}.`;
  }

  return {
    runnable,
    reason,
    unsupportedContributions,
    unsupportedActivationEvents,
    notes,
  };
}

/** Convenience: filter an array of search results down to runnable ones. */
export function partitionByCompatibility<
  T extends { manifest: CompatibilityInput; compatibility?: CompatibilityReport },
>(
  items: readonly T[],
): { runnable: Array<T & { compatibility: CompatibilityReport }>; rejected: Array<T & { compatibility: CompatibilityReport }> } {
  const runnable: Array<T & { compatibility: CompatibilityReport }> = [];
  const rejected: Array<T & { compatibility: CompatibilityReport }> = [];
  for (const item of items) {
    // An adapter that already knows the item is unsupported (e.g. an
    // OpenVSX search hit whose details fetch failed) can pre-stamp a
    // compatibility report. Honor it instead of re-evaluating against
    // a possibly empty manifest, which would otherwise pass closed
    // because there is nothing to flag.
    const compatibility = item.compatibility ?? evaluateCompatibility(item.manifest);
    const decorated = { ...item, compatibility };
    if (compatibility.runnable) runnable.push(decorated);
    else rejected.push(decorated);
  }
  return { runnable, rejected };
}
