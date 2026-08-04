import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { PluginFacade } from "../../src/platform/plugin-facade.js";
import { createServerApp } from "../../src/server/app.js";

const temporaryDirectories: string[] = [];
const openDatabases: Array<import("better-sqlite3").Database> = [];

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-facade-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const audit = new AuditRecorder({
    database,
    producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot", appVersion: "0.1.0", hostPlatform: process.platform },
  });
  return { dir, paths, database, audit };
}

function writeBundlePlugin(dir: string, id: string, name: string, version: string): string {
  const pluginDir = path.join(dir, id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
    manifestVersion: 1,
    id,
    name,
    version,
    description: "组合根测试插件",
    compatibility: { opencolorful: ">=0.1.0", pluginApi: 1 },
    trust: "restricted",
    runtime: { kind: "bundle" },
    permissions: [{ capability: "tool.register", reason: "注册工具" }],
    contributions: {
      tool: [{ id: "greet", name: "Greet", description: "问候", riskLevel: "low" }],
      "skill-bundle": [{ id: "skills", name: "技能目录", skillsDir: "skills" }],
    },
  }, null, 2));
  fs.mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "skills", "hello.md"), "# Hello\n");
  return pluginDir;
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("Phase 12 组合根 PluginFacade（T10 接线）", () => {
  it("装配全部插件服务并 inspect/install 本地 bundle 插件", async () => {
    const fixture = makeFixture();
    const pluginDir = writeBundlePlugin(path.join(fixture.dir, "src"), "example.greet", "Greet", "1.0.0");
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });

    const sourceRef = { sourceType: "local" as const, ref: pluginDir };
    const inspected = facade.inspect(sourceRef);
    expect(inspected.pluginId).toBe("example.greet");
    expect(inspected.compatibility.supported).toBe(true);
    expect(inspected.compatibility.contributions.some((c) => c.kind === "tool" && c.status === "supported")).toBe(true);

    const installed = await facade.install(sourceRef, [
      { pluginId: "example.greet", capability: "tool.register", decision: "allowed" as const, reason: "安装授权" },
    ]);
    expect(installed.pluginId).toBe("example.greet");
    expect(installed.version).toBe("1.0.0");

    const listed = facade.list();
    expect(listed.some((record) => record.pluginId === "example.greet")).toBe(true);
    expect(facade.get("example.greet")?.status).toBe("installed");
  });

  it("grant 未配置审计时安装 fail-closed", async () => {
    const fixture = makeFixture();
    const pluginDir = writeBundlePlugin(path.join(fixture.dir, "src2"), "example.fail", "Fail", "1.0.0");
    const closedDb = openMetadataDatabase(path.join(fixture.dir, "closed.db"));
    closedDb.close();
    const brokenAudit = new AuditRecorder({
      database: closedDb,
      producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot", appVersion: "0.1.0", hostPlatform: process.platform },
    });
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: brokenAudit,
      hostVersion: "0.1.0",
    });
    await expect(facade.install(
      { sourceType: "local", ref: pluginDir },
      [{ pluginId: "example.fail", capability: "tool.register", decision: "allowed" as const }],
    )).rejects.toThrow();
    expect(facade.list()).toHaveLength(0);
  });

  it("bind/unbind Agent 插件绑定", async () => {
    const fixture = makeFixture();
    const pluginDir = writeBundlePlugin(path.join(fixture.dir, "src3"), "example.bind", "Bind", "1.0.0");
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await facade.install(
      { sourceType: "local", ref: pluginDir },
      [{ pluginId: "example.bind", capability: "tool.register", decision: "allowed" as const }],
    );
    facade.bind("a1", "example.bind", ["greet"]);
    const bindings = facade.listAgentBindings("a1");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.pluginId).toBe("example.bind");
    expect(bindings[0]?.contributions).toContain("greet");
    facade.unbind("a1", "example.bind");
    expect(facade.listAgentBindings("a1")).toHaveLength(0);
  });

  it("HTTP 路由：/api/plugins 列表与 inspect 端点接线", async () => {
    const fixture = makeFixture();
    const pluginDir = writeBundlePlugin(path.join(fixture.dir, "src4"), "example.route", "Route", "1.0.0");
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await facade.install(
      { sourceType: "local", ref: pluginDir },
      [{ pluginId: "example.route", capability: "tool.register", decision: "allowed" as const }],
    );
    const { app } = createServerApp({
      version: "0.1.0",
      pid: process.pid,
      startedAt: Date.now(),
      paths: fixture.paths,
      database: fixture.database,
      audit: fixture.audit,
      pluginFacade: facade,
    });
    const list = await app.request("http://local/api/plugins");
    expect(list.status).toBe(200);
    const body = await list.json() as Array<{ pluginId: string }>;
    expect(body.some((item) => item.pluginId === "example.route")).toBe(true);

    const inspect = await app.request("http://local/api/plugins/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceRef: { sourceType: "local", ref: pluginDir } }),
    });
    expect(inspect.status).toBe(200);
    const inspected = await inspect.json() as { pluginId: string };
    expect(inspected.pluginId).toBe("example.route");
  });
});
