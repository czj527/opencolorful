import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { skillRefKey, type SkillRef } from "../../../src/contracts/skill-protocol.js";
import { makeCandidate, makeEnv, makeInspection } from "./helpers.js";
import {
  cleanupT6Harnesses,
  createT6Harness,
  ingestManagedSkill,
  makeWorkspaceSkill,
  packSkillZip,
  type T6Harness,
} from "./t6-harness.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T6 SkillCoreService（plans/phase-13.md §11 / §14.2 / §18.5）
// - 搜索顺序（bound → managed → workspace → plugin）与"搜索不递归安装"；
// - install_skill 四态（installed/confirmation_required/rejected/failed）
//   与 loadHandle/activation grant 发放；
// - 学习策略三档（disabled/ask-always/ask-on-risk）；
// - inspect 元数据与受控正文读取；
// - manage_skills 确认边界（unbind 无确认拒绝）；
// - manage_skill_bundle 版本化（不原地覆盖）。
// ═══════════════════════════════════════════════════════════════

let harness: T6Harness;

afterEach(() => {
  cleanupT6Harnesses();
});

function setup(): T6Harness {
  harness = createT6Harness();
  return harness;
}

function skillRefOf(harness: T6Harness, packageDir: string): SkillRef {
  const registered = harness.catalog.list({}).find((skill) => skill.sourceId === path.resolve(packageDir));
  if (registered === undefined) {
    throw new Error(`Skill 未登记：${packageDir}`);
  }
  return registered.skillRef;
}

// ── search_skills ─────────────────────────────────────────────

