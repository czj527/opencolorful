import { describe, expect, it } from "vitest";

import {
  ACCESS_HIERARCHY,
  ACCESS_LEVELS,
  FILE_OPERATIONS,
  OPERATION_REQUIREMENTS,
  defaultSandboxCapabilities,
} from "../../src/contracts/sandbox.js";
import { defaultAgentSettings } from "../../src/contracts/agent-settings.js";
import { EVENT_TYPES } from "../../src/contracts/events.js";

describe("ACCESS_LEVELS", () => {
  it("defines exactly four levels in increasing order", () => {
    expect(ACCESS_LEVELS).toEqual(["BLOCKED", "READ_ONLY", "READ_WRITE", "FULL"]);
  });

  it("ACCESS_HIERARCHY follows level order", () => {
    expect(ACCESS_HIERARCHY.BLOCKED).toBe(0);
    expect(ACCESS_HIERARCHY.READ_ONLY).toBe(1);
    expect(ACCESS_HIERARCHY.READ_WRITE).toBe(2);
    expect(ACCESS_HIERARCHY.FULL).toBe(3);
  });

  it("ACCESS_HIERARCHY satisfies BLOCKED < READ_ONLY < READ_WRITE < FULL", () => {
    expect(ACCESS_HIERARCHY.BLOCKED).toBeLessThan(ACCESS_HIERARCHY.READ_ONLY);
    expect(ACCESS_HIERARCHY.READ_ONLY).toBeLessThan(ACCESS_HIERARCHY.READ_WRITE);
    expect(ACCESS_HIERARCHY.READ_WRITE).toBeLessThan(ACCESS_HIERARCHY.FULL);
  });
});

describe("FILE_OPERATIONS", () => {
  it("defines four file operations", () => {
    expect(FILE_OPERATIONS).toEqual(["read", "write", "delete", "exec"]);
  });

  it("read requires READ_ONLY", () => {
    expect(OPERATION_REQUIREMENTS.read).toBe("READ_ONLY");
  });

  it("write requires READ_WRITE", () => {
    expect(OPERATION_REQUIREMENTS.write).toBe("READ_WRITE");
  });

  it("delete requires FULL", () => {
    expect(OPERATION_REQUIREMENTS.delete).toBe("FULL");
  });

  it("exec requires READ_WRITE", () => {
    expect(OPERATION_REQUIREMENTS.exec).toBe("READ_WRITE");
  });

  it("every operation has a valid level", () => {
    for (const op of FILE_OPERATIONS) {
      expect(ACCESS_LEVELS).toContain(OPERATION_REQUIREMENTS[op]);
    }
  });
});

describe("defaultSandboxCapabilities", () => {
  it("returns workspaceAccess rw", () => {
    expect(defaultSandboxCapabilities().workspaceAccess).toBe("rw");
  });

  it("has default protected paths", () => {
    const c = defaultSandboxCapabilities();
    expect(c.protectedPaths).toContain(".env");
    expect(c.protectedPaths).toContain("secrets/");
    expect(c.protectedPaths).toContain("credentials/");
  });

  it("has empty extraReadPaths by default", () => {
    expect(defaultSandboxCapabilities().extraReadPaths).toEqual([]);
  });
});

describe("AgentSettings v2", () => {
  it("defaultAgentSettings returns version 2", () => {
    expect(defaultAgentSettings().version).toBe(2);
  });

  it("defaultAgentSettings has null defaultCwd", () => {
    expect(defaultAgentSettings().defaultCwd).toBeNull();
  });

  it("AgentSettings is a discriminated union accepting v2", () => {
    const v2 = defaultAgentSettings();
    expect(v2.version).toBe(2);
    expect(v2.defaultCwd).toBeNull();
    expect(typeof v2.updatedAt).toBe("string");
  });
});

describe("sandbox event types", () => {
  it("EVENT_TYPES includes sandbox.denied", () => {
    expect(EVENT_TYPES).toContain("sandbox.denied");
  });

  it("EVENT_TYPES includes sandbox.preflight-denied", () => {
    expect(EVENT_TYPES).toContain("sandbox.preflight-denied");
  });
});
