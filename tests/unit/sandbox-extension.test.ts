import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  validateSandboxExtensionLoadResult,
} from "../../src/pi-sdk/agent-session.js";
import sandboxExtension, {
  registerSandboxContext,
  runWithSandboxContext,
  type SandboxContext,
} from "../../src/pi-sdk/sandbox-extension.js";
import { ToolPolicy } from "../../src/runtime/tool-policy.js";
import { PathGuard } from "../../src/sandbox/path-guard.js";

interface RegisteredTool {
  readonly name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate?: (update: unknown) => void,
    executionContext?: unknown,
  ): Promise<unknown>;
}

const tempDirectories: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-sandbox-extension-"));
  tempDirectories.push(dir);
  return dir;
}

function registerTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(tool: unknown) {
      const registered = tool as RegisteredTool;
      tools.set(registered.name, registered);
    },
  };
  sandboxExtension(api as never);
  return tools;
}

function tool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
  const registered = tools.get(name);
  if (!registered) throw new Error(`Missing registered tool: ${name}`);
  return registered;
}

function fullWorkspacePolicy(workspace: string): ToolPolicy {
  const policy = new ToolPolicy();
  policy.setPathGuard(
    new PathGuard({
      rules: [
        {
          path: workspace + path.sep,
          level: "FULL",
          reason: "test workspace",
        },
      ],
      defaultLevel: "BLOCKED",
      allowExternalReads: false,
    }),
  );
  return policy;
}

function execute(
  registered: RegisteredTool,
  params: Record<string, unknown>,
  executionContext?: unknown,
): Promise<unknown> {
  return registered.execute(
    "tool-call",
    params,
    new AbortController().signal,
    undefined,
    executionContext,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sandbox extension loading", () => {
  it("accepts exactly one successfully loaded extension", async () => {
    const extensionPath = path.resolve(
      process.cwd(),
      "src",
      "pi-sdk",
      "sandbox-extension.ts",
    );
    const result = await discoverAndLoadExtensions(
      [extensionPath],
      process.cwd(),
    );

    expect(() => validateSandboxExtensionLoadResult(result)).not.toThrow();
    expect(result.errors).toHaveLength(0);
    expect(result.extensions).toHaveLength(1);
  });

  it("fails closed when extension loading reports an error", () => {
    expect(() =>
      validateSandboxExtensionLoadResult({
        errors: [{ path: "sandbox-extension.ts", error: "load failed" }],
        extensions: [],
      }),
    ).toThrow("Sandbox extension failed to load");
  });

  it.each([0, 2])("fails closed when extension count is %i", (count) => {
    expect(() =>
      validateSandboxExtensionLoadResult({
        errors: [],
        extensions: Array.from({ length: count }, () => ({})),
      }),
    ).toThrow("Sandbox extension count mismatch");
  });
});

describe("sandbox extension tool wrapping", () => {
  it("registers every built-in tool behind the sandbox extension", () => {
    const tools = registerTools();
    expect([...tools.keys()].sort()).toEqual(
      ["bash", "edit", "find", "grep", "ls", "read", "write"].sort(),
    );
  });

  it("fails closed when a tool executes without Session context", async () => {
    const read = tool(registerTools(), "read");
    await expect(execute(read, { path: "file.txt" })).rejects.toThrow(
      "session context missing",
    );
  });

  it("resolves production context from the PI Session id without AsyncLocalStorage", async () => {
    const read = tool(registerTools(), "read");
    const workspace = tempDir();
    fs.writeFileSync(path.join(workspace, "registered.txt"), "registered-session");
    const context: SandboxContext = {
      toolPolicy: fullWorkspacePolicy(workspace),
      sessionCwd: workspace,
      allowBash: false,
    };
    const executionContext = {
      sessionManager: {
        getSessionId: () => "registered-session-id",
      },
    };
    const unregister = registerSandboxContext("registered-session-id", context);

    try {
      const result = await execute(read, { path: "registered.txt" }, executionContext);
      expect(JSON.stringify(result)).toContain("registered-session");
    } finally {
      unregister();
    }

    await expect(
      execute(read, { path: "registered.txt" }, executionContext),
    ).rejects.toThrow("session context missing");
  });

  it("guards all file tools with Session-relative absolute paths", async () => {
    const tools = registerTools();
    const workspace = tempDir();
    const assertFilePath = vi.fn(() => {
      throw new Error("guard-stop");
    });
    const policy = {
      assertFilePath,
      recordBashDenied: vi.fn(),
    } as unknown as ToolPolicy;
    const context: SandboxContext = {
      toolPolicy: policy,
      sessionCwd: workspace,
      allowBash: false,
    };
    const cases = [
      ["read", "read"],
      ["write", "write"],
      ["edit", "write"],
      ["grep", "read"],
      ["find", "read"],
      ["ls", "read"],
    ] as const;

    for (const [name, operation] of cases) {
      await expect(
        runWithSandboxContext(context, () =>
          execute(tool(tools, name), { path: "nested/file.txt" }),
        ),
      ).rejects.toThrow("guard-stop");
      expect(assertFilePath).toHaveBeenLastCalledWith(
        operation,
        path.resolve(workspace, "nested/file.txt"),
      );
    }
  });

  it("uses sessionCwd when a directory tool receives an empty path", async () => {
    const ls = tool(registerTools(), "ls");
    const workspace = tempDir();
    const assertFilePath = vi.fn(() => {
      throw new Error("guard-stop");
    });
    const context: SandboxContext = {
      toolPolicy: { assertFilePath } as unknown as ToolPolicy,
      sessionCwd: workspace,
      allowBash: false,
    };

    await expect(
      runWithSandboxContext(context, () => execute(ls, {})),
    ).rejects.toThrow("guard-stop");
    expect(assertFilePath).toHaveBeenCalledWith("read", workspace);
  });

  it("keeps concurrent Session contexts isolated", async () => {
    const read = tool(registerTools(), "read");
    const workspaceA = tempDir();
    const workspaceB = tempDir();
    fs.writeFileSync(path.join(workspaceA, "same.txt"), "alpha-session");
    fs.writeFileSync(path.join(workspaceB, "same.txt"), "beta-session");
    const contextA: SandboxContext = {
      toolPolicy: fullWorkspacePolicy(workspaceA),
      sessionCwd: workspaceA,
      allowBash: false,
    };
    const contextB: SandboxContext = {
      toolPolicy: fullWorkspacePolicy(workspaceB),
      sessionCwd: workspaceB,
      allowBash: false,
    };

    const [resultA, resultB] = await Promise.all([
      runWithSandboxContext(contextA, () => execute(read, { path: "same.txt" })),
      runWithSandboxContext(contextB, () => execute(read, { path: "same.txt" })),
    ]);

    expect(JSON.stringify(resultA)).toContain("alpha-session");
    expect(JSON.stringify(resultA)).not.toContain("beta-session");
    expect(JSON.stringify(resultB)).toContain("beta-session");
    expect(JSON.stringify(resultB)).not.toContain("alpha-session");
  });

  it("blocks bash and records the disabled reason", async () => {
    const bash = tool(registerTools(), "bash");
    const recordBashDenied = vi.fn();
    const context: SandboxContext = {
      toolPolicy: { recordBashDenied } as unknown as ToolPolicy,
      sessionCwd: tempDir(),
      allowBash: false,
    };

    await expect(
      runWithSandboxContext(context, () =>
        execute(bash, { command: "echo should-not-run" }),
      ),
    ).rejects.toThrow("bash is disabled");
    expect(recordBashDenied).toHaveBeenCalledWith(
      "echo should-not-run",
      "bash-disabled",
    );
  });
});
