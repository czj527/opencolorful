import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runWithSkillContext } from "../../../src/pi-sdk/skill-tools.js";
import skillToolsExtension from "../../../src/pi-sdk/skill-tools.js";
import type { SkillRef } from "../../../src/contracts/skill-protocol.js";
import { cleanupT6Harnesses, createT6Harness, ingestManagedSkill, type T6Harness } from "./t6-harness.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T6 五个 Core 工具（plans/phase-13.md §11.1 / §14.2 / §18.5）
// - 参数校验失败 → 结构化 failed（稳定 reasonCode），不走自由文本；
// - install_skill 返回四态 JSON + loadHandle；
// - manage_skills 确认边界（unbind 无确认拒绝）；
// - 工具必须通过平台服务执行（直接调用安装器/文件系统被禁止）。
// ═══════════════════════════════════════════════════════════════

let harness: T6Harness;

afterEach(() => {
  cleanupT6Harnesses();
});

function setup(): T6Harness {
  harness = createT6Harness();
  return harness;
}

function invokeTool(toolName: string, params: unknown): Promise<{ content: { type: string; text: string }[] }> {
  const extension = loadExtension();
  const tool = extension.find((registered) => registered.name === toolName);
  if (tool === undefined) {
    throw new Error(`工具未注册：${toolName}`);
  }
  return runWithSkillContext(
    { core: harness.core, sessionId: "session-1", agentId: "agent-1", turnId: "turn-1" },
    () => tool.execute("toolcall-1", params, new AbortController().signal, undefined, undefined),
  ) as Promise<{ content: { type: string; text: string }[] }>;
}

interface RegisteredTool {
  readonly name: string;
  readonly execute: (toolCallId: string, params: unknown, signal: AbortSignal, onUpdate: unknown, executionContext: unknown) => unknown;
}

function loadExtension(): RegisteredTool[] {
  // 直接调用扩展入口（default export），把五个工具登记到内存 registry
  const registered: RegisteredTool[] = [];
  const pi = {
    registerTool(tool: RegisteredTool) {
      registered.push(tool);
    },
  };
  skillToolsExtension(pi as never);
  return registered;
}

function parseResult(result: { content: { type: string; text: string }[] }): unknown {
  const text = result.content[0]?.text ?? "";
  return JSON.parse(text) as unknown;
}

function skillRefOf(harness: T6Harness, packageDir: string): SkillRef {
  const registered = harness.catalog.list({}).find((skill) => skill.sourceId === path.resolve(packageDir));
  if (registered === undefined) {
    throw new Error(`Skill 未登记：${packageDir}`);
  }
  return registered.skillRef;
}

describe("工具注册与参数校验", () => {
  it("五个 Core 工具全部注册", () => {
    const names = loadExtension().map((tool) => tool.name);
    expect(names.sort()).toEqual(
      ["inspect_skill", "install_skill", "manage_skill_bundle", "manage_skills", "search_skills"].sort(),
    );
  });

  it("非法参数 → 结构化 failed + reasonCode（不走自由文本）", async () => {
    setup();
    const result = await invokeTool("install_skill", { sourceRef: "", kind: "local" });
    const parsed = parseResult(result) as { status: string; reasonCode: string };
    expect(parsed.status).toBe("failed");
    expect(parsed.reasonCode).toBe("skill_operation_failed");
  });

  it("上下文未就绪 → 工具调用被阻止（fail-closed）", async () => {
    setup();
    const extension = loadExtension();
    const tool = extension.find((registered) => registered.name === "search_skills");
    expect(tool).toBeDefined();
    // 无 runWithSkillContext 包裹（也无 executionContext）→ requireContext 抛错
    await expect(
      Promise.resolve(
        tool?.execute("toolcall-1", { query: "x" }, new AbortController().signal, undefined, undefined),
      ),
    ).rejects.toThrow(/Skill 工具上下文未就绪/);
  });
});

