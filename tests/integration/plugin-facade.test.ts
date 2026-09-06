import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { PluginFacade } from "../../src/platform/plugin-facade.js";
import { PluginRegistryStore } from "../../src/storage/plugin-registry-store.js";
import { createServerApp } from "../../src/server/app.js";
import { createTrustedServerApp } from "../fixtures/trusted-app.js";

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
    const { app } = createTrustedServerApp({
      version: "0.1.0",
      pid: process.pid,
      startedAt: Date.now(),
      paths: fixture.paths,
      database: fixture.database,
      audit: fixture.audit,
      pluginFacade: facade,
    });
    const list = await app.request("http://127.0.0.1/api/plugins");
    expect(list.status).toBe(200);
    const body = await list.json() as Array<{ pluginId: string }>;
    expect(body.some((item) => item.pluginId === "example.route")).toBe(true);

    const inspect = await app.request("http://127.0.0.1/api/plugins/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceRef: { sourceType: "local", ref: pluginDir } }),
    });
    expect(inspect.status).toBe(200);
    const inspected = await inspect.json() as { pluginId: string };
    expect(inspected.pluginId).toBe("example.route");
  });

  it("enable 激活运行时、disable/uninstall 停用并清理（A1/C3 生命周期接线）", async () => {
    const fixture = makeFixture();
    const pluginDir = writeBundlePlugin(path.join(fixture.dir, "src"), "example.lifecycle", "Lifecycle", "1.0.0");
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await facade.install(
      { sourceType: "local", ref: pluginDir },
      [{ pluginId: "example.lifecycle", capability: "tool.register", decision: "allowed" as const }],
    );
    facade.bind("a1", "example.lifecycle", ["greet"]);
    expect(facade.get("example.lifecycle")?.status).toBe("installed");

    // enable → 运行时真正启动（bundle runtime status=running）
    await facade.enable("example.lifecycle");
    expect(facade.get("example.lifecycle")?.status).toBe("enabled");
    expect(facade.runtimeHost.getStatus("example.lifecycle")).toBe("running");

    // disable → 运行时停用（stopInstance 后实例从 map 移除）
    await facade.disable("example.lifecycle");
    expect(facade.get("example.lifecycle")?.status).toBe("disabled");
    expect(facade.runtimeHost.getStatus("example.lifecycle")).toBeUndefined();

    // uninstall → 停用 + 卸载 + 绑定清理
    await facade.uninstall("example.lifecycle");
    expect(facade.get("example.lifecycle")).toBeUndefined();
    expect(facade.listAgentBindings("a1")).toHaveLength(0);
  });

  it("安装失败（health check）不留授权残留（C2 原子性）", async () => {
    const fixture = makeFixture();
    const pluginDir = path.join(fixture.dir, "src", "example.bad");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
      manifestVersion: 1,
      id: "example.bad",
      name: "Bad",
      version: "1.0.0",
      compatibility: { opencolorful: ">=0.1.0", pluginApi: 1 },
      trust: "restricted",
      runtime: { kind: "python-process", entry: "missing.py" },
      permissions: [{ capability: "filesystem.write", reason: "写文件" }],
    }, null, 2));
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await expect(facade.install(
      { sourceType: "local", ref: pluginDir },
      [{ pluginId: "example.bad", capability: "filesystem.write", decision: "allowed" as const }],
    )).rejects.toThrow();
    expect(facade.list()).toHaveLength(0);
    // 授权也未残留（先装后授：安装失败时 grant 从未写入）
    const grantRows = fixture.database.prepare("SELECT * FROM plugin_grants WHERE plugin_id = ?").all("example.bad");
    expect(grantRows).toHaveLength(0);
  });

  it("recoverInterruptedOperations 终结崩溃遗留操作（C1 恢复）", async () => {
    const fixture = makeFixture();
    const pluginDir = writeBundlePlugin(path.join(fixture.dir, "src"), "example.recover", "Recover", "1.0.0");
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    // 模拟崩溃遗留：直接插入 started 操作行
    const registryStore = new PluginRegistryStore(fixture.database);
    registryStore.startOperation({
      operationId: "op-crash",
      pluginId: "example.recover",
      operation: "install",
      toVersion: "1.0.0",
    });
    facade.recoverInterruptedOperations();
    // started 行已终结为 failed → 后续安装不再被 PluginConflictError 锁死
    await facade.install(
      { sourceType: "local", ref: pluginDir },
      [{ pluginId: "example.recover", capability: "tool.register", decision: "allowed" as const }],
    );
    expect(facade.get("example.recover")?.version).toBe("1.0.0");
  });

  it("policy 接入 Phase 9 沙箱策略层（F4 sandboxCheck 注入）", async () => {
    const fixture = makeFixture();
    const pluginDir = writeBundlePlugin(path.join(fixture.dir, "src"), "example.sandbox", "Sandbox", "1.0.0");
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await facade.install(
      { sourceType: "local", ref: pluginDir },
      [{ pluginId: "example.sandbox", capability: "tool.register", decision: "allowed" as const }],
    );
    facade.bind("a1", "example.sandbox", ["greet"]);
    const resolution = facade.policy.resolveCapability({
      pluginId: "example.sandbox",
      agentId: "a1",
      capability: "tool.register",
      manifestPermissions: [{ capability: "tool.register" }],
    });
    expect(resolution.allowed).toBe(true);
    // evidence 含 sandbox 证明第 5 层（Phase 9 沙箱预检）已参与
    expect(resolution.evidence).toContain("sandbox");
  });

  it("getDetail 返回富字段（B1 契约）", async () => {
    const fixture = makeFixture();
    const pluginDir = writeBundlePlugin(path.join(fixture.dir, "src"), "example.detail", "Detail", "1.0.0");
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await facade.install(
      { sourceType: "local", ref: pluginDir },
      [{ pluginId: "example.detail", capability: "tool.register", decision: "allowed" as const }],
    );
    facade.bind("a1", "example.detail", ["greet"]);
    const detail = facade.getDetail("example.detail");
    expect(detail).toBeDefined();
    expect(detail?.name).toBe("Detail");
    expect(detail?.enabled).toBe(false);
    expect(detail?.grants).toHaveLength(1);
    expect(detail?.agentBindings).toHaveLength(1);
    expect(Array.isArray(detail?.secretStatus)).toBe(true);
    expect(Array.isArray(detail?.surfaces)).toBe(true);
    expect(detail?.runtime.health).toBe(false);
    expect(facade.getDetail("example.missing")).toBeUndefined();
  });

  it("来源搜索与 dev surface 端点接线（B2/B3）", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    const { app } = createTrustedServerApp({
      version: "0.1.0",
      pid: process.pid,
      startedAt: Date.now(),
      paths: fixture.paths,
      database: fixture.database,
      audit: fixture.audit,
      pluginFacade: facade,
    });
    // B2：来源搜索（local 来源无 baseDir → 空结果，端点 200）
    const search = await app.request("http://127.0.0.1/api/plugin-sources/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceType: "local", query: "" }),
    });
    expect(search.status).toBe(200);
    expect(await search.json()).toEqual([]);
    // B3：dev surface 列表与 describe-surface 端点存在（非 404）
    const surfaces = await app.request("http://127.0.0.1/api/plugins/dev/surfaces");
    expect(surfaces.status).toBe(200);
    const describe = await app.request("http://127.0.0.1/api/plugins/dev/unknown/describe-surface", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surfaceId: "x" }),
    });
    expect(describe.status).not.toBe(404);
  });

  it("安装授权校验：grant 对象与目标插件强绑定（P0-6）", async () => {
    const fixture = makeFixture();
    const pluginDir = writeBundlePlugin(path.join(fixture.dir, "src"), "example.guard", "Guard", "1.0.0");
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    const sourceRef = { sourceType: "local" as const, ref: pluginDir };
    // 携带其他插件的 grant → 拒绝
    await expect(facade.install(
      sourceRef,
      [{ pluginId: "other.plugin", capability: "tool.register", decision: "allowed" as const }],
    )).rejects.toThrow(/授权对象与安装插件不一致/);
    // 能力未在 Manifest 声明 → 拒绝
    await expect(facade.install(
      sourceRef,
      [{ pluginId: "example.guard", capability: "network.connect", decision: "allowed" as const }],
    )).rejects.toThrow(/授权能力未在插件 Manifest 中声明/);
    // 合法 grant 正常安装
    const installed = await facade.install(
      sourceRef,
      [{ pluginId: "example.guard", capability: "tool.register", decision: "allowed" as const }],
    );
    expect(installed.pluginId).toBe("example.guard");
  });

  it("插件资产读取与受控路径（P1 assets）", async () => {
    const fixture = makeFixture();
    const pluginDir = writeBundlePlugin(path.join(fixture.dir, "src"), "example.asset", "Asset", "1.0.0");
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await facade.install(
      { sourceType: "local", ref: pluginDir },
      [{ pluginId: "example.asset", capability: "tool.register", decision: "allowed" as const }],
    );
    const ok = facade.readPluginAsset("example.asset", "skills/hello.md");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.data.toString()).toContain("# Hello");
      expect(ok.contentType).toContain("text/plain");
    }
    // 穿越/空段/反斜杠拒绝
    expect(facade.readPluginAsset("example.asset", "../manifest.json").ok).toBe(false);
    expect(facade.readPluginAsset("example.asset", "skills/../manifest.json").ok).toBe(false);
    expect(facade.readPluginAsset("example.asset", "skills\\hello.md").ok).toBe(false);
    expect(facade.readPluginAsset("example.missing", "skills/hello.md").ok).toBe(false);
  });

  it("资产与 Secret HTTP 端点接线（P1 routes）", async () => {
    const fixture = makeFixture();
    const pluginDir = writeBundlePlugin(path.join(fixture.dir, "src"), "example.routes2", "Routes2", "1.0.0");
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    await facade.install(
      { sourceType: "local", ref: pluginDir },
      [{ pluginId: "example.routes2", capability: "tool.register", decision: "allowed" as const }],
    );
    const { app } = createTrustedServerApp({
      version: "0.1.0",
      pid: process.pid,
      startedAt: Date.now(),
      paths: fixture.paths,
      database: fixture.database,
      audit: fixture.audit,
      pluginFacade: facade,
    });
    const asset = await app.request("http://127.0.0.1/api/plugins/example.routes2/assets/skills/hello.md");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("# Hello");
    // URL 规范在客户端就把 .. 解析掉（404 或 400 都代表拒绝；facade 层另有穿越断言）
    const escape = await app.request("http://127.0.0.1/api/plugins/example.routes2/assets/../manifest.json");
    expect([400, 404]).toContain(escape.status);
    // Secret 写入 + 落盘（listSecretNames 反映激活时声明的 Secret 名，用 hasSecret 验证 store 值）
    const saved = await app.request("http://127.0.0.1/api/plugins/example.routes2/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secretName: "api-key", value: "sk-test-123" }),
    });
    expect(saved.status).toBe(200);
    expect(facade.hostApi.secrets.hasSecret("example.routes2", "api-key")).toBe(true);
    expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_name LIKE 'audit.plugin.secret_change_%'").get()).toMatchObject({ n: 2 });
    const removed = await app.request("http://127.0.0.1/api/plugins/example.routes2/secrets/api-key", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(facade.hostApi.secrets.hasSecret("example.routes2", "api-key")).toBe(false);
  });
});
