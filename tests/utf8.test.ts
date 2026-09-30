// SPDX-License-Identifier: MIT
//
// V8 (P5-NEAR-FIXES-R2): every tracked text file must be valid UTF-8 (a stray Windows-1252 0x97
// dash once got committed into five files). Vendored trees and gitlinks are not ours to change.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const BINARY_EXT = /\.(png|jpe?g|gif|ico|wasm|so|dll|exe|zip|gz|tgz|bin|pdf)$/i;

describe("tracked text files are valid UTF-8", () => {
  it("decodes every non-vendored tracked text file strictly", () => {
    const out = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
    const bad: string[] = [];
    let checked = 0;
    for (const entry of out.split("\0")) {
      if (entry === "") continue;
      const tab = entry.indexOf("\t");
      const mode = entry.slice(0, 6);
      const path = entry.slice(tab + 1);
      if (mode === "160000") continue; // submodule
      if (path.startsWith("vendor/") || path.startsWith("lib/") || BINARY_EXT.test(path)) continue;
      let bytes: Buffer;
      try {
        bytes = readFileSync(resolve(root, path));
      } catch {
        continue; // deleted in the working tree, or a symlink to a directory
      }
      if (bytes.subarray(0, 8000).includes(0)) continue; // binary
      checked += 1;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        bad.push(path);
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(bad).toEqual([]);
  });
});