describe("search_skills 工具", () => {
  it("返回结构化五层结果 JSON", async () => {
    setup();
    const dir = harness.makePackage("t-search", { name: "tool-search-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "tool-search-skill", version: "1.0.0" });
    const result = await invokeTool("search_skills", { query: "tool-search" });
    const parsed = parseResult(result) as { hits: { layer: string }[]; remote: { available: boolean } };
    expect(parsed.hits.length).toBeGreaterThan(0);
    expect(parsed.remote.available).toBe(false);
  });

  it("scope 限定 managed 层", async () => {
    setup();
    const dir = harness.makePackage("t-scope", { name: "tool-scope-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "tool-scope-skill", version: "1.0.0" });
    const result = await invokeTool("search_skills", { query: "", scope: "managed" });
    const parsed = parseResult(result) as { hits: { layer: string }[] };
    expect(parsed.hits.every((hit) => hit.layer === "managed")).toBe(true);
  });
});

describe("install_skill 工具（四态 + loadHandle）", () => {
  it("ask-always：confirmation_required → approve → 带令牌重试 → installed + loadHandle", async () => {
    setup();
    harness.agentService.setLearningPolicy({
      agentId: "agent-1",
      policy: "ask-always",
      confirmed: true,
      actor: { kind: "user", id: "test" },
    });
    const dir = harness.makePackage("t-install", { name: "tool-install-skill", version: "1.0.0" });
    const sourceRef = path.resolve(dir);

    const first = parseResult(await invokeTool("install_skill", { sourceRef, kind: "local" })) as {
      status: string;
      confirmation?: { token: string };
      loadHandle: string | null;
    };
    expect(first.status).toBe("confirmation_required");
    expect(first.loadHandle).toBeNull();
    expect(first.confirmation?.token).toMatch(/^ct-/);

    // 用户确认（UI 入口 → core.approveConfirmation）
    const approved = harness.core.approveConfirmation({ token: first.confirmation?.token ?? "", agentId: "agent-1", sessionId: "session-1" });
    expect(approved.status).toBe("approved");

    const second = parseResult(await invokeTool("install_skill", { sourceRef, kind: "local", confirmationToken: first.confirmation?.token })) as {
      status: string;
      skillRef?: { skillId: string };
      agentBinding: string;
      activationGrant: string;
      loadHandle: string | null;
      reasonCode?: string;
    };
    expect(second.status).toBe("installed");
    expect(second.skillRef?.skillId).toBe("tool-install-skill");
    expect(second.agentBinding).toBe("bound");
    expect(second.activationGrant).toBe("granted");
    expect(second.loadHandle).toBeTruthy();
    expect(second.reasonCode).toBeUndefined();
  });

  it("无效包 → failed + reasonCode（模型不能凭模糊文本推断安装完成）", async () => {
    setup();
    const dir = path.join(harness.home, "t-bad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "readme.txt"), "不是包", "utf8");
    const result = parseResult(await invokeTool("install_skill", { sourceRef: dir, kind: "local" })) as {
      status: string;
      reasonCode: string;
    };
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("skill_not_a_complete_package");
  });
});

describe("inspect_skill 工具", () => {
  it("sourceRef 检查返回 manifest/风险/兼容等级", async () => {
    setup();
    const dir = harness.makePackage("t-inspect", { name: "tool-inspect-skill", version: "1.0.0", license: "MIT" });
    const result = parseResult(await invokeTool("inspect_skill", { sourceRef: path.resolve(dir), kind: "local" })) as {
      ok: boolean;
      manifest?: { name: string; license?: string };
      contentHash?: string;
    };
    expect(result.ok).toBe(true);
    expect(result.manifest?.name).toBe("tool-inspect-skill");
    expect(result.manifest?.license).toBe("MIT");
    expect(result.contentHash?.length).toBeGreaterThan(0);
  });

  it("skillRef + readBody → 受控正文", async () => {
    setup();
    const dir = harness.makePackage("t-readbody", { name: "tool-readbody-skill", version: "1.0.0", body: "工具受控正文" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "tool-readbody-skill", version: "1.0.0", body: "工具受控正文" });
    const ref = skillRefOf(harness, dir);
    const result = parseResult(await invokeTool("inspect_skill", { skillRef: ref, readBody: true })) as {
      ok: boolean;
      body?: string;
    };
    expect(result.ok).toBe(true);
    expect(result.body).toContain("工具受控正文");
  });
});

describe("manage_skills 工具（确认边界）", () => {
  it("unbind 无确认 → confirmation_required；bind 无需确认", async () => {
    setup();
    const dir = harness.makePackage("t-mng", { name: "tool-mng-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "tool-mng-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    const key = `${ref.skillId}@${ref.sourceId}@${ref.version}`;

    const bound = parseResult(await invokeTool("manage_skills", { action: "bind", skillRef: ref })) as { status: string };
    expect(bound.status).toBe("ok");

    const unbound = parseResult(await invokeTool("manage_skills", { action: "unbind", skillRefKey: key })) as {
      status: string;
      confirmation?: { operationType: string };
    };
    expect(unbound.status).toBe("confirmation_required");
    expect(unbound.confirmation?.operationType).toBe("unbind");

    const listed = parseResult(await invokeTool("manage_skills", { action: "list" })) as { status: string };
    expect(listed.status).toBe("ok");
  });
});

describe("manage_skill_bundle 工具", () => {
  it("create-version 生成新版本（不覆盖）", async () => {
    setup();
    const dir = harness.makePackage("t-bundle", { name: "tool-bundle-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "tool-bundle-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    const first = parseResult(
      await invokeTool("manage_skill_bundle", { action: "create-version", bundleId: "crew", name: "Crew", items: [{ skillRef: ref }] }),
    ) as { status: string; result?: { version: string } };
    expect(first.status).toBe("ok");
    expect(first.result?.version).toBe("1");
    const second = parseResult(
      await invokeTool("manage_skill_bundle", { action: "create-version", bundleId: "crew", name: "Crew", items: [{ skillRef: ref }] }),
    ) as { status: string; result?: { version: string } };
    expect(second.result?.version).toBe("2");
    expect(harness.bundleService.listBundleVersions("crew")).toHaveLength(2);
  });
});
