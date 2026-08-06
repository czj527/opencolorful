import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSkillsCommand } from "../../../src/cli/commands/skills.js";
import { SkillError } from "../../../src/runtime/skills/errors.js";
import { computeSkillContentHash } from "../../../src/runtime/skills/hash.js";
import { validateSkillPackage } from "../../../src/runtime/skills/validator.js";
import { createSkillPackage, rmrf, tmpDir } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 CLI skills 命令测试（plans/phase-13.md §14.3 / §18.6）
//
// - HTTP 命令（list/search/inspect/install/doctor 的 Server 部分）用
//   stubGlobal("fetch") mock Server，验证请求路径/载荷与输出；
// - 纯本地命令（validate/pack/init/link/unlink）走真实文件系统；
// - 事实来源承诺：CLI 只发 HTTP 请求，不自行实现安装/校验逻辑。
// ═══════════════════════════════════════════════════════════════

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  return init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
}

/** 记录请求并逐个端点返回（未匹配 → 500 空对象）。 */
function stubServer(records: FetchCall[], handler: (call: FetchCall) => Response | null): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const call: FetchCall = {
        url: String(input),
        method: init?.method ?? "GET",
        body: jsonBody(init),
      };
      records.push(call);
      return handler(call) ?? jsonResponse({ message: "未匹配 mock" }, 500);
    }),
  );
}

let home: string;
let workdir: string;
let previousCwd: string;

