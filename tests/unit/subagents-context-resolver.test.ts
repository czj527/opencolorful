import { describe, expect, it } from "vitest";

import {
  SUBAGENT_CONTEXT_MESSAGE_MAX_BYTES,
  SUBAGENT_CONTEXT_TOTAL_MAX_BYTES,
  type SubagentContextPacketV1,
  type SubagentContextRefV1,
} from "../../src/contracts/subagents.js";
import type { SkillRef } from "../../src/contracts/skill-protocol.js";
import {
  ContextResolver,
  isWorkspaceRelativePath,
  truncateUtf8Bytes,
  type ContextResolverDeps,
} from "../../src/runtime/subagents/context-resolver.js";
import { sha256Hex, stableSerialize } from "../../src/runtime/subagents/delegation-policy.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T3：ContextResolver 测试（plans/phase-14.md §9.2 / §22.1）
// - parent_message 跨 Session 拒绝；workspace_file 越界拒绝；
// - artifact/skill 引用验证与 contentHash 校验（fail-closed）；
// - 单条 16KB / 总计 128KB 有界快照与 truncated 标志；
// - ContextPacket 非法结构拒绝。
// ═══════════════════════════════════════════════════════════════

const PARENT_SESSION = "session-parent";
const WORKSPACE = "D:\\work\\project";

interface FixtureMessages {
  [messageId: string]: { readonly sessionId: string; readonly content: string };
}

function makeDeps(overrides: Partial<ContextResolverDeps> = {}, messages: FixtureMessages = {}): ContextResolverDeps {
  return {
    parentSessionId: PARENT_SESSION,
    workspaceCwd: WORKSPACE,
    loadParentMessage(messageId) {
      const message = messages[messageId];
      return message === undefined ? null : { ...message };
    },
    resolveWorkspaceFile(relativePath) {
      if (relativePath === "docs/plan.md" || relativePath === "sub/file.txt") {
        return { contentHash: sha256Hex(`content:${relativePath}`) };
      }
      return null;
    },
    resolveArtifact(artifactId) {
      if (artifactId === "saa_artifact000001") {
        return { contentHash: sha256Hex("artifact-content") };
      }
      return null;
    },
    resolveSkill(ref) {
      if (ref.skillId === "known-skill") {
        return { contentHash: sha256Hex("skill-content") };
      }
      return null;
    },
    ...overrides,
  };
}

function messageRef(messageId: string, content: string): SubagentContextPacketV1["messageRefs"][number] {
  return { kind: "parent_message", messageId, contentHash: sha256Hex(content) };
}

function workspaceRef(relativePath: string): SubagentContextRefV1 {
  return { kind: "workspace_file", relativePath, contentHash: sha256Hex(`content:${relativePath}`) };
}

function artifactRef(artifactId: string, contentHash = sha256Hex("artifact-content")): SubagentContextRefV1 {
  return { kind: "artifact", artifactId, contentHash };
}

function skillRef(): SkillRef {
  return { skillId: "known-skill", sourceId: "src", sourceKind: "builtin", version: "1.0.0", contentHash: sha256Hex("skill-content") };
}

function skillResourceRef(): SubagentContextRefV1 {
  return { kind: "skill", skillRef: skillRef(), contentHash: sha256Hex("skill-content") };
}

function makePacket(overrides: Partial<SubagentContextPacketV1> = {}): SubagentContextPacketV1 {
  return {
    version: 1,
    userRequest: "分析引用。",
    parentSummary: "摘要",
    messageRefs: [],
    resources: [],
    knownFacts: [],
    unresolvedQuestions: [],
    ...overrides,
  };
}

