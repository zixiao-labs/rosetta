# Third-Party Notices for Rosetta

Rosetta is the VS Code extension-host compatibility layer for
[Logos Editor Workstation Edition](https://github.com/zixiao-labs/logos).
It is distributed under the terms of the [MIT License](./LICENSE) and
incorporates, depends on, or vendors components from the projects listed
below. Those components remain licensed under their original terms, which
apply in addition to (and where there is conflict, supersede) the terms of
the Rosetta MIT license for the relevant files.

This notice satisfies the attribution requirements of those licenses. It
must be reproduced in any redistribution of Rosetta — including the
release tarballs that the Logos workbench downloads at runtime — together
with the upstream license text.

---

## 1. Microsoft Visual Studio Code

- **Project**: [microsoft/vscode](https://github.com/microsoft/vscode)
- **License**: MIT (`LICENSE.txt` at the upstream repository root)
- **Version pinned**: `1.106.0` (commit `cdd1c54e4c09d906520c9835b87a6de36de3ec88`)
- **Vendored under**: `vendor/vscode/` (git submodule)

Rosetta vendors the VS Code source tree as a git submodule. The Rosetta
build (see `scripts/bundle.mjs`) reuses the following upstream files and
modules at compile and runtime; their copyright remains with Microsoft and
the VS Code contributors:

| Path under `vendor/vscode/` | Purpose in Rosetta |
| --- | --- |
| `src/vs/workbench/api/common/extHost.api.impl.ts` | Source of the `vscode.*` API shape mirrored in `src/shims/vscode.ts`. |
| `src/vs/workbench/api/common/extHost.protocol.ts` | RPC protocol reference for the bridge. |
| `src/vs/workbench/api/node/extensionHostProcess.ts` | Loaded at runtime when the rich extension host is enabled. |
| `src/vs/workbench/services/extensions/common/extensionHostManager.ts` | Lifecycle reference. |
| `src/vs/base/parts/ipc/**` | Length-prefixed IPC primitives studied for parity. |
| `src/vscode-dts/vscode.d.ts` | Public API type definitions exposed to extensions. |

The full upstream license text follows.

```
MIT License

Copyright (c) 2015 - present Microsoft Corporation

All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

VS Code itself ships hundreds of bundled third-party components under their
own licenses. Their full attribution lives in the upstream files
[`cgmanifest.json`](./vendor/vscode/cgmanifest.json) and
[`cglicenses.json`](./vendor/vscode/cglicenses.json); both are reproduced
verbatim inside the `vendor/vscode/` submodule and travel with the
Rosetta release tarball when the user downloads the compatibility layer.
Notable transitive components include:

- **Chromium** (BSD, Google LLC) — used by Electron, vendored by VS Code.
- **node-pty** (MIT, Microsoft Corporation) — terminal back-end.
- **xterm.js** (MIT, The xterm.js authors) — terminal renderer.
- **markdown-it** (MIT, Vitaly Puzrin & Alex Kocharin).
- **JSON-RPC libraries** (MIT, Microsoft Corporation).
- **TypeScript** (Apache-2.0, Microsoft Corporation) — used at build time.

Refer to `vendor/vscode/ThirdPartyNotices.txt` (generated upstream, present
once the submodule is initialized) for the full per-component attribution.

---

## 2. TypeScript

- **Project**: [microsoft/TypeScript](https://github.com/microsoft/TypeScript)
- **License**: Apache-2.0
- **Used as**: build-time devDependency (`typescript` in `package.json`).

Rosetta's published artefact does **not** include the TypeScript compiler;
it is only required to produce `dist/` from `src/`. The Apache-2.0 license
text is available at <https://www.apache.org/licenses/LICENSE-2.0>.

---

## 3. Node.js Type Definitions

- **Project**: [DefinitelyTyped/DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped)
- **Package**: `@types/node`
- **License**: MIT (per individual contribution headers)
- **Used as**: build-time devDependency.

Type definitions are erased at compile time and do not appear in the
shipped artefact.

---

## 4. Wasmtime

Rosetta does not statically link Wasmtime. The Logos workbench ships its
own `logos-wasm` host that may invoke a Wasmtime distribution side-by-side;
Wasmtime is the [Bytecode Alliance](https://bytecodealliance.org/) project
distributed under the Apache-2.0 WITH LLVM-exception license.

When the Logos workstation downloads Wasmtime as part of its own optional
add-ons, the corresponding notice ships with the Logos installer, not with
Rosetta.

---

## Updating this notice

This file must be revisited whenever:

1. The vendored VS Code submodule is re-pinned to a new commit
   (update the **Version pinned** line).
2. A new upstream file is referenced by Rosetta source code
   (add a row to the table in §1).
3. A new direct dependency is added to `package.json`
   (add a new top-level section).

The `npm run verify` script enforces (1) by comparing the submodule HEAD
against the value recorded above.