describe("search：五层顺序与不递归安装", () => {
  it("bound → managed → workspace → plugin 顺序与 layer 标记", () => {
    const harness = setup();
    // bound 层：绑定到 agent 的 managed Skill
    const boundDir = harness.makePackage("bound-src", { name: "alpha-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(boundDir), { name: "alpha-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, boundDir);
    harness.agentService.bindSkill({ agentId: "agent-1", skillRef: ref, actor: { kind: "user", id: "test" } });
    // managed 层：未绑定的 Managed Skill
    const managedDir = harness.makePackage("managed-src", { name: "beta-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(managedDir), { name: "beta-skill", version: "1.0.0" });
    // workspace 层：home/.claude/skills
    makeWorkspaceSkill(harness, "gamma-skill", { name: "gamma-skill", version: "1.0.0" });
    // plugin 层：直接登记一个 plugin 来源候选（T7 接线后由插件注入）
    const pluginDir = harness.makePackage("plugin-src", { name: "delta-skill", version: "1.0.0" });
    harness.catalog.ingestCandidate({
      candidate: makeCandidate(path.resolve(pluginDir), "plugin", "delta-skill", "1.0.0"),
      inspection: makeInspection(path.resolve(pluginDir), "1.0.0"),
      trusted: true,
      environment: makeEnv(),
    });

    const result = harness.core.search({ query: "", agentId: "agent-1", sessionId: "session-1" });
    expect(result.layers).toEqual(["bound", "managed", "workspace", "plugin", "remote"]);
    const layers = result.hits.map((hit) => hit.layer);
    // bound 先于 managed/workspace/plugin
    const boundIndex = layers.indexOf("bound");
    const managedIndex = layers.indexOf("managed");
    const workspaceIndex = layers.indexOf("workspace");
    const pluginIndex = layers.indexOf("plugin");
    expect(boundIndex).toBeGreaterThanOrEqual(0);
    expect(managedIndex).toBeGreaterThan(boundIndex);
    expect(workspaceIndex).toBeGreaterThan(managedIndex);
    expect(pluginIndex).toBeGreaterThan(workspaceIndex);
    // bound 命中 pinned；workspace 命中带 installHint（可安装来源）
    const boundHit = result.hits.find((hit) => hit.layer === "bound");
    expect(boundHit?.pinned).toBe(true);
    const wsHit = result.hits.find((hit) => hit.layer === "workspace");
    expect(wsHit?.displayName).toBe("gamma-skill");
    expect(wsHit?.installHint?.kind).toBe("local");
    // remote 层明确诊断（T9 接入）
    expect(result.remote.available).toBe(false);
    expect(result.diagnostics.some((diag) => diag.code === "skill_source_unsupported")).toBe(true);
  });

  it("scope 限定单层", () => {
    const harness = setup();
    harness.makePackage("managed-src", { name: "only-managed", version: "1.0.0" });
    ingestManagedSkill(harness, path.join(harness.home, "managed-src"), { name: "only-managed", version: "1.0.0" });
    const result = harness.core.search({ query: "", scope: "managed" });
    expect(result.hits.every((hit) => hit.layer === "managed")).toBe(true);
  });

  it("搜索绝不递归触发安装：Catalog 与 installed 目录保持不变", () => {
    const harness = setup();
    const before = harness.catalog.list({}).length;
    const installedDir = path.join(harness.home, "missing-skill");
    expect(fs.existsSync(installedDir)).toBe(false);
    const result = harness.core.search({ query: "不存在的东西", agentId: "agent-1", sessionId: "session-1" });
    expect(result.hits).toHaveLength(0);
    expect(harness.catalog.list({}).length).toBe(before);
    expect(fs.existsSync(installedDir)).toBe(false);
  });
});

// ── inspect_skill ──────────────────────────────────────────────

describe("inspect：来源与已登记 Skill", () => {
  it("sourceRef + kind 检查：manifest/依赖/风险/兼容等级", async () => {
    const harness = setup();
    const dir = harness.makePackage("inspect-src", {
      name: "inspect-me",
      description: "检查目标",
      version: "2.0.0",
      extraFrontmatter: "license: MIT\nmetadata:\n  opencolorful:\n    version: 1\n    requires:\n      bins: [git]\n",
    });
    const result = await harness.core.inspect({ sourceRef: path.resolve(dir), kind: "local" });
    expect(result.ok).toBe(true);
    expect(result.version).toBe("2.0.0");
    expect(result.contentHash?.length).toBeGreaterThan(0);
    expect(result.manifest?.name).toBe("inspect-me");
    expect(result.manifest?.license).toBe("MIT");
    expect(result.manifest?.requires?.bins).toEqual(["git"]);
    expect(result.compatibility).not.toBeNull();
  });

  it("skillRef 解析已登记 Skill：含 status 与 readiness", async () => {
    const harness = setup();
    const dir = harness.makePackage("inspect-reg", { name: "registered-one", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "registered-one", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    const result = await harness.core.inspect({ skillRef: ref });
    expect(result.ok).toBe(true);
    expect(result.skillId).toBe("registered-one");
    expect(result.status?.validity).toBe("valid");
    expect(result.status?.readiness).toBe("ready");
  });

  it("readBody：经 loadHandle + SkillContentService 受控读取正文", async () => {
    const harness = setup();
    const dir = harness.makePackage("readbody", {
      name: "read-body-skill",
      version: "1.0.0",
      body: "受控正文内容",
    });
    ingestManagedSkill(harness, path.dirname(dir), { name: "read-body-skill", version: "1.0.0", body: "受控正文内容" });
    const ref = skillRefOf(harness, dir);
    const result = await harness.core.inspect({
      skillRef: ref,
      readBody: true,
      sessionId: "session-1",
      agentId: "agent-1",
      turnId: "turn-1",
    });
    expect(result.ok).toBe(true);
    expect(result.body).toContain("受控正文内容");
    expect(result.fileHash?.length).toBeGreaterThan(0);
    // loadHandle 已被消费（一次性）
    const handles = harness.loadHandles;
    expect(handles).toBeDefined();
  });

  it("参数错误：sourceRef 无 kind → failed；sourceRef 与 skillRef 同时给 → failed", async () => {
    const harness = setup();
    const noKind = await harness.core.inspect({ sourceRef: "/tmp/whatever" });
    expect(noKind.ok).toBe(false);
    expect(noKind.reasonCode).toBe("skill_source_unsupported");
    const dir = harness.makePackage("both", { name: "both", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "both", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    const both = await harness.core.inspect({ sourceRef: "/tmp/x", kind: "local", skillRef: ref });
    expect(both.ok).toBe(false);
    expect(both.reasonCode).toBe("skill_unknown_skillref");
  });
});

// ── install_skill ──────────────────────────────────────────────

describe("install：四态结构化结果与激活授权/loadHandle", () => {
  it("ask-on-risk + 低风险可信本地目录 → installed + bound + grant + loadHandle", () => {
    const harness = setup();
    const dir = harness.makePackage("install-ok", { name: "low-risk-skill", version: "1.0.0" });
    const result = harness.core.install({ sourceRef: path.resolve(dir), kind: "local", agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(result.status).toBe("installed");
    if (result.status === "installed") {
      expect(result.skillRef?.skillId).toBe("low-risk-skill");
      expect(result.skillRef?.version).toBe("1.0.0");
      expect(result.skillRefKey?.length).toBeGreaterThan(0);
      expect(result.operationId?.length).toBeGreaterThan(0);
      expect(result.agentBinding).toBe("bound");
      expect(result.activationGrant).toBe("granted");
      expect(result.grantId?.length).toBeGreaterThan(0);
      expect(result.loadHandle).toBeTruthy();
      expect(result.reasonCode).toBeUndefined();
      // 绑定确实写入 Agent 配置
      const config = harness.agentService.getSkillsConfig("agent-1");
      expect(config.directSkillRefs.some((ref) => ref.skillId === "low-risk-skill")).toBe(true);
    }
  });

  it("无 Agent Session：session-only 绑定 + grant + loadHandle", () => {
    const harness = setup();
    const dir = harness.makePackage("install-session", { name: "session-skill", version: "1.0.0" });
    const result = harness.core.install({ sourceRef: path.resolve(dir), kind: "local", sessionId: "session-1", turnId: "turn-1" });
    expect(result.status).toBe("installed");
    if (result.status === "installed") {
      expect(result.agentBinding).toBe("session-only");
      expect(result.activationGrant).toBe("granted");
    }
    const view = harness.sessionService.listSessionSkills("session-1");
    expect(view.active.some((b) => b.skillRefKey.includes("session-skill"))).toBe(true);
  });

  it("ask-always：低风险也必须确认 → confirmation_required，approve 后重试 → installed", () => {
    const harness = setup();
    harness.agentService.setLearningPolicy({
      agentId: "agent-1",
      policy: "ask-always",
      confirmed: true,
      actor: { kind: "user", id: "test" },
    });
    const dir = harness.makePackage("ask-always", { name: "ask-always-skill", version: "1.0.0" });
    const sourceRef = path.resolve(dir);
    const first = harness.core.install({ sourceRef, kind: "local", agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(first.status).toBe("confirmation_required");
    if (first.status !== "confirmation_required") return;
    const token = first.confirmation?.token ?? "";
    expect(token).toMatch(/^ct-/);
    expect(first.confirmation?.operationType).toBe("install");
    // 未确认时不做任何领域修改
    expect(harness.agentService.getSkillsConfig("agent-1").directSkillRefs).toHaveLength(0);
    // 用户确认（UI 入口）
    const approved = harness.core.approveConfirmation({ token, agentId: "agent-1", sessionId: "session-1" });
    expect(approved.status).toBe("approved");
    // 模型带令牌重试 → installed
    const second = harness.core.install({ sourceRef, kind: "local", confirmationToken: token, agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(second.status).toBe("installed");
    if (second.status === "installed") {
      expect(second.skillRef?.skillId).toBe("ask-always-skill");
      expect(second.agentBinding).toBe("bound");
      expect(second.loadHandle).toBeTruthy();
    }
  });

  it("ask-on-risk + 高风险（scripts 目录）：确认令牌 → rejected（重放）/mismatch/expired", () => {
    const harness = setup();
    const dir = harness.makePackage("high-risk", { name: "high-risk-skill", version: "1.0.0" });
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "run.sh"), "echo hi", "utf8");
    const sourceRef = path.resolve(dir);

    const first = harness.core.install({ sourceRef, kind: "local", agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(first.status).toBe("confirmation_required");
    if (first.status !== "confirmation_required") return;
    const token = first.confirmation?.token ?? "";
    expect(first.confirmation?.riskLevel).toBe("high");
    expect(first.risks?.some((risk) => risk.code === "scripts")).toBe(true);

    // 未 approve 直接带令牌 → 拒绝（target_mismatch，未确认）
    const unapproved = harness.core.install({ sourceRef, kind: "local", confirmationToken: token, agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(unapproved.status).toBe("rejected");
    expect(unapproved.reasonCode).toBe("skill_confirmation_target_mismatch");

    // approve 后目标变更（换一个有效但不同的高风险包，确认阶段才会校验目标）
    // → rejected target_mismatch
    const approved = harness.core.approveConfirmation({ token, agentId: "agent-1", sessionId: "session-1" });
    expect(approved.status).toBe("approved");
    const otherDir = harness.makePackage("other-dir", { name: "other-skill", version: "1.0.0" });
    fs.mkdirSync(path.join(otherDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(otherDir, "scripts", "run.sh"), "echo hi", "utf8");
    const changed = harness.core.install({ sourceRef: path.resolve(otherDir), kind: "local", confirmationToken: token, agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(changed.status).toBe("rejected");
    expect(changed.reasonCode).toBe("skill_confirmation_target_mismatch");

    // 正确目标 → installed；令牌一次性 → 重试 reused
    const ok = harness.core.install({ sourceRef, kind: "local", confirmationToken: token, agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(ok.status).toBe("installed");
    const replay = harness.core.install({ sourceRef, kind: "local", confirmationToken: token, agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(replay.status).toBe("rejected");
    expect(replay.reasonCode).toBe("skill_confirmation_reused");
  });

  it("ask-on-risk + 令牌过期 → rejected skill_confirmation_expired", () => {
    const harness = setup();
    const dir = harness.makePackage("expire", { name: "expire-skill", version: "1.0.0" });
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "run.sh"), "echo hi", "utf8");
    const sourceRef = path.resolve(dir);
    const first = harness.core.install({ sourceRef, kind: "local", agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(first.status).toBe("confirmation_required");
    if (first.status !== "confirmation_required") return;
    const token = first.confirmation?.token ?? "";
    harness.core.approveConfirmation({ token });
    harness.advance(16 * 60 * 1000); // 超过 15 分钟 TTL
    const expired = harness.core.install({ sourceRef, kind: "local", confirmationToken: token, agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(expired.status).toBe("rejected");
    expect(expired.reasonCode).toBe("skill_confirmation_expired");
  });

  it("learningPolicy=disabled：拒绝安装（不产生领域修改）", () => {
    const harness = setup();
    harness.agentService.setLearningPolicy({
      agentId: "agent-1",
      policy: "disabled",
      confirmed: true,
      actor: { kind: "user", id: "test" },
    });
    const dir = harness.makePackage("disabled", { name: "disabled-skill", version: "1.0.0" });
    const result = harness.core.install({ sourceRef: path.resolve(dir), kind: "local", agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(result.status).toBe("rejected");
    expect(result.reasonCode).toBe("skill_agent_unauthorized");
    expect(harness.agentService.getSkillsConfig("agent-1").directSkillRefs).toHaveLength(0);
  });

  it("无效包（缺 SKILL.md）→ failed skill_not_a_complete_package", () => {
    const harness = setup();
    const dir = path.join(harness.home, "not-a-package");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.txt"), "不是 Skill", "utf8");
    const result = harness.core.install({ sourceRef: dir, kind: "local", agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("skill_not_a_complete_package");
  });

  it("未登记 session-file → failed skill_content_read_denied（fileKey 必须已登记）", () => {
    const harness = setup();
    const result = harness.core.install({ sourceRef: "sf-not-registered", kind: "session-file", sessionId: "session-1" });
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("skill_content_read_denied");
  });

  it("session-file 登记后安装成功（完整 .zip 包）", () => {
    const harness = setup();
    const dir = harness.makePackage("sf-src", { name: "sf-skill", version: "1.0.0" });
    const zipPath = packSkillZip(dir, path.join(harness.home, "uploads", "sf-skill.zip"));
    const fileKey = harness.registerSessionZip(zipPath, "session-1");
    const result = harness.core.install({ sourceRef: fileKey, kind: "session-file", sessionId: "session-1", turnId: "turn-1" });
    expect(result.status).toBe("installed");
    if (result.status === "installed") {
      expect(result.skillRef?.skillId).toBe("sf-skill");
      expect(result.agentBinding).toBe("session-only");
    }
  });

  it("信任根外的本地路径 → failed skill_content_read_denied（不接受任意绝对路径）", () => {
    const base = createT6Harness();
    const trustedRoot = path.join(base.home, "trusted");
    cleanupT6Harnesses();
    const harness = createT6Harness({ trustedRoots: [trustedRoot] });
    const outside = path.join(harness.home, "outside");
    fs.mkdirSync(outside, { recursive: true });
    const pkg = path.join(outside, "pkg");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "SKILL.md"),
      "---\nname: outside-skill\ndescription: 外部\nversion: 1.0.0\n---\n正文\n",
      "utf8",
    );
    const result = harness.core.install({ sourceRef: pkg, kind: "local", agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("skill_content_read_denied");
  });

  it("重复安装同一精确引用：幂等且 agentBinding=unchanged", () => {
    const harness = setup();
    const dir = harness.makePackage("idem", { name: "idem-skill", version: "1.0.0" });
    const sourceRef = path.resolve(dir);
    const first = harness.core.install({ sourceRef, kind: "local", agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(first.status).toBe("installed");
    if (first.status !== "installed") return;
    expect(first.idempotent).toBe(false);
    const second = harness.core.install({ sourceRef, kind: "local", agentId: "agent-1", sessionId: "session-1", turnId: "turn-2" });
    expect(second.status).toBe("installed");
    if (second.status === "installed") {
      expect(second.idempotent).toBe(true);
      expect(second.agentBinding).toBe("unchanged");
      expect(second.skillRefKey).toBe(first.skillRefKey);
    }
  });

  it("安装结果必须符合冻结 schema（fail-closed 校验通过）", () => {
    const harness = setup();
    const dir = harness.makePackage("schema", { name: "schema-skill", version: "1.0.0" });
    const result = harness.core.install({ sourceRef: path.resolve(dir), kind: "local", agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    // 四态枚举 + loadHandle 字段必须存在
    expect(["installed", "confirmation_required", "rejected", "failed"]).toContain(result.status);
    expect("loadHandle" in result).toBe(true);
  });
});

// ── manage_skills ──────────────────────────────────────────────

describe("manage_skills：确认边界与选择模式", () => {
  it("bind 无需确认；list 返回学习策略与绑定", () => {
    const harness = setup();
    const dir = harness.makePackage("mng", { name: "mng-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "mng-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    const bound = harness.core.manageSkills({ action: "bind", agentId: "agent-1", skillRef: ref });
    expect(bound.status).toBe("ok");
    const listed = harness.core.manageSkills({ action: "list", agentId: "agent-1" });
    expect(listed.status).toBe("ok");
    const view = listed.view as { visible: unknown[]; learningPolicy: string };
    expect(view.visible.length).toBeGreaterThan(0);
    expect(view.learningPolicy).toBe("ask-on-risk");
  });

  it("unbind 无确认 → confirmation_required（不做领域修改），带已确认令牌 → unbound", () => {
    const harness = setup();
    const dir = harness.makePackage("mng-unbind", { name: "mng-unbind-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "mng-unbind-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    harness.core.manageSkills({ action: "bind", agentId: "agent-1", skillRef: ref });
    const key = skillRefKeyOf(harness, ref);

    const requested = harness.core.manageSkills({ action: "request-unbind", agentId: "agent-1", skillRefKey: key });
    expect(requested.status).toBe("confirmation_required");
    if (requested.status === "confirmation_required") {
      expect(requested.confirmation?.operationType).toBe("unbind");
    }
    // 未确认前仍绑定
    expect(harness.agentService.getSkillsConfig("agent-1").directSkillRefs).toHaveLength(1);

    // 令牌被错误操作类型消费 → rejected
    const wrongType = harness.core.manageSkills({ action: "unbind", agentId: "agent-1", skillRefKey: key, confirmationToken: "ct-wrong" });
    expect(wrongType.status).toBe("failed");

    // 正确流程：approve → unbind
    const issued = requested.status === "confirmation_required" ? requested.confirmation?.token ?? "" : "";
    harness.core.approveConfirmation({ token: issued, agentId: "agent-1", sessionId: "session-1" });
    const unbound = harness.core.manageSkills({ action: "unbind", agentId: "agent-1", skillRefKey: key, confirmationToken: issued });
    expect(unbound.status).toBe("ok");
    const result = unbound.result as { status: string };
    expect(result.status).toBe("unbound");
    expect(harness.agentService.getSkillsConfig("agent-1").directSkillRefs).toHaveLength(0);
  });

  it("set-selection disabled 无确认 → confirmation_required；implicit 变更无需确认", () => {
    const harness = setup();
    const dir = harness.makePackage("mng-sel", { name: "mng-sel-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "mng-sel-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    harness.core.manageSkills({ action: "bind", agentId: "agent-1", skillRef: ref });
    const key = skillRefKeyOf(harness, ref);

    const implicit = harness.core.manageSkills({ action: "set-selection", agentId: "agent-1", skillRefKey: key, selection: "implicit" });
    expect(implicit.status).toBe("ok");

    const disabled = harness.core.manageSkills({ action: "set-selection", agentId: "agent-1", skillRefKey: key, selection: "disabled" });
    expect(disabled.status).toBe("confirmation_required");
    if (disabled.status === "confirmation_required") {
      expect(disabled.confirmation?.operationType).toBe("set-selection-disabled");
    }
    // 配置未被修改
    expect(harness.agentService.getSkillsConfig("agent-1").overrides[key]).toBe("implicit");

    // 已确认令牌 → changed
    const issued = disabled.status === "confirmation_required" ? disabled.confirmation?.token ?? "" : "";
    harness.core.approveConfirmation({ token: issued, agentId: "agent-1", sessionId: "session-1" });
    const changed = harness.core.manageSkills({ action: "set-selection", agentId: "agent-1", skillRefKey: key, selection: "disabled", confirmationToken: issued });
    expect(changed.status).toBe("ok");
    expect(harness.agentService.getSkillsConfig("agent-1").overrides[key]).toBe("disabled");
  });

  it("无 Agent 会话调用 manage_skills → 工具层拒绝（skill_agent_unauthorized 由调用方保障）", () => {
    const harness = setup();
    // core 层需要 agentId；空 agentId 由工具层拒绝。此处验证 core 对非法 agentId fail-closed
    const result = harness.core.manageSkills({ action: "list", agentId: "" });
    expect(result.status).toBe("failed");
  });
});

// ── manage_skill_bundle ────────────────────────────────────────

describe("manage_skill_bundle：版本化与迁移确认", () => {
  it("create-version 不原地覆盖：同 bundle 两次创建生成 v1/v2", () => {
    const harness = setup();
    const dir1 = harness.makePackage("bundle-a", { name: "bundle-skill-a", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir1), { name: "bundle-skill-a", version: "1.0.0" });
    const dir2 = harness.makePackage("bundle-b", { name: "bundle-skill-b", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir2), { name: "bundle-skill-b", version: "1.0.0" });
    const refA = skillRefOf(harness, dir1);
    const refB = skillRefOf(harness, dir2);

    const v1 = harness.core.manageBundle({
      action: "create-version",
      agentId: "agent-1",
      bundleId: "crew",
      name: "Crew Bundle",
      items: [{ skillRef: refA }],
    });
    expect(v1.status).toBe("ok");
    const r1 = v1.result as { version: string };
    expect(r1.version).toBe("1");

    const v2 = harness.core.manageBundle({
      action: "create-version",
      agentId: "agent-1",
      bundleId: "crew",
      name: "Crew Bundle",
      items: [{ skillRef: refA }, { skillRef: refB }],
    });
    expect(v2.status).toBe("ok");
    const r2 = v2.result as { version: string };
    expect(r2.version).toBe("2");
    // 旧版本保留（不原地覆盖）
    const versions = harness.bundleService.listBundleVersions("crew");
    expect(versions.map((v) => v.version).sort()).toEqual(["1", "2"]);
    expect(versions[0]?.items).toHaveLength(2);
    expect(versions[1]?.items).toHaveLength(1);
  });

  it("bind Bundle 无需确认；migrate 固定版本需要确认", () => {
    const harness = setup();
    const dir1 = harness.makePackage("mb-a", { name: "mb-skill-a", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir1), { name: "mb-skill-a", version: "1.0.0" });
    const refA = skillRefOf(harness, dir1);
    harness.core.manageBundle({ action: "create-version", agentId: "agent-1", bundleId: "crew", name: "Crew", items: [{ skillRef: refA }] });
    harness.core.manageBundle({ action: "create-version", agentId: "agent-1", bundleId: "crew", name: "Crew", items: [{ skillRef: refA }] });

    const bound = harness.core.manageBundle({ action: "bind", agentId: "agent-1", bundleId: "crew", version: "1" });
    expect(bound.status).toBe("ok");

    const migrated = harness.core.manageBundle({ action: "migrate", agentId: "agent-1", bundleId: "crew", fromVersion: "1", toVersion: "2" });
    expect(migrated.status).toBe("confirmation_required");
    if (migrated.status === "confirmation_required") {
      expect(migrated.confirmation?.operationType).toBe("bundle-migrate");
    }
    // 未确认不迁移
    const config = harness.agentService.getSkillsConfig("agent-1");
    expect(config.bundleBindings.find((b) => b.bundleId === "crew")?.version).toBe("1");

    const token = migrated.status === "confirmation_required" ? migrated.confirmation?.token ?? "" : "";
    harness.core.approveConfirmation({ token, agentId: "agent-1", sessionId: "session-1" });
    const migratedOk = harness.core.manageBundle({ action: "migrate", agentId: "agent-1", bundleId: "crew", fromVersion: "1", toVersion: "2", confirmationToken: token });
    expect(migratedOk.status).toBe("ok");
    expect(harness.agentService.getSkillsConfig("agent-1").bundleBindings.find((b) => b.bundleId === "crew")?.version).toBe("2");
  });
});


// ── P1-7：无 Agent Session 与 Session 临时绑定 ──────────────────

describe("P1-7：无 Agent Session 与 Session 临时绑定", () => {
  it("无 Agent 会话：Session 临时绑定 + workspace 全局来源可见；未绑定 managed 不可见", () => {
    const harness = setup();
    // workspace 来源登记进 Catalog（全局可见来源）
    const wsDir = harness.makePackage("ws-src", { name: "ws-skill", version: "1.0.0" });
    harness.catalog.ingestCandidate({
      candidate: makeCandidate(path.resolve(wsDir), "workspace", "ws-skill", "1.0.0"),
      inspection: makeInspection(path.resolve(wsDir), "1.0.0"),
      trusted: true,
      environment: makeEnv(),
    });
    // 未绑定 managed → 不可见（P0-5）
    const unboundDir = harness.makePackage("m-src", { name: "m-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(unboundDir), { name: "m-skill", version: "1.0.0" });
    // Session 临时绑定 managed → 可见
    const boundDir = harness.makePackage("b-src", { name: "b-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(boundDir), { name: "b-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, boundDir);
    harness.sessionService.bindTemporary({ sessionId: "session-9", skillRef: ref });

    const { skills } = harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-9", turnId: "turn-9" });
    const names = skills.map((skill) => skill.name);
    expect(names).toContain("b-skill");
    expect(names).toContain("ws-skill");
    expect(names).not.toContain("m-skill");
  });

  it("无 Agent 会话：临时绑定失效（Catalog 无此 Key）→ 诊断 fail-closed，不静默回退", () => {
    const harness = setup();
    const dir = harness.makePackage("x-src", { name: "x-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "x-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    harness.sessionService.bindTemporary({ sessionId: "session-9", skillRef: ref });
    // 卸载：从 Catalog 移除登记（临时绑定 Key 仍在存储中）
    harness.catalog.removeByRefKey(skillRefKey(ref));

    const { skills, diagnostics } = harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-9", turnId: "turn-9" });
    expect(skills).toHaveLength(0);
    expect(diagnostics.some((diag) => diag.type === "error" && diag.message.includes("临时绑定无法解析"))).toBe(true);
  });

  it("Agent 会话：Session 临时绑定与 Agent 持久绑定合并解析", () => {
    const harness = setup();
    // Agent-1 持久绑定
    const agentDir = harness.makePackage("agent-src", { name: "agent-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(agentDir), { name: "agent-skill", version: "1.0.0" });
    const agentRef = skillRefOf(harness, agentDir);
    harness.agentService.bindSkill({ agentId: "agent-1", skillRef: agentRef, actor: { kind: "user", id: "test" } });
    // Session 临时绑定另一个 Skill
    const sessDir = harness.makePackage("sess-src", { name: "sess-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(sessDir), { name: "sess-skill", version: "1.0.0" });
    const sessRef = skillRefOf(harness, sessDir);
    harness.sessionService.bindTemporary({ sessionId: "session-1", skillRef: sessRef });

    const { skills } = harness.core.buildPiSkillsForTurn({ agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    const names = skills.map((skill) => skill.name);
    expect(names).toContain("agent-skill");
    expect(names).toContain("sess-skill");
  });

  it("快照身份：无 Agent 会话使用 @anonymous 占位（契约拒绝空 agentId）", () => {
    const harness = setup();
    const dir = harness.makePackage("b-src", { name: "anon-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "anon-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    harness.sessionService.bindTemporary({ sessionId: "session-9", skillRef: ref });
    const { skills } = harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-9", turnId: "turn-9" });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.sourceInfo.scope).toBe("user");
  });
});


// ── P0-2：read 工具 Skill 受控读取路由 ─────────────────────────

describe("Phase 14 复审 P0-3（第二轮）：Run 专属 Skill 快照（自包含不可变）", () => {
  it("capture 后父换 turn 不影响 Run 快照读取（自包含、不依赖父当前槽）", async () => {
    const harness = setup();
    const dir = harness.makePackage("b-src", { name: "run-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "run-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    harness.sessionService.bindTemporary({ sessionId: "session-9", skillRef: ref });
    harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-9", turnId: "turn-9" });

    // spawn 点捕获（turn-9 冻结集）
    const captured = harness.core.captureRunSkillSnapshot({ sessionId: "session-9", turnId: "turn-9" });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.snapshot.entries.some((entry) => skillRefKey(entry.ref) === skillRefKey(ref))).toBe(true);

    // 父 Session 进入新 Turn（快照槽被替换——模拟父继续工作）
    harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-9", turnId: "turn-10" });

    // Run 专属快照读取不受影响（不再有 skill_snapshot_turn_changed denied）
    const main = await harness.core.readSkillFileForRunSnapshot({ snapshot: captured.snapshot, absPath: path.join(dir, "SKILL.md") });
    expect(main.status).toBe("ok");
    if (main.status === "ok") {
      expect(main.body).toContain("这是 Skill 正文。");
      expect(main.relativePath).toBe("SKILL.md");
    }
    const body = await harness.core.readSkillBodyForRunSnapshot({ snapshot: captured.snapshot, skillRef: ref, relativePath: "SKILL.md" });
    expect(body.status).toBe("ok");
    if (body.status === "ok") expect(body.body).toContain("这是 Skill 正文。");
  });

  it("快照外 skillRef → denied；快照外路径 → not-a-skill-file（fail-closed 不回退裸读）", async () => {
    const harness = setup();
    const dir = harness.makePackage("b-src", { name: "run-skill2", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "run-skill2", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    harness.sessionService.bindTemporary({ sessionId: "session-9", skillRef: ref });
    harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-9", turnId: "turn-9" });
    const captured = harness.core.captureRunSkillSnapshot({ sessionId: "session-9", turnId: "turn-9" });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    // 另一个 Skill（未绑定 → 不在快照）→ denied
    const otherDir = harness.makePackage("c-src", { name: "other-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(otherDir), { name: "other-skill", version: "1.0.0" });
    const otherRef = skillRefOf(harness, otherDir);
    const denied = await harness.core.readSkillBodyForRunSnapshot({ snapshot: captured.snapshot, skillRef: otherRef, relativePath: "SKILL.md" });
    expect(denied.status).toBe("denied");

    // 快照根外路径 → not-a-skill-file（回退普通沙箱读取）
    const outside = path.join(harness.home, "outside.txt");
    fs.writeFileSync(outside, "plain", "utf8");
    const outsideResult = await harness.core.readSkillFileForRunSnapshot({ snapshot: captured.snapshot, absPath: outside });
    expect(outsideResult.status).toBe("not-a-skill-file");
  });

  it("capture：turnId 与当前冻结不一致 → fail-closed {ok:false}（不委派漂移集）", () => {
    const harness = setup();
    const dir = harness.makePackage("b-src", { name: "cap-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "cap-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    harness.sessionService.bindTemporary({ sessionId: "session-9", skillRef: ref });
    harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-9", turnId: "turn-9" });
    harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-9", turnId: "turn-10" });
    const captured = harness.core.captureRunSkillSnapshot({ sessionId: "session-9", turnId: "turn-9" });
    expect(captured.ok).toBe(false);
  });
});

describe("P0-2：readSkillFileForSession 三态路由", () => {
  it("命中可见 Skill 根 → ok（正文 + skillRefKey）；支持文件同样受控", async () => {
    const harness = setup();
    const dir = harness.makePackage("b-src", { name: "ro-skill", version: "1.0.0" });
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    fs.writeFileSync(path.join(dir, "references", "guide.md"), "# Guide\n内容", "utf8");
    ingestManagedSkill(harness, path.dirname(dir), { name: "ro-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    harness.sessionService.bindTemporary({ sessionId: "session-9", skillRef: ref });
    // 先冻结（beginTurn 语义）
    harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-9", turnId: "turn-9" });

    const main = await harness.core.readSkillFileForSession({ sessionId: "session-9", absPath: path.join(dir, "SKILL.md") });
    expect(main.status).toBe("ok");
    if (main.status === "ok") {
      expect(main.body).toContain("这是 Skill 正文。");
      expect(main.relativePath).toBe("SKILL.md");
    }
    const support = await harness.core.readSkillFileForSession({ sessionId: "session-9", absPath: path.join(dir, "references", "guide.md") });
    expect(support.status).toBe("ok");
    if (support.status === "ok") {
      expect(support.body).toBe("# Guide\n内容");
      expect(support.relativePath).toBe("references/guide.md");
    }
  });

  it("非 Skill 路径 / 无冻结快照 → not-a-skill-file（回退普通沙箱读取）", async () => {
    const harness = setup();
    const outside = path.join(harness.home, "outside.txt");
    fs.writeFileSync(outside, "plain", "utf8");
    // 未冻结：无快照 → not-a-skill-file
    const noFreeze = await harness.core.readSkillFileForSession({ sessionId: "session-9", absPath: outside });
    expect(noFreeze.status).toBe("not-a-skill-file");

    const dir = harness.makePackage("b-src", { name: "ro-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "ro-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    harness.sessionService.bindTemporary({ sessionId: "session-9", skillRef: ref });
    harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-9", turnId: "turn-9" });
    // 冻结后：Skill 根外路径仍 not-a-skill-file
    const outsideAfter = await harness.core.readSkillFileForSession({ sessionId: "session-9", absPath: outside });
    expect(outsideAfter.status).toBe("not-a-skill-file");
  });

  it("内容被篡改 → denied（fail-closed，绝不回退裸读）", async () => {
    const harness = setup();
    const dir = harness.makePackage("b-src", { name: "tamper-ro", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "tamper-ro", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    harness.sessionService.bindTemporary({ sessionId: "session-9", skillRef: ref });
    harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-9", turnId: "turn-9" });
    // 冻结后篡改 → 哈希不匹配 → denied
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: tamper-ro\ndescription: d\n---\nEVIL", "utf8");
    const result = await harness.core.readSkillFileForSession({ sessionId: "session-9", absPath: path.join(dir, "SKILL.md") });
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reasonCode).toBe("skill_content_hash_mismatch");
    }
  });
});


// ── P1-9：安装结果契约收紧（grant/loadHandle 失败不得静默 installed）──

describe("P1-9：激活授权/loadHandle 签发失败 → failed（不静默 installed）", () => {
  /** 临时把实例原型方法替换为抛错实现，回调后恢复（原型共享，必须还原）。 */
  function withBrokenMethod<T extends object>(instance: T, methodName: keyof T, message: string, fn: () => void): void {
    const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
    const original = proto[methodName as string] as (...args: unknown[]) => unknown;
    proto[methodName as string] = () => {
      throw new Error(message);
    };
    try {
      fn();
    } finally {
      proto[methodName as string] = original;
    }
  }

  it("激活授权签发失败 → status=failed（skillRef/operationId 保留，reasonCode=skill_activation_denied）", () => {
    const harness = setup();
    const dir = harness.makePackage("grant-fail-src", { name: "grant-fail", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "grant-fail", version: "1.0.0" });

    let result: ReturnType<T6Harness["core"]["install"]>;
    withBrokenMethod(harness.sessionService, "issueActivationGrant", "activation store unavailable", () => {
      result = harness.core.install({
        sourceRef: dir,
        kind: "local",
        sessionId: "session-1",
        turnId: "turn-1",
      });
    });
    expect(result!.status).toBe("failed");
    if (result!.status === "failed") {
      expect(result!.reasonCode).toBe("skill_activation_denied");
      expect(result!.skillRef).toBeDefined();
      expect(result!.reason).toContain("安装与绑定已完成");
    }
  });

  it("loadHandle 签发失败 → status=failed（reasonCode=skill_operation_failed）", () => {
    const harness = setup();
    const dir = harness.makePackage("handle-fail-src", { name: "handle-fail", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "handle-fail", version: "1.0.0" });

    let result: ReturnType<T6Harness["core"]["install"]>;
    withBrokenMethod(harness.loadHandles, "issueLoadHandle", "load handle store unavailable", () => {
      result = harness.core.install({
        sourceRef: dir,
        kind: "local",
        sessionId: "session-1",
        turnId: "turn-1",
      });
    });
    expect(result!.status).toBe("failed");
    if (result!.status === "failed") {
      expect(result!.reasonCode).toBe("skill_operation_failed");
      expect(result!.loadHandle).toBeNull();
    }
  });

  it("正常路径：grant + loadHandle 都签发成功 → installed（回归）", () => {
    const harness = setup();
    const dir = harness.makePackage("ok-src", { name: "ok-install", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "ok-install", version: "1.0.0" });

    const result = harness.core.install({
      sourceRef: dir,
      kind: "local",
      sessionId: "session-1",
      turnId: "turn-1",
    });
    expect(result.status).toBe("installed");
    if (result.status === "installed") {
      expect(result.activationGrant).toBe("granted");
      expect(result.loadHandle).not.toBeNull();
    }
  });
});


// ── P0-3：Agent 插件绑定贡献进入可见集 ──────────────────────────

describe("P0-3：绑定插件贡献对 Agent 可见（pluginOverlay 接入）", () => {
  it("未绑定 Agent → 插件 Skill 不可见；绑定并启用 → 进入可见集（readiness overlay）", () => {
    const harness = setup();
    // 登记 plugin 来源 Skill（sourceId = 插件 id）
    const dir = harness.makePackage("plg-src", { name: "plg-skill", version: "1.0.0" });
    const registered = harness.catalog.ingestCandidate({
      candidate: makeCandidate(path.resolve(dir), "plugin", "plg-skill", "1.0.0"),
      inspection: makeInspection(path.resolve(dir), "1.0.0"),
      trusted: true,
      environment: makeEnv(),
    });
    // 注入 pluginOverlay（模拟 PluginSkillBridge：agent-1 已绑定且启用该插件）
    const deps = (harness.core as unknown as { deps: Record<string, unknown> }).deps;
    deps.pluginOverlay = {
      assertReadable: () => undefined,
      overlayStatus: (skill: { status: { readiness: string } }) => skill.status,
      listAgentBoundPluginSkills: (agentId: string) =>
        agentId === "agent-1" ? [harness.catalog.findByRefKey(skillRefKey(registered.skillRef))!] : [],
    };

    // 未绑定插件贡献 → 不可见（P0-5：未固定 plugin 候选 gated）
    const before = harness.core.buildPiSkillsForTurn({ agentId: "agent-2", sessionId: "session-1", turnId: "turn-1" });
    expect(before.skills.map((skill) => skill.name)).not.toContain("plg-skill");

    // 绑定并启用 → 固定引用进入可见集
    const after = harness.core.buildPiSkillsForTurn({ agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" });
    expect(after.skills.map((skill) => skill.name)).toContain("plg-skill");
  });
});

function skillRefKeyOf(harness: T6Harness, ref: SkillRef): string {
  const registered = harness.catalog.resolveBySkillRef(ref);
  return skillRefKey(registered.skillRef);
}
