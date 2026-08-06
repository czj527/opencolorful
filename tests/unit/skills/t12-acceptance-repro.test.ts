import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { skillRefKey } from "../../../src/contracts/skill-protocol.js";
import { cleanupT6Harnesses, createT6Harness, ingestManagedSkill, type T6Harness } from "./t6-harness.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T12 第二轮验收复现测试（plans/phase-13.md §10.2 / §11.5 / §13.2）
// - P0-1：上一轮可见、下一轮解绑后拒绝读取；Junction 别名不能绕过
//   （canonical 落在 Skill 根但不在当前 Turn 快照 → denied，不回退裸读）；
// - P0-2：同 Turn 安装后经 activation grant 立即受控读取；安装返回的
//   loadHandle 有明确消费链（inspect readBody 传入）；
// - P1-2：loadHandle 签发失败不得遗留有效 activation grant（补偿撤销）。
// ═══════════════════════════════════════════════════════════════

let harness: T6Harness;

afterEach(() => {
  cleanupT6Harnesses();
});

function setup(): T6Harness {
  harness = createT6Harness();
  return harness;
}

function skillRootOf(harness: T6Harness, skillRef: { readonly skillId: string; readonly sourceId: string }): string {
  // managed 安装目录：<home>/skills/installed/<skillId>/<version>
  const registered = harness.catalog.list({}).find((skill) => skillRefKey(skill.skillRef) === skillRefKey(skill.skillRef));
  if (registered === undefined) {
    throw new Error(`Skill 未登记：${skillRef.skillId}`);
  }
  return registered.rootPath;
}

