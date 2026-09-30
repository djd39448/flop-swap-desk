// SPDX-License-Identifier: MIT
//
// tests/cargo-target-dir.test.ts - the shared build-directory hazard. Two worktrees of this repository share
// one .git but must not share a CARGO_TARGET_DIR (one worktree's build overwrote the other's wasm/.so and
// turned a green NEAR suite red). `scripts/cargo-target-dir.sh` is the single place a target directory is
// computed: it hashes the worktree's own path. These tests fail if it ever returns a shared directory, and
// if any build script or harness goes back to a fixed, unhashed path or to another worktree's checkout.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

// On Windows the first `bash` on PATH can be WSL's launcher (C:\Windows\System32ash.exe), which cannot
// open a Windows path; the script must run under Git for Windows' bash, as every other script here does.
// Resolve it from git's own install (`git --exec-path` = <git root>/mingw64/libexec/git-core); elsewhere
// plain `bash` is correct.
function findBash(): string {
  if (process.platform !== "win32") return "bash";
  const exec = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (exec.status === 0) {
    const candidate = resolve(exec.stdout.trim(), "..", "..", "..", "bin", "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("cargo-target-dir test: Git for Windows bash not found (git --exec-path gave no bin/bash.exe)");
}
const BASH = findBash();
const SCRIPT = join(ROOT, "scripts", "cargo-target-dir.sh");
const scratch = mkdtempSync(join(tmpdir(), "cargo-target-dir-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function worktreeCopy(name: string): string {
  const dir = join(scratch, name, "scripts");
  mkdirSync(dir, { recursive: true });
  cpSync(SCRIPT, join(dir, "cargo-target-dir.sh"));
  return join(dir, "cargo-target-dir.sh");
}

function run(script: string, arg: string): string {
  const r = spawnSync(BASH, [script.replace(/\\/g, "/"), arg], { encoding: "utf8", env: { ...process.env, HOME: "/home/test" } });
  if (r.status !== 0) throw new Error(`cargo-target-dir.sh failed: ${r.stderr}`);
  return r.stdout.trim();
}

describe("scripts/cargo-target-dir.sh", () => {
  it("returns a hash-suffixed directory, different per worktree path and per contract family, stable for one path", () => {
    const a = worktreeCopy("wt-a");
    const b = worktreeCopy("wt-b");
    const nearA = run(a, "near");
    expect(nearA).toMatch(/^\/home\/test\/\.cache\/flop-near-target-[0-9a-f]{8}$/);
    expect(run(a, "near")).toBe(nearA);
    expect(run(b, "near")).not.toBe(nearA);
    expect(run(a, "sol")).toMatch(/^\/home\/test\/\.cache\/flop-sol-target-[0-9a-f]{8}$/);
    expect(run(a, "sol").split("-").pop()).toBe(nearA.split("-").pop());
  });

  it("refuses an unknown family", () => {
    const r = spawnSync(BASH, [SCRIPT.replace(/\\/g, "/"), "evm"], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
  });
});

describe("no build script or harness uses a shared or foreign path", () => {
  const files = [
    "contracts-near/build.sh",
    "contracts-near/smoke-test.sh",
    "contracts-sol/build.sh",
    "contracts-sol/smoke.sh",
    "tests-near/probe/nb0-probe.sh",
    "tests-near/helpers/sandbox.ts",
    "tests-sol/helpers/validator.ts",
    "contracts-sol/htlc-tests/tests/htlc.rs",
  ];
  it.each(files)("%s", (file) => {
    const text = readFileSync(join(ROOT, file), "utf8");
    expect(text, "a fixed shared target directory").not.toMatch(/\.cache\/flop-(near|sol)-target(?!-)/);
    expect(text, "a hard-coded sibling worktree").not.toMatch(/flop-swap-desk-near\//);
    expect(text, "a hard-coded sibling worktree").not.toMatch(/\/flop-swap-desk\//);
  });
  it("both build scripts take the target directory from the shared script", () => {
    expect(readFileSync(join(ROOT, "contracts-near/build.sh"), "utf8")).toMatch(/cargo-target-dir\.sh" near/);
    expect(readFileSync(join(ROOT, "contracts-sol/build.sh"), "utf8")).toMatch(/cargo-target-dir\.sh" sol/);
  });
});
