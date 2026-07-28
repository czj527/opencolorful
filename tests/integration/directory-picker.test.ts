import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";

import {
  WindowsFolderPicker,
  UnsupportedFolderPicker,
  createFolderPicker,
  type FolderPicker,
} from "../../src/platform/folder-picker.js";
import { registerDirectoryRoutes } from "../../src/server/routes/directories.js";

// 创建伪 spawn 函数模拟 child_process.spawn 返回的 proc
interface FakeSpawnOptions {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly error?: Error;
}

function createFakeSpawn(options: FakeSpawnOptions): {
  spawn: (cmd: string, args: readonly string[], opts: unknown) => ChildProcess;
  readonly calls: readonly { cmd: string; args: readonly string[] }[];
} {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const spawn = (cmd: string, args: readonly string[], _opts: unknown): ChildProcess => {
    calls.push({ cmd, args });
    const stdoutData: ((data: string) => void)[] = [];
    const stderrData: ((data: string) => void)[] = [];
    const closeHandlers: ((code: number | null) => void)[] = [];
    const errorHandlers: ((err: Error) => void)[] = [];

    const proc = {
      stdout: {
        on(event: string, handler: (data: string) => void) {
          if (event === "data") stdoutData.push(handler);
        },
      },
      stderr: {
        on(event: string, handler: (data: string) => void) {
          if (event === "data") stderrData.push(handler);
        },
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        if (event === "close") closeHandlers.push(handler as (code: number | null) => void);
        if (event === "error") errorHandlers.push(handler as (err: Error) => void);
      },
    };

    // 异步触发事件模拟真实 spawn 行为
    setTimeout(() => {
      if (options.error !== undefined) {
        for (const h of errorHandlers) h(options.error);
        return;
      }
      if (options.stdout !== undefined) for (const h of stdoutData) h(options.stdout);
      if (options.stderr !== undefined) for (const h of stderrData) h(options.stderr);
      for (const h of closeHandlers) h(options.code ?? 0);
    }, 0);

    return proc as unknown as ChildProcess;
  };
  return { spawn, calls };
}

describe("WindowsFolderPicker", () => {
  it("returns selected absolute path on OK", async () => {
    const { spawn } = createFakeSpawn({ stdout: "C:\\Users\\test\\projects" });
    const picker = new WindowsFolderPicker(spawn);
    const result = await picker.pickDirectory();
    expect(result.path).toBe("C:\\Users\\test\\projects");
    expect(result.cancelled).toBe(false);
  });

  it("returns cancelled when stdout is empty", async () => {
    const { spawn } = createFakeSpawn({ stdout: "" });
    const picker = new WindowsFolderPicker(spawn);
    const result = await picker.pickDirectory();
    expect(result.path).toBeNull();
    expect(result.cancelled).toBe(true);
  });

  it("trims whitespace and newlines from output", async () => {
    const { spawn } = createFakeSpawn({ stdout: "  C:\\path\\to\\dir  \n" });
    const picker = new WindowsFolderPicker(spawn);
    const result = await picker.pickDirectory();
    expect(result.path).toBe("C:\\path\\to\\dir");
  });

  it("rejects when spawn emits error", async () => {
    const { spawn } = createFakeSpawn({ error: new Error("ENOENT") });
    const picker = new WindowsFolderPicker(spawn);
    await expect(picker.pickDirectory()).rejects.toThrow("PowerShell 启动失败");
  });

  it("rejects when exit code non-zero", async () => {
    const { spawn } = createFakeSpawn({ code: 1, stderr: "syntax error" });
    const picker = new WindowsFolderPicker(spawn);
    await expect(picker.pickDirectory()).rejects.toThrow("PowerShell 退出码 1");
  });

  it("rejects non-absolute path", async () => {
    const { spawn } = createFakeSpawn({ stdout: "relative/path" });
    const picker = new WindowsFolderPicker(spawn);
    await expect(picker.pickDirectory()).rejects.toThrow("非绝对路径");
  });

  it("rejects path containing ..", async () => {
    const { spawn } = createFakeSpawn({ stdout: "C:\\users\\..\\admin" });
    const picker = new WindowsFolderPicker(spawn);
    await expect(picker.pickDirectory()).rejects.toThrow("..");
  });

  it("invokes powershell.exe with -STA and -Command flags", async () => {
    const { spawn, calls } = createFakeSpawn({ stdout: "" });
    const picker = new WindowsFolderPicker(spawn);
    await picker.pickDirectory();
    expect(calls[0]?.cmd).toBe("powershell.exe");
    expect(calls[0]?.args).toContain("-STA");
    expect(calls[0]?.args).toContain("-Command");
    expect(calls[0]?.args).toContain("-NoProfile");
  });
});

describe("UnsupportedFolderPicker", () => {
  it("throws on pickDirectory with platform hint", async () => {
    const picker = new UnsupportedFolderPicker("darwin");
    await expect(picker.pickDirectory()).rejects.toThrow("darwin");
    await expect(picker.pickDirectory()).rejects.toThrow("暂不支持");
  });

  it("includes linux in error", async () => {
    const picker = new UnsupportedFolderPicker("linux");
    await expect(picker.pickDirectory()).rejects.toThrow("linux");
  });
});

describe("createFolderPicker", () => {
  it("returns WindowsFolderPicker on win32", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const picker = createFolderPicker();
      expect(picker).toBeInstanceOf(WindowsFolderPicker);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  it("returns UnsupportedFolderPicker on darwin", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const picker = createFolderPicker();
      expect(picker).toBeInstanceOf(UnsupportedFolderPicker);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  it("returns UnsupportedFolderPicker on linux", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const picker = createFolderPicker();
      expect(picker).toBeInstanceOf(UnsupportedFolderPicker);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});

describe("registerDirectoryRoutes", () => {
  function createApp(picker: FolderPicker): Hono {
    const app = new Hono();
    registerDirectoryRoutes(app, picker);
    return app;
  }

  it("returns 200 with selected path", async () => {
    const fakePicker: FolderPicker = {
      async pickDirectory() {
        return { path: "C:\\selected", cancelled: false };
      },
    };
    const app = createApp(fakePicker);
    const res = await app.request("/api/directories/pick", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string | null; cancelled: boolean };
    expect(body).toEqual({ path: "C:\\selected", cancelled: false });
  });

  it("returns 200 with null path on cancel", async () => {
    const fakePicker: FolderPicker = {
      async pickDirectory() {
        return { path: null, cancelled: true };
      },
    };
    const app = createApp(fakePicker);
    const res = await app.request("/api/directories/pick", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string | null; cancelled: boolean };
    expect(body).toEqual({ path: null, cancelled: true });
  });

  it("returns 501 NOT_IMPLEMENTED for unsupported platform", async () => {
    const unsupportedPicker: FolderPicker = {
      async pickDirectory() {
        throw new Error("平台 darwin 暂不支持原生目录选择");
      },
    };
    const app = createApp(unsupportedPicker);
    const res = await app.request("/api/directories/pick", { method: "POST" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("NOT_IMPLEMENTED");
  });

  it("returns 500 INTERNAL_ERROR for other failures", async () => {
    const errorPicker: FolderPicker = {
      async pickDirectory() {
        throw new Error("PowerShell 退出码 1");
      },
    };
    const app = createApp(errorPicker);
    const res = await app.request("/api/directories/pick", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("INTERNAL_ERROR");
  });
});
