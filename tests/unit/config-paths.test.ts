import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { loadEnvironment } from "../../src/config/environment.js";
import { createApiError, isApiError, toApiError } from "../../src/contracts/api-error.js";

describe("runtime paths", () => {
  it("uses the home directory by default", () => {
    const paths = getRuntimePaths({});

    expect(paths.home).toBe(path.join(os.homedir(), ".opencolorful"));
    expect(paths.config).toBe(path.join(paths.home, "config"));
    expect(paths.auth).toBe(path.join(paths.home, "auth"));
    expect(paths.sessions).toBe(path.join(paths.home, "sessions"));
    expect(paths.database).toBe(path.join(paths.home, "metadata.sqlite"));
  });

  it("Phase 12: exposes all plugin directories under OPENCOLORFUL_HOME", () => {
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: "D:\opencolorful-plugins" });

    expect(paths.pluginsInstalled).toBe(path.join(paths.home, "plugins", "installed"));
    expect(paths.pluginsStaging).toBe(path.join(paths.home, "plugins", "staging"));
    expect(paths.pluginsData).toBe(path.join(paths.home, "plugins", "data"));
    expect(paths.pluginsCache).toBe(path.join(paths.home, "plugins", "cache"));
    expect(paths.pluginsDev).toBe(path.join(paths.home, "plugins-dev"));
    expect(paths.pluginDevSources).toBe(path.join(paths.home, "plugin-dev-sources"));
    expect(paths.pluginSources).toBe(path.join(paths.home, "config", "plugin-sources.json"));
    expect(paths.pluginSecrets).toBe(path.join(paths.home, "auth", "plugin-secrets.json"));
  });

  it("uses a non-empty OPENCOLORFUL_HOME override", () => {
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: "D:\\opencolorful-test" });

    expect(paths.home).toBe(path.resolve("D:\\opencolorful-test"));
    expect(paths.serverState).toBe(path.join(paths.home, "runtime", "server.json"));
    expect(paths.providerSettings).toBe(path.join(paths.home, "config", "providers.json"));
  });

  it("ignores blank home overrides", () => {
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: "   " });

    expect(paths.home).toBe(path.join(os.homedir(), ".opencolorful"));
  });
});

describe("environment fallback", () => {
  it("parses host, port, and log level without provider credentials", () => {
    expect(
      loadEnvironment({
        OPENCOLORFUL_HOST: "0.0.0.0",
        OPENCOLORFUL_PORT: "4312",
        OPENCOLORFUL_LOG_LEVEL: "debug",
      }),
    ).toMatchObject({ host: "0.0.0.0", port: 4312, logLevel: "debug" });
  });

  it("rejects invalid ports", () => {
    expect(() => loadEnvironment({ OPENCOLORFUL_PORT: "70000" })).toThrow("OPENCOLORFUL_PORT");
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