describe("引用验证与归属检查（fail-closed）", () => {
  it("合法 messageRefs/resources 全部通过并生成快照", () => {
    const messages: FixtureMessages = {
      "parent-msg-1": { sessionId: PARENT_SESSION, content: "第一条消息正文" },
    };
    const resolver = new ContextResolver(makeDeps({}, messages));
    const result = resolver.resolve(
      makePacket({
        messageRefs: [messageRef("parent-msg-1", "第一条消息正文")],
        resources: [workspaceRef("docs/plan.md"), artifactRef("saa_artifact000001"), skillResourceRef()],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.messageRefs).toHaveLength(1);
      expect(result.snapshot.messageRefs[0]!.content).toBe("第一条消息正文");
      expect(result.snapshot.resources).toHaveLength(3);
      expect(result.snapshot.resources.map((r) => r.label)).toEqual([
        "workspace docs/plan.md",
        "artifact saa_artifact000001",
        "skill known-skill@src@1.0.0",
      ]);
      expect(result.snapshot.truncated).toBe(false);
      expect(result.snapshot.droppedMessageCount).toBe(0);
    }
  });

  it("parent_message 引用其他 Session 的消息被拒绝（跨 Session）", () => {
    const resolver = new ContextResolver(
      makeDeps({}, { "other-msg": { sessionId: "session-other", content: "别人的消息" } }),
    );
    const result = resolver.resolve(makePacket({ messageRefs: [messageRef("other-msg", "别人的消息")] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((p) => p.kind === "parent_message_cross_session")).toBe(true);
    }
  });

  it("resources 中的 parent_message 同样执行 Session 归属检查", () => {
    const resolver = new ContextResolver(
      makeDeps({}, { "other-msg": { sessionId: "session-other", content: "别人的消息" } }),
    );
    const result = resolver.resolve(
      makePacket({ resources: [{ kind: "parent_message", messageId: "other-msg", contentHash: sha256Hex("别人的消息") }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((p) => p.kind === "parent_message_cross_session")).toBe(true);
    }
  });

  it("不存在的父消息与哈希不匹配分别拒绝", () => {
    const messages: FixtureMessages = { "parent-msg-1": { sessionId: PARENT_SESSION, content: "正文" } };
    const resolver = new ContextResolver(makeDeps({}, messages));
    const notFound = resolver.resolve(makePacket({ messageRefs: [messageRef("ghost-msg", "正文")] }));
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) {
      expect(notFound.problems.some((p) => p.kind === "parent_message_not_found")).toBe(true);
    }
    const mismatched = resolver.resolve(
      makePacket({ messageRefs: [{ kind: "parent_message", messageId: "parent-msg-1", contentHash: "x".repeat(16) }] }),
    );
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.problems.some((p) => p.kind === "parent_message_hash_mismatch")).toBe(true);
    }
  });

  it("workspace_file 越出父工作区（../ 与绝对路径）被拒绝", () => {
    const resolver = new ContextResolver(makeDeps());
    for (const relativePath of ["../secret.txt", "..\\secret.txt", "D:\\other\\file.txt", "/etc/passwd"]) {
      const result = resolver.resolve(makePacket({ resources: [workspaceRef(relativePath)] }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems.some((p) => p.kind === "workspace_file_outside_workspace")).toBe(true);
      }
    }
  });

  it("工作区内相对路径通过，缺失/哈希不匹配拒绝", () => {
    const resolver = new ContextResolver(makeDeps());
    const ok = resolver.resolve(makePacket({ resources: [workspaceRef("docs/plan.md")] }));
    expect(ok.ok).toBe(true);
    const missing = resolver.resolve(makePacket({ resources: [workspaceRef("ghost.txt")] }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.problems.some((p) => p.kind === "workspace_file_not_found")).toBe(true);
    }
    const mismatched = resolver.resolve(
      makePacket({ resources: [{ kind: "workspace_file", relativePath: "docs/plan.md", contentHash: "z".repeat(16) }] }),
    );
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.problems.some((p) => p.kind === "workspace_file_hash_mismatch")).toBe(true);
    }
  });

  it("artifact/skill 缺失与哈希不匹配分别拒绝", () => {
    const resolver = new ContextResolver(makeDeps());
    const missingArtifact = resolver.resolve(makePacket({ resources: [artifactRef("saa_ghost000001")] }));
    expect(missingArtifact.ok).toBe(false);
    if (!missingArtifact.ok) {
      expect(missingArtifact.problems.some((p) => p.kind === "artifact_not_found")).toBe(true);
    }
    const missingSkill = resolver.resolve(
      makePacket({
        resources: [
          { kind: "skill", skillRef: { ...skillRef(), skillId: "ghost-skill" }, contentHash: sha256Hex("skill-content") },
        ],
      }),
    );
    expect(missingSkill.ok).toBe(false);
    if (!missingSkill.ok) {
      expect(missingSkill.problems.some((p) => p.kind === "skill_not_found")).toBe(true);
    }
    const hashMismatch = resolver.resolve(
      makePacket({ resources: [{ kind: "skill", skillRef: skillRef(), contentHash: "e".repeat(16) }] }),
    );
    expect(hashMismatch.ok).toBe(false);
    if (!hashMismatch.ok) {
      expect(hashMismatch.problems.some((p) => p.kind === "skill_hash_mismatch")).toBe(true);
    }
  });

  it("非法包结构（未知字段/缺失必填）被 TypeBox 拒绝", () => {
    const resolver = new ContextResolver(makeDeps());
    const invalid = resolver.resolve({ version: 1, userRequest: "x", parentSummary: "" } as unknown as SubagentContextPacketV1);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.problems.some((p) => p.kind === "invalid_packet")).toBe(true);
    }
  });
});

