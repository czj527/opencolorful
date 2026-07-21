import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  createInMemoryCredentialStore,
  createInMemorySession,
  getPiSdkVersion,
  listWorkspaceToolNames,
  runOfflineCompletionProbe,
} from "../../src/pi-sdk/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PI SDK adapter", () => {
  it("uses the pinned PI SDK version", () => {
    expect(getPiSdkVersion()).toBe("0.80.10");
  });

  it("creates an in-memory PI session without writing JSONL", () => {
    const session = createInMemorySession(process.cwd());

    session.appendUserMessage("hello");
    expect(session.id).toBeTruthy();
    expect(session.persisted).toBe(false);
    expect(session.entryCount).toBe(1);
  });

  it("stores API keys behind a non-secret credential interface", async () => {
    const credentials = createInMemoryCredentialStore();

    await credentials.setApiKey("example", "secret-value");
    expect(await credentials.has("example")).toBe(true);
    expect(await credentials.list()).toEqual([{ providerId: "example", type: "api_key" }]);
  });

  it("runs a faux completion without network access", async () => {
    await expect(runOfflineCompletionProbe("hello", "offline reply")).resolves.toEqual({
      provider: "faux",
      model: "faux-1",
      text: "offline reply",
    });
  });

  it("exposes PI tool factories as stable names", () => {
    expect(listWorkspaceToolNames(process.cwd(), "read-only")).toEqual(
      expect.arrayContaining(["read", "grep", "find", "ls"]),
    );
  });
});

describe("PI SDK import boundary", () => {
  it("accepts this source tree and rejects direct imports outside src/pi-sdk", () => {
    const script = path.resolve("scripts/verify-pi-sdk-imports.mjs");
    expect(spawnSync(process.execPath, [script], { encoding: "utf8" }).status).toBe(0);

    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-imports-"));
    temporaryDirectories.push(fixture);
    fs.mkdirSync(path.join(fixture, "src", "runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture, "src", "runtime", "bad.ts"),
      'import { SessionManager } from "@earendil-works/pi-coding-agent";\n',
    );

    const rejected = spawnSync(process.execPath, [script, fixture], { encoding: "utf8" });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("src/runtime/bad.ts");
  });
});
