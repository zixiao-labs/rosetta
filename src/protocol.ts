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
export const VSCODE_EXTENSION_CALL = "vscode/extension-call";
export const WEBVIEW_RPC = "webview/rpc";

/**
 * Marketplace gallery methods. Logos drives every gallery interaction
 * through Rosetta so the workbench process never has to learn the
 * OpenVSX / VS Marketplace wire formats. See `src/marketplace/`.
 *
 *   marketplace/search    → AggregatedSearchResult (without VSIX bytes)
 *   marketplace/get       → GalleryExtension | null
 *   marketplace/download  → { source, extensionId, version, bytes, sha256, vsixPath }
 *   marketplace/sources   → GallerySource[]
 *
 * Downloads do not return raw bytes over the JSON-RPC channel: the
 * dispatcher writes the VSIX to a temp path under the configured
 * userDataDir and returns the path so the workbench can move/install.
 */
export const MARKETPLACE_SEARCH = "marketplace/search";
export const MARKETPLACE_GET = "marketplace/get";
export const MARKETPLACE_DOWNLOAD = "marketplace/download";
export const MARKETPLACE_SOURCES = "marketplace/sources";

export type HostInitializeParams = {
  protocolVersion: "1.0";
  workspace: string;
  userDataDir: string;
  clientVersion: string;
  vendorRoot: string;
  enableLanguageServices: boolean;
  /**
   * Optional gallery configuration. If omitted, both OpenVSX and the
   * Microsoft VS Marketplace are enabled with their defaults; pass
   * `false` to disable a source (e.g. air-gapped enterprise installs).
   */
  marketplace?: {
    openvsx?: false | { baseUrl?: string };
    vsMarketplace?: false | { baseUrl?: string; fetchManifests?: boolean };
    defaultSource?: "openvsx" | "vs-marketplace";
  };
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