describe("messageRefs 有界快照（16KB / 128KB）", () => {
  it("单条超 16KB 截断并标记 truncated，字节数精确", () => {
    const content = "a".repeat(SUBAGENT_CONTEXT_MESSAGE_MAX_BYTES + 1024);
    const messages: FixtureMessages = { "big-msg": { sessionId: PARENT_SESSION, content } };
    const resolver = new ContextResolver(makeDeps({}, messages));
    const result = resolver.resolve(makePacket({ messageRefs: [messageRef("big-msg", content)] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.snapshot.messageRefs[0]!;
      expect(entry.bytes).toBe(SUBAGENT_CONTEXT_MESSAGE_MAX_BYTES);
      expect(entry.truncated).toBe(true);
      expect(result.snapshot.truncated).toBe(true);
      expect(Buffer.byteLength(entry.content, "utf8")).toBe(SUBAGENT_CONTEXT_MESSAGE_MAX_BYTES);
    }
  });

  it("UTF-8 多字节字符截断不切坏字符（不产生替换符）", () => {
    const content = "汉".repeat(9000); // 27000 字节
    const messages: FixtureMessages = { "cjk-msg": { sessionId: PARENT_SESSION, content } };
    const resolver = new ContextResolver(makeDeps({}, messages));
    const result = resolver.resolve(makePacket({ messageRefs: [messageRef("cjk-msg", content)] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.snapshot.messageRefs[0]!;
      expect(entry.bytes).toBeLessThanOrEqual(SUBAGENT_CONTEXT_MESSAGE_MAX_BYTES);
      expect(entry.truncated).toBe(true);
      expect(entry.content.includes("\uFFFD")).toBe(false);
      // 截断后仍为完整汉字
      expect(entry.content.length % 1).toBe(0);
    }
  });

  it("总计超 128KB：截断越界条目并丢弃后续，全局 truncated 标记", () => {
    const content = "a".repeat(SUBAGENT_CONTEXT_MESSAGE_MAX_BYTES); // 每条恰好 16KB
    const messages: FixtureMessages = {};
    const refs = [];
    for (let i = 0; i < 10; i++) {
      const id = `msg-${i}`;
      messages[id] = { sessionId: PARENT_SESSION, content };
      refs.push(messageRef(id, content));
    }
    const resolver = new ContextResolver(makeDeps({}, messages));
    const result = resolver.resolve(makePacket({ messageRefs: refs }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 8 条 × 16KB = 128KB 恰好填满；第 9/10 条被丢弃
      expect(result.snapshot.messageRefs).toHaveLength(8);
      expect(result.snapshot.totalMessageBytes).toBe(SUBAGENT_CONTEXT_TOTAL_MAX_BYTES);
      expect(result.snapshot.droppedMessageCount).toBe(2);
      expect(result.snapshot.truncated).toBe(true);
      expect(result.snapshot.messageRefs[7]!.truncated).toBe(false);
    }
  });

  it("总计超限时越界条截断到剩余空间并标记 truncated", () => {
    // 62 条 × 2KB = 126976 字节（room 4096）+ 1 条 10KB：单条未超 16KB，
    // 但 10240 字节 > 剩余 4096 → 截断到 4096 恰好填满；第 64 条被丢弃
    // （messageRefs 契约上限 64 条）。
    const messages: FixtureMessages = {};
    const refs = [];
    for (let i = 0; i < 62; i++) {
      const id = `small-${i}`;
      messages[id] = { sessionId: PARENT_SESSION, content: "a".repeat(2048) };
      refs.push(messageRef(id, "a".repeat(2048)));
    }
    messages["big-last"] = { sessionId: PARENT_SESSION, content: "b".repeat(10 * 1024) };
    refs.push(messageRef("big-last", "b".repeat(10 * 1024)));
    messages["after"] = { sessionId: PARENT_SESSION, content: "c".repeat(2048) };
    refs.push(messageRef("after", "c".repeat(2048)));
    expect(refs).toHaveLength(64);

    const resolver = new ContextResolver(makeDeps({}, messages));
    const result = resolver.resolve(makePacket({ messageRefs: refs }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.messageRefs).toHaveLength(63);
      const last = result.snapshot.messageRefs[62]!;
      expect(last.truncated).toBe(true);
      expect(last.bytes).toBe(4096);
      expect(result.snapshot.totalMessageBytes).toBe(SUBAGENT_CONTEXT_TOTAL_MAX_BYTES);
      expect(result.snapshot.droppedMessageCount).toBe(1);
      expect(result.snapshot.truncated).toBe(true);
    }
  });

  it("packetHash 稳定：同包同哈希，异包异哈希", () => {
    const resolver = new ContextResolver(makeDeps());
    const packet = makePacket();
    const first = resolver.resolve(packet);
    const second = resolver.resolve(packet);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.snapshot.packetHash).toBe(second.snapshot.packetHash);
      expect(first.snapshot.packetHash).toBe(sha256Hex(stableSerialize(packet)));
      const other = resolver.resolve(makePacket({ knownFacts: ["不同事实"] }));
      if (other.ok) {
        expect(other.snapshot.packetHash).not.toBe(first.snapshot.packetHash);
      }
    }
  });
});

describe("工具函数", () => {
  it("truncateUtf8Bytes 小文本不截断", () => {
    const result = truncateUtf8Bytes("短文本", 1024);
    expect(result).toEqual({ text: "短文本", bytes: 9, truncated: false });
  });

  it("isWorkspaceRelativePath 边界判定", () => {
    expect(isWorkspaceRelativePath("D:\\work\\project", "docs/plan.md")).toBe(true);
    expect(isWorkspaceRelativePath("D:\\work\\project", "../secret.txt")).toBe(false);
    expect(isWorkspaceRelativePath("D:\\work\\project", "D:\\other\\file.txt")).toBe(false);
    expect(isWorkspaceRelativePath("D:\\work\\project", "")).toBe(false);
  });
});