describe("P0-1：上一轮可见、下一轮解绑后拒绝读取（动态根整体替换 + denied）", () => {
  it("turn1 绑定可见 → 新 Session（无绑定）turn2 冻结后 readSkillFileForSession → denied（不回退）", async () => {
    const harness = setup();
    const dir = harness.makePackage("p01-src", { name: "p01-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "p01-skill", version: "1.0.0" });
    const ref = harness.catalog.list({}).find((skill) => skill.skillId === "p01-skill")?.skillRef;
    if (ref === undefined) throw new Error("skill 未登记");
    const root = skillRootOf(harness, ref);

    // turn1：session-1 临时绑定 → 可见，受控读取 ok
    harness.sessionService.bindTemporary({ sessionId: "session-1", skillRef: ref });
    harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-1", turnId: "turn-1" });
    const turn1 = await harness.core.readSkillFileForSession({ sessionId: "session-1", absPath: path.join(root, "SKILL.md") });
    expect(turn1.status).toBe("ok");

    // turn2：session-2 无任何绑定（模拟解绑/停用）→ 冻结空快照；
    // Skill 仍登记在 Catalog（未卸载）→ readSkillFileForSession 必须 denied，
    // 不得返回 not-a-skill-file 让调用方回退裸读
    harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-2", turnId: "turn-2" });
    const turn2 = await harness.core.readSkillFileForSession({ sessionId: "session-2", absPath: path.join(root, "SKILL.md") });
    expect(turn2.status).toBe("denied");
    if (turn2.status === "denied") {
      expect(turn2.reasonCode).toBe("skill_not_in_snapshot");
    }
  });

  it("Junction 别名不能绕过：canonical 落在 Skill 根但不在当前快照 → denied", async () => {
    const harness = setup();
    const dir = harness.makePackage("p01j-src", { name: "p01j-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "p01j-skill", version: "1.0.0" });
    const ref = harness.catalog.list({}).find((skill) => skill.skillId === "p01j-skill")?.skillRef;
    if (ref === undefined) throw new Error("skill 未登记");
    const root = skillRootOf(harness, ref);

    // Junction/符号链接别名指向 Skill 根
    const aliasDir = path.join(os.tmpdir(), `ocf-t12-alias-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(aliasDir, { recursive: true });
    try {
      fs.symlinkSync(root, path.join(aliasDir, "link"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      // 无符号链接权限时跳过本用例
      return;
    }
    const aliasPath = path.join(aliasDir, "link", "SKILL.md");

    // 无绑定 Session：词法路径不在可见集；canonical 后落在已登记 Skill 根 → denied
    harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-2", turnId: "turn-2" });
    const denied = await harness.core.readSkillFileForSession({ sessionId: "session-2", absPath: aliasPath });
    expect(denied.status).toBe("denied");
    if (denied.status === "denied") {
      expect(denied.reasonCode).toBe("skill_not_in_snapshot");
    }

    // 绑定后：canonical 匹配可见根 → 受控读取 ok（Junction 别名不破坏正常路径）
    harness.sessionService.bindTemporary({ sessionId: "session-1", skillRef: ref });
    harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-1", turnId: "turn-1" });
    const ok = await harness.core.readSkillFileForSession({ sessionId: "session-1", absPath: aliasPath });
    expect(ok.status).toBe("ok");
    fs.rmSync(aliasDir, { recursive: true, force: true });
  });
});

describe("P0-2：同 Turn 安装后立即受控读取 + 安装返回 loadHandle 消费链", () => {
  it("安装（grant + loadHandle）→ 同一 turn readSkillFileForSession ok；inspect 消费返回的 loadHandle", async () => {
    const harness = setup();
    // turn 开始：无可见 Skill（beforeSkills=0）
    harness.core.buildPiSkillsForTurn({ agentId: "", sessionId: "session-1", turnId: "turn-1" });
    const before = await harness.core.readSkillFileForSession({
      sessionId: "session-1",
      absPath: path.join(harness.home, "skills", "installed", "nope", "1.0.0", "SKILL.md"),
    });
    expect(before.status).toBe("not-a-skill-file");

    const dir = harness.makePackage("p02-src", { name: "p02-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "p02-skill", version: "1.0.0" });
    const result = harness.core.install({ sourceRef: dir, kind: "local", sessionId: "session-1", turnId: "turn-1" });
    expect(result.status).toBe("installed");
    if (result.status !== "installed") throw new Error(`安装失败：${result.reason}`);
    expect(result.activationGrant).toBe("granted");
    expect(result.loadHandle).not.toBeNull();
    if (result.skillRef === undefined || result.loadHandle === null) {
      throw new Error("installed 结果缺少 skillRef/loadHandle");
    }
    const loadHandleId = result.loadHandle;
    const registered = harness.catalog.resolveBySkillRef(result.skillRef);

    // 同一 turn：read 链路经 activation grant（overlay）立即受控读取安装后的 Skill
    const read = await harness.core.readSkillFileForSession({ sessionId: "session-1", absPath: path.join(registered.rootPath, "SKILL.md") });
    expect(read.status).toBe("ok");
    if (read.status === "ok") {
      expect(read.body).toContain("这是 Skill 正文。");
    }

    // 安装返回的 loadHandle 有消费链：inspect_skill(readBody=true, loadHandle=…)
    const inspect = await harness.core.inspect({
      skillRef: result.skillRef,
      sessionId: "session-1",
      turnId: "turn-1",
      readBody: true,
      loadHandle: loadHandleId,
    });
    expect(inspect.ok).toBe(true);
    if (inspect.ok) {
      expect(inspect.body).toContain("这是 Skill 正文。");
    }
    // 一次性：同 handle 再消费被拒（重放 fail-closed）
    const replay = await harness.core.inspect({
      skillRef: result.skillRef,
      sessionId: "session-1",
      turnId: "turn-1",
      readBody: true,
      loadHandle: loadHandleId,
    });
    expect(replay.ok).toBe(false);
  });
});

describe("P1-2：loadHandle 签发失败 → activation grant 补偿撤销（无残留）", () => {
  it("handle 失败返回 failed 且 listActiveGrants 为空（revoke 补偿）", () => {
    const harness = setup();
    const dir = harness.makePackage("p12-src", { name: "p12-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "p12-skill", version: "1.0.0" });

    const proto = Object.getPrototypeOf(harness.loadHandles) as Record<string, unknown>;
    const original = proto.issueLoadHandle as (...args: unknown[]) => unknown;
    proto.issueLoadHandle = () => {
      throw new Error("load handle store unavailable");
    };
    try {
      const result = harness.core.install({ sourceRef: dir, kind: "local", sessionId: "session-1", turnId: "turn-1" });
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.reasonCode).toBe("skill_operation_failed");
        expect(result.reason).toContain("已撤销");
      }
      // 授权已补偿撤销：当前 turn 无有效 grant 残留
      expect(harness.sessionService.listActiveGrants("session-1")).toHaveLength(0);
    } finally {
      proto.issueLoadHandle = original;
    }
  });
});
