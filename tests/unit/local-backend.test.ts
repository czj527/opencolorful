import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exec, type ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PathGuardPolicy } from "../../src/contracts/sandbox.js";
import { LocalBackend } from "../../src/sandbox/local-backend.js";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

type ExecCallback = (
  error: NodeJS.ErrnoException | null,
  stdout: string,
  stderr: string,
) => void;

const execMock = vi.mocked(exec);

let workspace: string;
let backend: LocalBackend;

function configureExecResult(
  errorData: { readonly code: unknown; readonly killed?: boolean } | null,
  stdout = "",
  stderr = "",
): void {
  execMock.mockImplementation((
    ((
      _command: string,
      _options: unknown,
      callback: ExecCallback,
    ) => {
      const error = errorData === null
        ? null
        : Object.assign(new Error("command failed"), errorData) as unknown as NodeJS.ErrnoException;
      callback(error, stdout, stderr);
      return {} as ChildProcess;
    }) as typeof exec
  ));
}

function executeOptions(command: string): { readonly command: string; readonly cwd: string } {
  return { command, cwd: workspace };
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-local-backend-"));
  const policy: PathGuardPolicy = {
    rules: [
      {
        path: workspace + path.sep,
        level: "FULL",
        reason: "test workspace",
      },
    ],
    defaultLevel: "BLOCKED",
    allowExternalReads: false,
  };
  backend = new LocalBackend("test-agent", policy);
  execMock.mockReset();
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("LocalBackend.execute exit-code normalization", () => {
  it.each([
    ["integer number", 17, 17],
    ["integer string", "23", 23],
    ["negative integer", -7, -7],
    ["negative integer string", "-8", -8],
  ] as const)("preserves %s", async (_label, code, expectedExitCode) => {
    configureExecResult({ code }, "captured stdout", "captured stderr");

    const result = await backend.execute(executeOptions("echo allowed"));

    expect(result).toEqual({
      exitCode: expectedExitCode,
      stdout: "captured stdout",
      stderr: "captured stderr",
      timedOut: false,
    });
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["signal", null],
    ["non-numeric string", "SIGTERM"],
    ["undefined", undefined],
    ["fractional number", 1.5],
    ["NaN", Number.NaN],
  ] as const)("normalizes %s to 1", async (_label, code) => {
    configureExecResult({ code });

    const result = await backend.execute(executeOptions("echo allowed"));

    expect(result.exitCode).toBe(1);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("returns zero for a successful command", async () => {
    configureExecResult(null, "ok", "");

    const result = await backend.execute(executeOptions("echo allowed"));

    expect(result).toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    });
  });
});

describe("LocalBackend.execute sandbox gates", () => {
  it("does not invoke exec when preflight rejects a dangerous command", async () => {
    const result = await backend.execute(executeOptions("sudo whoami"));

    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("Sandbox preflight denied");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("does not invoke exec when an absolute path is outside the guarded workspace", async () => {
    const outsidePath = path.join(os.tmpdir(), "opencolorful-local-backend-outside", "output.txt");
    const result = await backend.execute(executeOptions(`echo "${outsidePath}"`));

    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("Sandbox path denied");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("invokes exec for a command whose absolute path is inside the workspace", async () => {
    const insidePath = path.join(workspace, "output.txt");
    configureExecResult({ code: "9" });

    const result = await backend.execute(executeOptions(`echo "${insidePath}"`));

    expect(result.exitCode).toBe(9);
    expect(execMock).toHaveBeenCalledTimes(1);
  });
});
