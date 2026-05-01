# Rosetta

> VS Code extension-host compatibility layer for [Logos Editor Workstation Edition](https://github.com/zixiao-labs/logos).

Rosetta is the **optional** glue that lets Logos host extensions written against
the VS Code extension API (`vscode.*` namespace), including ones that ship a
webview. It is intentionally not bundled with the Logos installer: keeping the
base download small is a hard requirement of the workstation edition.

When a user opts in via
**Settings → Extensions → Download VS Code Compatibility Layer**, Logos
fetches the platform-specific Rosetta tarball from the
[`zixiao-labs/rosetta`](https://github.com/zixiao-labs/rosetta/releases/latest)
release page, verifies the SHA-256 digest, extracts under the user data
directory, and from then on can spawn the VS Code extension host on demand.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Logos main process (Electron)                               │
│                                                             │
│  ┌─────────────────────┐    ┌─────────────────────────────┐ │
│  │ Logos-JS host       │    │ Logos-WASM host (Wasmtime)  │ │
│  │ (built-in)          │    │ (built-in)                  │ │
│  └─────────────────────┘    └─────────────────────────────┘ │
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Rosetta host  ▸  optional, downloaded from releases     ││
│  │   ├─ glue/         (Logos ↔ vscode extHost RPC adapter) ││
│  │   ├─ shims/        (vscode.* namespace partial impls)   ││
│  │   └─ vendor/vscode (git submodule, MIT)                 ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

The three hosts live side-by-side and share a single
[Logos Extension Protocol](#extension-protocol) JSON-RPC channel, so the
workbench treats them uniformly.

## Repository layout

```
rosetta/
├── src/
│   ├── boot/         entry points (host process & spawn helpers)
│   ├── glue/         Logos ↔ vscode-extHost RPC adapter
│   ├── shims/        partial vscode.* namespace implementations
│   └── webview/      bridge to Logos webview channel
├── vendor/
│   └── vscode/       git submodule → microsoft/vscode (MIT)
├── scripts/
│   ├── bundle.mjs    produces dist/rosetta-{os}-{arch}.tar.gz + .sha256
│   └── verify.mjs    verifies a release against expected layout
├── NOTICE-3RD-PARTY.md
├── LICENSE
└── package.json
```

## Building

Rosetta is built into a versioned tarball that Logos downloads at runtime.

```sh
git submodule update --init --recursive
npm install
npm run build           # compiles src/ → dist/
npm run bundle          # produces release/rosetta-{platform}-{arch}.tar.gz
```

The produced tarball follows the layout
`rosetta/<platform>-<arch>/{boot.js,glue/,shims/,vendor/vscode/...}` with a
matching `.sha256` companion file.

## Extension protocol

The host talks to Logos over stdio with length-prefixed JSON frames (4-byte
big-endian length, then UTF-8 payload). The frame envelope matches the Ines
language daemon so the workbench can multiplex hosts on the same channel
plumbing.

```ts
type Frame =
  | { type: "request";       id: number; method: string; params?: unknown }
  | { type: "response";      id: number; result?: unknown; error?: { code: number; message: string } }
  | { type: "notification";  method: string; params?: unknown };
```

Methods are namespaced: `host/initialize`, `extension/activate`,
`extension/deactivate`, `vscode/<api-bridge>`, `webview/<verb>`.

## Compatibility scope

This is a partial compatibility layer, not a drop-in replacement for VS Code.
The following APIs are **wired and routed** through the bridge — actual
behavior depends on what the host workbench implements:

- `vscode.workspace.{textDocuments, openTextDocument, workspaceFolders, fs}`
- `vscode.window.{showInformationMessage, createOutputChannel, createWebviewPanel}`
- `vscode.commands.{registerCommand, executeCommand}`
- `vscode.languages.{registerHoverProvider, registerCompletionItemProvider, …}`
- `vscode.debug.*` (DAP-shaped, see Stage 3.5)

The following are **explicitly out of scope** and will throw a structured
"unsupported" error:

- Signed extension verification with Microsoft's keys
- LiveShare and Settings Sync

A running ledger of the `vscode.*` surface still pending implementation
lives in [`docs/API_GAPS.md`](./docs/API_GAPS.md). The marketplace
filter (below) reads from the same allowlist that backs that document,
so adding a method to the shim automatically relaxes the gallery
filter for any extension that needed it.

## Marketplace gallery

Rosetta ships with first-class clients for both
[**OpenVSX**](https://open.vsx.org) (default, MIT-licensed) and the
**Microsoft VS Marketplace**. Logos drives them through the
JSON-RPC channel:

```text
marketplace/sources       → { sources: ["openvsx", "vs-marketplace"] }
marketplace/search        → AggregatedSearchResult     (no VSIX bytes)
marketplace/get           → GalleryExtension | null
marketplace/download      → { source, extensionId, version, bytes,
                              sha256, vsixPath }
```

`marketplace/search` runs every result through
`evaluateCompatibility(manifest)` — defined in
`src/marketplace/compatibility.ts` — and only returns extensions whose
`activationEvents` and `contributes.*` keys map onto APIs the shim
already implements. Pass `includeIncompatible: true` to also receive
the rejected list (with a `compatibility.reason` for each), e.g. to
populate a "won't run yet" tab. Downloads land in
`<userDataDir>/rosetta-cache/marketplace/`; Logos moves them into the
extensions tree after its own ad/telemetry/privacy inspection pass.

To opt out of a gallery (air-gapped enterprise, ToS-sensitive
deployments) pass `marketplace.openvsx: false` or
`marketplace.vsMarketplace: false` to `host/initialize`.

## Marketplace inspection

Per the dev plan, third-party marketplace extensions other than first-party
Microsoft ones (Cpptools, C# DevKit, Pylance, …) require Logos's inspector to
clear them for ads, telemetry, privacy, and performance regressions before
activation. That gate lives in the **Logos** workbench, not in Rosetta — the
inspector decides whether to invoke `extension/activate` at all.

## License & attribution

Rosetta itself is released under the [MIT License](./LICENSE). It vendors
significant portions of [Microsoft Visual Studio Code](https://github.com/microsoft/vscode)
(also MIT) — see [NOTICE-3RD-PARTY.md](./NOTICE-3RD-PARTY.md) for the full
notice and a list of the upstream files relied upon.
