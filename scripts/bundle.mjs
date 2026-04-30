#!/usr/bin/env node
/**
 * Build a Rosetta release tarball.
 *
 * Layout (post-install in user data dir):
 *   rosetta/<platform>-<arch>/
 *     boot.js                    ← node entrypoint
 *     glue/, shims/, webview/    ← compiled JS
 *     vendor/vscode/...          ← curated subset of microsoft/vscode
 *     LICENSE
 *     NOTICE-3RD-PARTY.md
 *     manifest.json              ← {version, vscodeCommit, sha256}
 *
 * Companion file: rosetta-<platform>-<arch>.tar.gz.sha256
 *
 * The Logos workbench fetches both from
 *   https://github.com/zixiao-labs/rosetta/releases/latest
 * and verifies the digest before extracting.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const PLATFORM_MAP = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const ARCH_MAP = {
  x64: "amd64",
  arm64: "arm64",
};

async function main() {
  const platformKey = PLATFORM_MAP[process.platform];
  const archKey = ARCH_MAP[process.arch];
  if (!platformKey || !archKey) {
    throw new Error(`Unsupported host: ${process.platform}/${process.arch}`);
  }

  const distDir = path.join(repoRoot, "dist");
  const stat = await fsp.stat(distDir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`dist/ is missing — run \`npm run build\` first.`);
  }

  const submoduleRoot = path.join(repoRoot, "vendor", "vscode");
  const vscodeStat = await fsp.stat(submoduleRoot).catch(() => null);
  if (!vscodeStat?.isDirectory()) {
    throw new Error(`vendor/vscode is missing — run \`git submodule update --init --recursive\`.`);
  }

  const releaseDir = path.join(repoRoot, "release");
  await fsp.rm(releaseDir, { recursive: true, force: true });
  await fsp.mkdir(releaseDir, { recursive: true });

  const stagingRoot = path.join(releaseDir, "staging");
  const target = path.join(stagingRoot, "rosetta", `${platformKey}-${archKey}`);
  await fsp.mkdir(target, { recursive: true });

  // 1. Copy compiled JS.
  await copyDir(distDir, target);

  // 2. Copy a curated vscode subset. The full submodule is too large to
  //    bundle; we only ship what the extension host needs at runtime.
  const vendorTarget = path.join(target, "vendor", "vscode");
  await fsp.mkdir(vendorTarget, { recursive: true });
  const vscodeKeep = [
    "LICENSE.txt",
    "ThirdPartyNotices.txt",
    "src/vscode-dts/vscode.d.ts",
    "src/vs/base/common",
    "src/vs/base/parts/ipc",
    "src/vs/workbench/api/common",
    "src/vs/workbench/api/node",
    "out/vs/workbench/api/node",
    "out/vs/workbench/api/common",
  ];
  for (const rel of vscodeKeep) {
    const src = path.join(submoduleRoot, rel);
    const dst = path.join(vendorTarget, rel);
    if (await exists(src)) {
      await copyAny(src, dst);
    }
  }

  // 3. Bundle license, notice, manifest.
  await fsp.copyFile(path.join(repoRoot, "LICENSE"), path.join(target, "LICENSE"));
  await fsp.copyFile(
    path.join(repoRoot, "NOTICE-3RD-PARTY.md"),
    path.join(target, "NOTICE-3RD-PARTY.md"),
  );

  const pkgRaw = await fsp.readFile(path.join(repoRoot, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);
  const vscodeCommit = run("git", ["-C", submoduleRoot, "rev-parse", "HEAD"]).trim();
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    platform: platformKey,
    arch: archKey,
    vscodeCommit,
    builtAt: new Date().toISOString(),
    entry: "boot/main.js",
  };
  await fsp.writeFile(
    path.join(target, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  // 4. Tar it up. We use the `tar` CLI for portability; on win32 we still
  //    rely on bundled bsdtar (Win10+).
  const archiveName = `rosetta-${platformKey}-${archKey}.tar.gz`;
  const archivePath = path.join(releaseDir, archiveName);
  run("tar", ["-czf", archivePath, "-C", stagingRoot, "rosetta"]);

  const digest = await sha256(archivePath);
  await fsp.writeFile(
    `${archivePath}.sha256`,
    `${digest}  ${archiveName}\n`,
    "utf8",
  );

  await fsp.rm(stagingRoot, { recursive: true, force: true });

  // eslint-disable-next-line no-console
  console.log(`Bundled ${archivePath}`);
  // eslint-disable-next-line no-console
  console.log(`SHA-256 ${digest}`);
}

async function exists(p) {
  return Boolean(await fsp.stat(p).catch(() => null));
}

async function copyAny(src, dst) {
  const stat = await fsp.stat(src);
  if (stat.isDirectory()) {
    await fsp.mkdir(dst, { recursive: true });
    await copyDir(src, dst);
  } else {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  }
}

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await fsp.copyFile(from, to);
    }
  }
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with code ${result.status}`);
  }
  return result.stdout.toString("utf8");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err.stack ?? err.message);
  process.exit(1);
});