beforeEach(() => {
  home = tmpDir("ocf-cli-home-");
  workdir = tmpDir("ocf-cli-work-");
  previousCwd = process.cwd();
  process.env.OPENCOLORFUL_HOME = home;
  process.env.OPENCOLORFUL_PORT = "4310";
  process.chdir(workdir);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "table").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.OPENCOLORFUL_HOME;
  delete process.env.OPENCOLORFUL_PORT;
  process.chdir(previousCwd);
  rmrf(home);
  rmrf(workdir);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function logsOf(spy: ReturnType<typeof vi.spyOn>): string {
  return JSON.stringify(spy.mock.calls.flat());
}

describe("skills list / search / inspect（HTTP 命令）", () => {
  it("list 经 GET /api/skills 输出状态四元组与统计", async () => {
    const calls: FetchCall[] = [];
    stubServer(calls, (call) => {
      if (call.url.endsWith("/api/skills") && call.method === "GET") {
        return jsonResponse([
          {
            displayName: "Alpha Skill",
            skillId: "alpha-skill",
            sourceKind: "managed",
            sourceId: "C:\\store\\alpha-skill",
            version: "1.0.0",
            contentHash: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            status: { validity: "valid", trust: "trusted", readiness: "ready", selection: "implicit" },
          },
          {
            displayName: "Blocked Skill",
            skillId: "blocked-skill",
            sourceKind: "workspace",
            sourceId: "ws",
            version: "0.1.0",
            contentHash: "sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            status: { validity: "valid", trust: "untrusted", readiness: "blocked", selection: "shadowed", blockedReason: "skill_readiness_blocked" },
          },
        ]);
      }
      return null;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const table = vi.spyOn(console, "table").mockImplementation(() => {});
    await runSkillsCommand(["list"]);
    const text = logsOf(log);
    expect(table.mock.calls.length).toBe(1);
    const rows = table.mock.calls[0]?.[0] as readonly Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Alpha Skill", validity: "valid", readiness: "ready" });
    expect(rows[1]).toMatchObject({ readiness: "blocked", blockedReason: "skill_readiness_blocked" });
    expect(text).toContain("readiness: ready=1, blocked=1");
    expect(text).toContain("selection: implicit=1, shadowed=1");
    expect(calls.some((call) => call.url.endsWith("/api/skills"))).toBe(true);
  });

  it("list 空 Catalog 时明确提示（不静默成功）", async () => {
    stubServer([], (call) => (call.url.endsWith("/api/skills") ? jsonResponse([]) : null));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSkillsCommand(["list"]);
    expect(logsOf(log)).toContain("Catalog 为空");
  });

  it("search 经 POST /api/skills/search 输出命中/诊断/remote", async () => {
    const calls: FetchCall[] = [];
    stubServer(calls, (call) => {
      if (call.url.endsWith("/api/skills/search") && call.method === "POST") {
        const body = call.body as { query?: string; scope?: string };
        expect(body.query).toBe("demo");
        expect(body.scope).toBe("all");
        return jsonResponse({
          layers: ["managed", "plugin"],
          hits: [
            {
              layer: "managed",
              displayName: "Demo Skill",
              skillId: "demo-skill",
              sourceId: "C:\\store\\demo-skill",
              version: "1.0.0",
              sourceKind: "managed",
              contentHash: "sha256-ccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
              readiness: "ready",
              bindable: true,
            },
          ],
          diagnostics: [{ code: "skill_source_unsupported", message: "远程来源搜索在 T9 接入" }],
          remote: { available: false, note: "远程不可用" },
        });
      }
      return null;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runSkillsCommand(["search", "demo"]);
    const text = logsOf(log);
    expect(text).toContain("Demo Skill");
    expect(text).toContain("[managed]");
    expect(text).toContain("bindable=是");
    expect(logsOf(warn)).toContain("skill_source_unsupported");
    expect(text).toContain("远程不可用");
    expect(text).toContain("命中 1 项");
  });

  it("search 缺少查询词时拒绝", async () => {
    await expect(runSkillsCommand(["search"])).rejects.toThrow(/缺少搜索词/);
  });

  it("inspect 经 POST /api/skills/inspect 输出结构化结果", async () => {
    const calls: FetchCall[] = [];
    stubServer(calls, (call) => {
      if (call.url.endsWith("/api/skills/inspect") && call.method === "POST") {
        const body = call.body as { sourceRef?: string; kind?: string };
        expect(body.sourceRef).toBe("C:\\tmp\\demo");
        expect(body.kind).toBe("local");
        return jsonResponse({
          ok: true,
          sourceRef: "C:\\tmp\\demo",
          skillId: "demo-skill",
          version: "1.0.0",
          contentHash: "sha256-ddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          manifest: { name: "Demo Skill", risk: "low" },
          risks: [],
        });
      }
      return null;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSkillsCommand(["inspect", "C:\\tmp\\demo"]);
    const printed = String(log.mock.calls[0]?.[0] ?? "");
    expect(printed).toContain('"name": "Demo Skill"');
    expect(printed).toContain('"version": "1.0.0"');
    expect(printed).toContain('"ok": true');
  });
});

describe("skills install（高风险显式确认；与 Server 单一事实）", () => {
  it("confirmation_required + --yes：approve 后带令牌重试安装", async () => {
    const calls: FetchCall[] = [];
    stubServer(calls, (call) => {
      if (call.url.endsWith("/api/skills/install") && call.method === "POST") {
        const body = call.body as { confirmationToken?: string };
        if (body.confirmationToken === undefined) {
          return jsonResponse(
            {
              status: "confirmation_required",
              loadHandle: null,
              confirmation: {
                token: "ct-1",
                expiresAt: "2026-01-01T00:15:00.000Z",
                operationType: "install",
                reason: "来源未被信任，需要用户确认后才能安装",
                riskLevel: "high",
              },
              risks: [{ code: "scripts", message: "包含 scripts/ 目录" }],
            },
            202,
          );
        }
        return jsonResponse(
          {
            status: "installed",
            skillRef: { skillId: "demo-skill", sourceId: "C:\\store\\demo-skill", sourceKind: "managed", version: "1.0.0", contentHash: "sha256-e" },
            operationId: "skill-install-1",
            agentBinding: "bound",
            activationGrant: "granted",
            loadHandle: "load-1",
          },
          201,
        );
      }
      if (call.url.includes("/api/skills/confirmation/") && call.url.endsWith("/approve") && call.method === "POST") {
        expect(call.url).toContain(encodeURIComponent("ct-1"));
        return jsonResponse({ status: "approved" });
      }
      return null;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSkillsCommand(["install", "C:\\tmp\\demo", "--yes"]);
    const installCalls = calls.filter((call) => call.url.endsWith("/api/skills/install"));
    expect(installCalls).toHaveLength(2);
    expect((installCalls[1]?.body as { confirmationToken?: string }).confirmationToken).toBe("ct-1");
    expect(calls.some((call) => call.url.endsWith("/approve"))).toBe(true);
    const text = logsOf(log);
    expect(text).toContain("安装完成");
    expect(text).toContain("skill-install-1");
    expect(text).toContain("activationGrant：granted");
    expect(text).toContain("load-1");
  });

  it("confirmation_required 且非交互终端未给 --yes：拒绝且不调用 approve", async () => {
    const calls: FetchCall[] = [];
    stubServer(calls, (call) => {
      if (call.url.endsWith("/api/skills/install") && call.method === "POST") {
        return jsonResponse(
          {
            status: "confirmation_required",
            loadHandle: null,
            confirmation: { token: "ct-2", expiresAt: "x", operationType: "install", reason: "需要确认" },
            risks: [],
          },
          202,
        );
      }
      return null;
    });
    await expect(runSkillsCommand(["install", "C:\\tmp\\demo"])).rejects.toThrow(/非交互终端.*--yes/s);
    expect(calls.some((call) => call.url.endsWith("/approve"))).toBe(false);
    expect(calls.filter((call) => call.url.endsWith("/api/skills/install"))).toHaveLength(1);
  });

  it("HTTP 400 失败 → SkillError 携带稳定 reasonCode", async () => {
    stubServer([], (call) => {
      if (call.url.endsWith("/api/skills/install") && call.method === "POST") {
        return jsonResponse(
          { message: "安装失败", details: { reasonCode: "skill_package_invalid", reason: "包损坏" } },
          400,
        );
      }
      return null;
    });
    const error = await runSkillsCommand(["install", "C:\\tmp\\bad", "--yes"]).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SkillError);
    expect((error as SkillError).code).toBe("skill_package_invalid");
    expect((error as Error).message).toContain("包损坏");
  });
});

describe("skills validate / pack / init（纯本地文件操作）", () => {
  it("validate 通过并输出内容哈希（与 T2 validator 同源；--version 参与哈希）", async () => {
    const dir = createSkillPackage(workdir, { name: "cli-validate", version: "1.0.0" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSkillsCommand(["validate", dir, "--version", "1.0.0"]);
    const text = logsOf(log);
    expect(text).toContain("通过");
    const expected = validateSkillPackage({ packageRoot: dir, version: "1.0.0" });
    expect(expected.contentHash).toBeTruthy();
    expect(text).toContain(expected.contentHash as string);
    expect(text).toContain("cli-validate");
  });

  it("validate 失败：明确错误 + 抛错（fail-closed）", async () => {
    const bad = path.join(workdir, "not-a-skill");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "readme.txt"), "没有 SKILL.md", "utf8");
    await expect(runSkillsCommand(["validate", bad])).rejects.toThrow(/校验失败/);
  });

  it("pack 生成 .skill 且内容哈希与 validate 一致；非法输出扩展名拒绝", async () => {
    const dir = createSkillPackage(workdir, { name: "cli-pack", version: "2.0.0" });
    const out = path.join(workdir, "out", "cli-pack-2.0.0.skill");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSkillsCommand(["pack", dir, "--out", out]);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
    const text = logsOf(log);
    expect(text).toContain("打包完成");
    const expectedHash = computeSkillContentHash(dir, { version: "2.0.0", exclude: [".git"] });
    expect(text).toContain(expectedHash);
    await expect(runSkillsCommand(["pack", dir, "--out", "out.txt"])).rejects.toThrow(/\.zip 或 \.skill/);
  });

  it("init 生成标准目录 + 最小 SKILL.md；目录已存在时拒绝", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSkillsCommand(["init", "my-skill"]);
    const root = path.join(workdir, "my-skill");
    expect(fs.existsSync(path.join(root, "SKILL.md"))).toBe(true);
    expect(fs.statSync(path.join(root, "references")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(root, "templates")).isDirectory()).toBe(true);
    const source = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
    expect(source).toContain("name: my-skill");
    expect(source).toContain("metadata:");
    expect(logsOf(log)).toContain("已创建 Skill 目录");
    await expect(runSkillsCommand(["init", "my-skill"])).rejects.toThrow(/目录已存在/);
  });
});

describe("skills link / unlink（Linked Source 只读登记）", () => {
  function registryFile(): string {
    return path.join(home, "skill-dev-sources", "sources.json");
  }

  it("link 登记到 skill-dev-sources/sources.json（不复制到 Managed Store）", async () => {
    const dir = createSkillPackage(workdir, { name: "linked-demo", version: "1.0.0" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSkillsCommand(["link", dir]);
    expect(fs.existsSync(registryFile())).toBe(true);
    const document = JSON.parse(fs.readFileSync(registryFile(), "utf8")) as {
      linkedSources: readonly { sourceId: string; rootPath: string }[];
    };
    expect(document.linkedSources).toHaveLength(1);
    expect(document.linkedSources[0]?.sourceId).toBe("linked-linked-demo");
    expect(path.resolve(document.linkedSources[0]?.rootPath ?? "")).toBe(path.resolve(dir));
    // Linked Source 只读引用：Managed Store 目录下不得出现该包的拷贝
    expect(fs.existsSync(path.join(home, "skills", "installed"))).toBe(false);
    const text = logsOf(log);
    expect(text).toContain("已登记 Linked Source");
    expect(text).toContain("只读引用");
  });

  it("同一路径重复 link → skill_already_installed（fail-closed）", async () => {
    const dir = createSkillPackage(workdir, { name: "dup-link", version: "1.0.0" });
    await runSkillsCommand(["link", dir]);
    const error = await runSkillsCommand(["link", dir]).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SkillError);
    expect((error as SkillError).code).toBe("skill_already_installed");
  });

  it("link 无 SKILL.md 的目录 → skill_not_a_complete_package", async () => {
    const bare = path.join(workdir, "bare-dir");
    fs.mkdirSync(bare, { recursive: true });
    const error = await runSkillsCommand(["link", bare]).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SkillError);
    expect((error as SkillError).code).toBe("skill_not_a_complete_package");
  });

  it("unlink 注销登记；未知 sourceId → skill_source_not_found", async () => {
    const dir = createSkillPackage(workdir, { name: "unlink-demo", version: "1.0.0" });
    await runSkillsCommand(["link", dir]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSkillsCommand(["unlink", "linked-unlink-demo"]);
    const document = JSON.parse(fs.readFileSync(registryFile(), "utf8")) as {
      linkedSources: readonly unknown[];
    };
    expect(document.linkedSources).toHaveLength(0);
    expect(logsOf(log)).toContain("已注销 Linked Source");
    const error = await runSkillsCommand(["unlink", "linked-missing"]).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SkillError);
    expect((error as SkillError).code).toBe("skill_source_not_found");
  });
});

describe("skills doctor（本地 + Server 诊断）", () => {
  it("本地状态 + Server Catalog/绑定诊断完整输出", async () => {
    const dir = createSkillPackage(workdir, { name: "doctor-skill", version: "1.0.0" });
    await runSkillsCommand(["link", dir]);
    const calls: FetchCall[] = [];
    stubServer(calls, (call) => {
      if (call.url.endsWith("/api/skills") && call.method === "GET") {
        return jsonResponse([
          {
            displayName: "Shadowed Skill",
            skillId: "shadowed-skill",
            sourceKind: "workspace",
            sourceId: "ws",
            version: "1.0.0",
            contentHash: "sha256-f",
            status: { validity: "valid", trust: "untrusted", readiness: "blocked", selection: "shadowed", blockedReason: "skill_readiness_blocked" },
          },
        ]);
      }
      if (call.url.endsWith("/api/skills/search") && call.method === "POST") {
        return jsonResponse({
          hits: [],
          diagnostics: [{ code: "skill_source_unsupported", message: "远程来源搜索在 T9 接入" }],
          remote: { available: false, note: "" },
        });
      }
      if (call.url.endsWith("/api/agents") && call.method === "GET") {
        return jsonResponse([{ id: "agent-1", identity: { name: "测试 Agent" } }]);
      }
      if (call.url.endsWith("/api/agents/agent-1/skills") && call.method === "GET") {
        return jsonResponse({
          status: "ok",
          view: {
            visible: [],
            shadowed: [],
            disabled: [],
            gated: [{ displayName: "Gated Skill", blockedReason: "skill_readiness_blocked" }],
            diagnostics: [],
            learningPolicy: "ask-on-risk",
            bundleBindings: [],
            overrides: {},
          },
        });
      }
      return null;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runSkillsCommand(["doctor"]);
    const text = logsOf(log);
    expect(text).toContain("=== Skill 本地状态 ===");
    expect(text).toContain("OPENCOLORFUL_HOME");
    expect(text).toContain("来源信任配置");
    expect(text).toContain("linked-doctor-skill");
    expect(text).toContain("Catalog 共 1 项");
    expect(text).toContain("shadowed：Shadowed Skill");
    expect(text).toContain("测试 Agent");
    expect(logsOf(warn)).toContain("skill_readiness_blocked");
  });

  it("Server 不可达 → 明确诊断跳过（网络失败 ≠ 没有 Skill）", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await runSkillsCommand(["doctor"]);
    const text = logsOf(log);
    expect(text).toContain("Server 不可达或未接线");
    expect(text).toContain("=== Skill 本地状态 ===");
  });
});

describe("skills bundle create|version|inspect（HTTP）", () => {
  const CATALOG_ROW = {
    displayName: "Demo Skill",
    skillId: "demo-skill",
    sourceKind: "managed",
    sourceId: "C:\\store\\demo-skill",
    version: "1.0.0",
    contentHash: "sha256-abc",
    status: { validity: "valid", trust: "trusted", readiness: "ready", selection: "implicit" },
  };
  const DETAIL = {
    skillRef: { skillId: "demo-skill", sourceId: "C:\\store\\demo-skill", sourceKind: "managed", version: "1.0.0", contentHash: "sha256-abc" },
    skillRefKey: "demo-skill@C:\\store\\demo-skill@1.0.0",
  };

  it("bundle create 经 /api/skills/bundles 创建并输出 contentHash", async () => {
    const calls: FetchCall[] = [];
    stubServer(calls, (call) => {
      if (call.url.endsWith("/api/skills") && call.method === "GET") {
        return jsonResponse([CATALOG_ROW]);
      }
      // skillRefKey 解析：GET /api/skills/<skillRefKey>
      if (call.method === "GET" && call.url.includes("/api/skills/") && !call.url.endsWith("/api/skills")) {
        return jsonResponse(DETAIL);
      }
      if (call.url.endsWith("/api/skills/bundles") && call.method === "POST") {
        const body = call.body as { bundleId?: string; name?: string; items?: unknown[] };
        expect(body.bundleId).toBe("crew");
        expect(body.items).toHaveLength(1);
        return jsonResponse({ status: "ok", result: { status: "ok", bundleId: "crew", version: "1", contentHash: "sha256-bundle" } }, 201);
      }
      return null;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSkillsCommand([
      "bundle", "create", "crew",
      "--name", "Crew",
      "--skill", "demo-skill@C:\\store\\demo-skill@1.0.0",
    ]);
    const text = logsOf(log);
    expect(text).toContain("已创建：crew@1");
    expect(text).toContain("sha256-bundle");
  });

  it("bundle inspect 列出版本；未知 Bundle → 明确不存在", async () => {
    const calls: FetchCall[] = [];
    stubServer(calls, (call) => {
      if (call.url.includes("/api/skills/bundles") && call.method === "GET") {
        return jsonResponse({
          bundles: [
            {
              bundleId: "crew",
              name: "Crew",
              versions: [{ version: "1", contentHash: "sha256-bundle", createdAt: "2026-01-01T00:00:00.000Z", itemCount: 1 }],
            },
          ],
        });
      }
      return null;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSkillsCommand(["bundle", "inspect", "crew"]);
    expect(logsOf(log)).toContain("Bundle crew");
    await runSkillsCommand(["bundle", "inspect", "missing"]);
    expect(logsOf(log)).toContain("Bundle 不存在：missing");
  });

  it("未知子命令 → 清晰错误", async () => {
    await expect(runSkillsCommand(["bundle", "explode"])).rejects.toThrow(/未知 skills bundle 命令/);
  });
});
