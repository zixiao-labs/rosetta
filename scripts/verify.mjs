#!/usr/bin/env node
/**
 * Sanity-check that the vendored VS Code submodule is at the commit
 * recorded in NOTICE-3RD-PARTY.md. Run this in CI before producing a
 * release tarball — a mismatch means the notice has not been updated.
 */

import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

async function main() {
  const noticePath = path.join(repoRoot, "NOTICE-3RD-PARTY.md");
  const notice = await fsp.readFile(noticePath, "utf8");
  const match = /commit `([0-9a-f]{7,40})`/.exec(notice);
  if (!match) {
    throw new Error("NOTICE-3RD-PARTY.md does not record a vscode commit hash.");
  }
  const declared = match[1];

  const submoduleRoot = path.join(repoRoot, "vendor", "vscode");
  const result = spawnSync("git", ["-C", submoduleRoot, "rev-parse", "HEAD"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error("git rev-parse failed in vendor/vscode");
  }
  const actual = result.stdout.toString("utf8").trim();

  if (!actual.startsWith(declared)) {
    throw new Error(
      `vendor/vscode HEAD ${actual} does not match NOTICE-3RD-PARTY.md ${declared}. ` +
        `Update the notice or re-pin the submodule before releasing.`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(`OK — vendor/vscode pinned to ${actual}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err.message);
  process.exit(1);
});
