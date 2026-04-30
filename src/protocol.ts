/**
 * Logos Extension Protocol — wire format shared by every extension host
 * (logos-js, logos-wasm, rosetta). Mirrors the framing used by the Ines
 * language daemon so the workbench can drive every host through one
 * IPC plumbing.
 *
 * Frame on the wire: 4-byte big-endian length | UTF-8 JSON payload.
 */

export type RequestFrame = {
  type: "request";
  id: number;
  method: string;
  params?: unknown;
};

export type ResponseFrame = {
  type: "response";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type NotificationFrame = {
  type: "notification";
  method: string;
  params?: unknown;
};

export type Frame = RequestFrame | ResponseFrame | NotificationFrame;

export const HOST_INITIALIZE = "host/initialize";
export const HOST_SHUTDOWN = "host/shutdown";
export const HOST_READY = "host/ready";

export const EXTENSION_ACTIVATE = "extension/activate";
export const EXTENSION_DEACTIVATE = "extension/deactivate";

export const VSCODE_BRIDGE = "vscode/bridge";
export const WEBVIEW_RPC = "webview/rpc";

export type HostInitializeParams = {
  protocolVersion: "1.0";
  workspace: string;
  userDataDir: string;
  clientVersion: string;
  vendorRoot: string;
  enableLanguageServices: boolean;
};

export type ExtensionActivateParams = {
  extensionId: string;
  manifest: ExtensionManifest;
  extensionRoot: string;
  activationEvent: string;
};

export type ExtensionManifest = {
  name: string;
  publisher: string;
  version: string;
  main?: string;
  engines: { vscode?: string; logos?: string };
  contributes?: Record<string, unknown>;
  activationEvents?: string[];
  capabilities?: { untrustedWorkspaces?: { supported: boolean }; virtualWorkspaces?: boolean };
};
