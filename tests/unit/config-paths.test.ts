import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { loadEnvironment } from "../../src/config/environment.js";
import { createApiError, isApiError, toApiError } from "../../src/contracts/api-error.js";

describe("runtime paths", () => {
  it("uses the home directory by default", () => {
    const paths = getRuntimePaths({});

    expect(paths.home).toBe(path.join(os.homedir(), ".person-agent"));
    expect(paths.config).toBe(path.join(paths.home, "config"));
    expect(paths.auth).toBe(path.join(paths.home, "auth"));
    expect(paths.sessions).toBe(path.join(paths.home, "sessions"));
    expect(paths.database).toBe(path.join(paths.home, "metadata.sqlite"));
  });

  it("uses a non-empty PERSON_AGENT_HOME override", () => {
    const paths = getRuntimePaths({ PERSON_AGENT_HOME: "D:\\person-agent-test" });

    expect(paths.home).toBe(path.resolve("D:\\person-agent-test"));
    expect(paths.serverState).toBe(path.join(paths.home, "runtime", "server.json"));
    expect(paths.providerSettings).toBe(path.join(paths.home, "config", "providers.json"));
  });

  it("ignores blank home overrides", () => {
    const paths = getRuntimePaths({ PERSON_AGENT_HOME: "   " });

    expect(paths.home).toBe(path.join(os.homedir(), ".person-agent"));
  });
});

describe("environment fallback", () => {
  it("parses host, port, and log level without provider credentials", () => {
    expect(
      loadEnvironment({
        PERSON_AGENT_HOST: "0.0.0.0",
        PERSON_AGENT_PORT: "4312",
        PERSON_AGENT_LOG_LEVEL: "debug",
      }),
    ).toMatchObject({ host: "0.0.0.0", port: 4312, logLevel: "debug" });
  });

  it("rejects invalid ports", () => {
    expect(() => loadEnvironment({ PERSON_AGENT_PORT: "70000" })).toThrow("PERSON_AGENT_PORT");
  });
});

describe("API errors", () => {
  it("creates a stable serializable error shape", () => {
    const error = createApiError("INVALID_INPUT", "输入无效", false, { field: "port" });

    expect(error).toEqual({
      code: "INVALID_INPUT",
      message: "输入无效",
      retryable: false,
      details: { field: "port" },
    });
    expect(isApiError(error)).toBe(true);
  });

  it("normalizes unknown thrown values", () => {
    expect(toApiError(new Error("boom"))).toEqual({
      code: "INTERNAL_ERROR",
      message: "boom",
      retryable: false,
    });
  });
});
