import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimePaths } from "../../../src/config/paths.js";
import type { SkillErrorCode } from "../../../src/contracts/skill-protocol.js";
import { SkillCatalog } from "../../../src/runtime/skills/catalog/skill-catalog.js";
import { SkillError } from "../../../src/runtime/skills/errors.js";
import { SkillInstaller } from "../../../src/runtime/skills/installer/skill-installer.js";
import { SkillOperationStore } from "../../../src/runtime/skills/installer/operation-store.js";
import { SessionFileRegistry } from "../../../src/runtime/skills/installer/session-file-registry.js";
import { SkillStager } from "../../../src/runtime/skills/installer/stager.js";
import { GitSkillSource } from "../../../src/runtime/skills/sources/git-source.js";
import { HttpSkillSource } from "../../../src/runtime/skills/sources/http-source.js";
import { ArchiveSkillSource } from "../../../src/runtime/skills/sources/archive-source.js";
import { BuiltinSkillSource } from "../../../src/runtime/skills/sources/builtin-source.js";
import { ManagedSkillSource } from "../../../src/runtime/skills/sources/managed-source.js";
import { openMetadataDatabase } from "../../../src/storage/database.js";
import { createSkillPackage, makeEnv, tempPaths, tmpDir } from "./helpers.js";
import { buildSkillZip, buildZipFixture } from "./zip-fixture.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 SkillInstaller 测试（plans/phase-13.md §7.3 / §8.3 / §12.2 / §18.3）
// ═══════════════════════════════════════════════════════════════

/** 断言调用抛 SkillError 且 code 匹配，返回捕获的错误。 */
function expectSkillError(fn: () => unknown, code: SkillErrorCode): SkillError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SkillError);
  expect((caught as SkillError).code).toBe(code);
  return caught as SkillError;
}

interface InstallerHarness {
  readonly installer: SkillInstaller;
  readonly catalog: SkillCatalog;
  readonly operations: SkillOperationStore;
  readonly paths: RuntimePaths;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function makeHarness(catalogOverride?: SkillCatalog): InstallerHarness {
  const { paths, home } = tempPaths();
  const database = openMetadataDatabase(path.join(paths.home, "metadata.sqlite"));
  const catalog = catalogOverride ?? new SkillCatalog();
  const operations = new SkillOperationStore(database);
  const sessionFiles = new SessionFileRegistry();
  const adapters = [
    new BuiltinSkillSource(paths),
    new ManagedSkillSource(paths),
    new ArchiveSkillSource(paths),
    new GitSkillSource(paths, { exec: mockGitExec }),
    new HttpSkillSource(paths, { downloader: mockHttpDownloader }),
  ];
  const stager = new SkillStager({ paths, adapters, sessionFiles });
  const installer = new SkillInstaller({ paths, catalog, operations, sessionFiles, adapters, stager, environment: makeEnv() });
  cleanups.push(() => {
    database.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { installer, catalog, operations, paths };
}

/** 默认 git mock：在目标目录写入完整 SKILL.md 包，返回固定 commit。 */
const mockGitExec = (args: readonly string[], _options: { readonly cwd?: string }): string => {
  if (args[0] === "clone") {
    const dest = args[args.length - 1];
    if (dest === undefined) {
      return "";
    }
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(
      path.join(dest, "SKILL.md"),
      "---\nname: git-skill\ndescription: git 来源测试\nversion: 1.0.0\n---\n正文\n",
      "utf8",
    );
    return "";
  }
  if (args[0] === "-C" && args.includes("rev-parse")) {
    return "abc1234";
  }
  return "";
};

/** 默认 http mock：返回完整 Skill 包 ZIP。 */
const mockHttpDownloader = (url: string, _options: { readonly maxBytes: number }) => ({
  ok: true,
  status: 200,
  contentType: "application/zip",
  body: buildSkillZip({ name: "http-skill", version: "1.0.0" }),
  finalUrl: url,
});

describe("install 成功路径（原子性）", () => {
  it("本地完整包安装：不可变 Artifact 落盘 + catalog 登记 + operation completed", () => {
    const { installer, catalog, operations, paths } = makeHarness();
    const root = tmpDir();
    const pkg = createSkillPackage(root, { name: "atomic-skill", version: "1.0.0" });

    const result = installer.install({ sourceRef: pkg, kind: "local", trust: true });

    expect(result.idempotent).toBe(false);
    expect(result.skillRef.skillId).toBe("atomic-skill");
    expect(result.skillRef.version).toBe("1.0.0");
    expect(fs.existsSync(path.join(paths.skillsInstalled, "atomic-skill", "1.0.0", "SKILL.md"))).toBe(true);
    // 内容哈希参与 SkillRef
    expect(result.skillRef.contentHash.startsWith("sha256-")).toBe(true);

    const registered = catalog.resolveBySkillRef(result.skillRef);
    expect(registered.sourceKind).toBe("managed");
    expect(registered.status.validity).toBe("valid");
    expect(registered.status.trust).toBe("trusted");
    expect(registered.provenance).toBeDefined();

    const operation = operations.getOperation(result.operationId);
    expect(operation?.status).toBe("completed");
    expect(operation?.kind).toBe("install");
    // staging 已清理
    expect(fs.existsSync(path.join(paths.skillsStaging, result.operationId))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("同版本同哈希重复安装 → 幂等（catalog 只有一条登记）", () => {
    const { installer, catalog, paths } = makeHarness();
    const root = tmpDir();
    const pkg = createSkillPackage(root, { name: "idem-skill", version: "1.0.0" });

    const first = installer.install({ sourceRef: pkg, kind: "local", trust: true });
    const second = installer.install({ sourceRef: pkg, kind: "local", trust: true });

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(catalog.list({})).toHaveLength(1);
    // 幂等不清除已存在 Artifact
    expect(fs.existsSync(path.join(paths.skillsInstalled, "idem-skill", "1.0.0"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("同版本不同哈希 → skill_version_conflict", () => {
    const { installer } = makeHarness();
    const root = tmpDir();
    const pkg = createSkillPackage(root, { name: "conflict-skill", version: "1.0.0", body: "版本 A" });
    installer.install({ sourceRef: pkg, kind: "local", trust: true });
    // 内容变化但版本号不变
    fs.writeFileSync(path.join(pkg, "SKILL.md"), "---\nname: conflict-skill\ndescription: d\nversion: 1.0.0\n---\n版本 B\n", "utf8");

    expectSkillError(() => installer.install({ sourceRef: pkg, kind: "local", trust: true }), "skill_version_conflict");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("install 失败补偿", () => {
  it("复制/登记失败 → 清理 staging + 恢复已复制 Artifact + operation failed/compensated", () => {
    class FailingCatalog extends SkillCatalog {
      override ingestCandidate(): ReturnType<SkillCatalog["ingestCandidate"]> {
        throw new SkillError("skill_operation_failed", "模拟 catalog 登记失败");
      }
    }
    const { installer, operations, paths } = makeHarness(new FailingCatalog());
    const root = tmpDir();
    const pkg = createSkillPackage(root, { name: "fail-skill", version: "1.0.0" });

    expectSkillError(() => installer.install({ sourceRef: pkg, kind: "local", trust: true }), "skill_operation_failed");

    // 已复制的 Artifact 被恢复（删除）
    expect(fs.existsSync(path.join(paths.skillsInstalled, "fail-skill", "1.0.0"))).toBe(false);
    expect(fs.existsSync(path.join(paths.skillsInstalled, "fail-skill"))).toBe(false);
    const failedOps = operations.listOperations().filter((operation) => operation.kind === "install");
    expect(failedOps.length).toBe(1);
    expect(["failed", "compensated"]).toContain(failedOps[0]?.status);
    expect(failedOps[0]?.errorCode).toBe("skill_operation_failed");
    // staging 已清理
    expect(fs.existsSync(path.join(paths.skillsStaging, failedOps[0]?.operationId ?? "missing"))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("裸 Markdown（无 SKILL.md）→ skill_not_a_complete_package", () => {
    const { installer } = makeHarness();
    const root = tmpDir();
    const bare = path.join(root, "bare");
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, "guide.md"), "# 只是一段 Markdown", "utf8");

    expectSkillError(() => installer.install({ sourceRef: bare, kind: "local", trust: true }), "skill_not_a_complete_package");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("archive 适配器（ZIP）安全", () => {
  it("ZIP Slip（../ 路径）→ skill_zip_slip", () => {
    const { installer, paths } = makeHarness();
    const root = tmpDir();
    const zipPath = path.join(root, "evil.skill");
    fs.writeFileSync(zipPath, buildZipFixture([{ name: "../evil.txt", content: "escape" }]));
    const archive = new ArchiveSkillSource(paths);

    expectSkillError(() => archive.stage(zipPath), "skill_zip_slip");
    expectSkillError(() => installer.install({ sourceRef: zipPath, kind: "archive", trust: true }), "skill_zip_slip");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("重复路径 → skill_duplicate_path", () => {
    const { installer } = makeHarness();
    const root = tmpDir();
    const zipPath = path.join(root, "dup.skill");
    fs.writeFileSync(
      zipPath,
      buildZipFixture([
        { name: "SKILL.md", content: "---\nname: d\ndescription: d\n---\n" },
        { name: "SKILL.md", content: "---\nname: d\ndescription: d\n---\n" },
      ]),
    );

    expectSkillError(() => installer.install({ sourceRef: zipPath, kind: "archive", trust: true }), "skill_duplicate_path");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("大小超限（单文件 > 256KB）→ skill_too_large", () => {
    const { installer, paths } = makeHarness();
    const root = tmpDir();
    const zipPath = path.join(root, "big.skill");
    const bigContent = Buffer.alloc(300 * 1024, 0x61);
    fs.writeFileSync(
      zipPath,
      buildZipFixture([
        { name: "SKILL.md", content: "---\nname: big\ndescription: d\n---\n正文" },
        { name: "assets/big.txt", content: bigContent },
      ]),
    );
    const archive = new ArchiveSkillSource(paths);

    expectSkillError(() => archive.stage(zipPath), "skill_too_large");
    expectSkillError(() => installer.install({ sourceRef: zipPath, kind: "archive", trust: true }), "skill_too_large");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("二进制默认拒绝 → skill_binary_denied", () => {
    const { installer } = makeHarness();
    const root = tmpDir();
    const zipPath = path.join(root, "binary.skill");
    fs.writeFileSync(
      zipPath,
      buildZipFixture([
        { name: "SKILL.md", content: "---\nname: bin\ndescription: d\n---\n正文" },
        { name: "bin/tool.exe", content: "MZ fake" },
      ]),
    );
    expectSkillError(() => installer.install({ sourceRef: zipPath, kind: "archive", trust: true }), "skill_binary_denied");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("未知文件类型 → skill_file_type_denied", () => {
    const { installer } = makeHarness();
    const root = tmpDir();
    const zipPath = path.join(root, "ext.skill");
    fs.writeFileSync(
      zipPath,
      buildZipFixture([
        { name: "SKILL.md", content: "---\nname: ext\ndescription: d\n---\n正文" },
        { name: "data.xyz", content: "opaque" },
      ]),
    );
    expectSkillError(() => installer.install({ sourceRef: zipPath, kind: "archive", trust: true }), "skill_file_type_denied");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("裸 Markdown 归档（根只有 .md）→ skill_not_a_complete_package", () => {
    const { installer } = makeHarness();
    const root = tmpDir();
    const zipPath = path.join(root, "note.skill");
    fs.writeFileSync(zipPath, buildZipFixture([{ name: "note.md", content: "# 裸 Markdown" }]));
    expectSkillError(() => installer.install({ sourceRef: zipPath, kind: "archive", trust: true }), "skill_not_a_complete_package");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("archive 完整安装成功（含顶层目录布局）", () => {
    const { installer, catalog } = makeHarness();
    const root = tmpDir();
    const zipPath = path.join(root, "zipped.skill");
    fs.writeFileSync(zipPath, buildSkillZip({ name: "zipped-skill", version: "2.1.0", topLevelDir: "zipped-skill/" }));

    const result = installer.install({ sourceRef: zipPath, kind: "archive", trust: false });

    expect(result.skillRef.skillId).toBe("zipped-skill");
    expect(result.skillRef.version).toBe("2.1.0");
    expect(result.registered.status.trust).toBe("untrusted");
    expect(catalog.resolveBySkillRef(result.skillRef).status.validity).toBe("valid");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("scripts 风险标记", () => {
  it("含 scripts/ 目录 → install 结果带 scripts 风险标记", () => {
    const { installer } = makeHarness();
    const root = tmpDir();
    const pkg = createSkillPackage(root, { name: "scripty", version: "1.0.0" });
    fs.mkdirSync(path.join(pkg, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "scripts", "run.sh"), "#!/bin/sh\necho hi\n", "utf8");

    const result = installer.install({ sourceRef: pkg, kind: "local", trust: true });
    expect(result.risks.some((risk) => risk.code === "scripts")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("inspect 结果也带风险标记", () => {
    const { installer } = makeHarness();
    const root = tmpDir();
    const pkg = createSkillPackage(root, { name: "scripty2", version: "1.0.0" });
    fs.mkdirSync(path.join(pkg, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "scripts", "run.sh"), "#!/bin/sh\n", "utf8");

    const inspect = installer.inspectSource({ sourceRef: pkg, kind: "local" });
    expect(inspect.risks.some((risk) => risk.code === "scripts")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("update / rollback / uninstall", () => {
  it("update：新版本并存，旧版本目录保留可回滚", () => {
    const { installer, catalog, paths } = makeHarness();
    const root1 = tmpDir();
    const root2 = tmpDir();
    const v1 = createSkillPackage(root1, { name: "evolving", version: "1.0.0", body: "v1" });
    const v2 = createSkillPackage(root2, { name: "evolving", version: "1.1.0", body: "v2" });

    installer.install({ sourceRef: v1, kind: "local", trust: true });
    const updated = installer.update({ skillId: "evolving", newSourceRef: v2, kind: "local", trust: true });

    expect(updated.skillRef.version).toBe("1.1.0");
    expect(fs.existsSync(path.join(paths.skillsInstalled, "evolving", "1.0.0"))).toBe(true);
    expect(fs.existsSync(path.join(paths.skillsInstalled, "evolving", "1.1.0"))).toBe(true);
    expect(catalog.list({}).filter((skill) => skill.skillId === "evolving")).toHaveLength(2);

    const rolled = installer.rollback({ skillId: "evolving", targetVersion: "1.0.0" });
    expect(rolled.skillRef.version).toBe("1.0.0");
    expect(rolled.registered.status.validity).toBe("valid");
    fs.rmSync(root1, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  });

  it("update 未安装的 Skill → skill_unknown_skillref", () => {
    const { installer } = makeHarness();
    const root = tmpDir();
    const v1 = createSkillPackage(root, { name: "ghost", version: "1.0.0" });
    expectSkillError(() => installer.update({ skillId: "ghost", newSourceRef: v1, kind: "local", trust: true }), "skill_unknown_skillref");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rollback 目标版本未安装 → skill_rollback_failed", () => {
    const { installer } = makeHarness();
    const root = tmpDir();
    const pkg = createSkillPackage(root, { name: "rb", version: "1.0.0" });
    installer.install({ sourceRef: pkg, kind: "local", trust: true });

    expectSkillError(() => installer.rollback({ skillId: "rb", targetVersion: "9.9.9" }), "skill_rollback_failed");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uninstall：catalog 移除 + 正文删除 + operation 记录保留", () => {
    const { installer, catalog, operations, paths } = makeHarness();
    const root = tmpDir();
    const pkg = createSkillPackage(root, { name: "gone", version: "1.0.0" });
    const installed = installer.install({ sourceRef: pkg, kind: "local", trust: true });

    const result = installer.uninstall({ skillId: "gone" });

    expect(result.removedRefs).toBe(1);
    expect(catalog.list({}).filter((skill) => skill.skillId === "gone")).toHaveLength(0);
    expect(fs.existsSync(path.join(paths.skillsInstalled, "gone"))).toBe(false);
    const op = operations.getOperation(result.operationId);
    expect(op?.status).toBe("completed");
    expect(op?.kind).toBe("uninstall");
    // 已登记 SkillRef 卸载后解析失败（fail-closed）
    expectSkillError(() => catalog.resolveBySkillRef(installed.skillRef), "skill_unknown_skillref");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("SessionFile 登记与安装", () => {
  it("登记后安装成功；未登记 fileKey → skill_content_read_denied", () => {
    const { installer } = makeHarness();
    const root = tmpDir();
    const zipPath = path.join(root, "session.skill");
    const buffer = buildSkillZip({ name: "session-skill", version: "1.0.0" });
    fs.writeFileSync(zipPath, buffer);
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

    const registration = installer.registerSessionFile({
      sessionId: "sess-1",
      filePath: zipPath,
      sizeBytes: buffer.length,
      sha256,
    });
    expect(registration.fileKey.startsWith("sf-")).toBe(true);

    const result = installer.install({ sourceRef: registration.fileKey, kind: "session-file", sessionId: "sess-1", trust: true });
    expect(result.skillRef.skillId).toBe("session-skill");
    expect(result.skillRef.version).toBe("1.0.0");

    // 未登记 / 跨会话 fileKey 拒绝
    expectSkillError(() => installer.install({ sourceRef: "sf-missing", kind: "session-file", sessionId: "sess-1", trust: true }), "skill_content_read_denied");
    expectSkillError(() => installer.install({ sourceRef: registration.fileKey, kind: "session-file", sessionId: "sess-other", trust: true }), "skill_content_read_denied");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("git / http 适配器（mock，不请求真实网络）", () => {
  it("git：mock exec 克隆 + 安装成功", () => {
    const { installer } = makeHarness();
    const url = "https://example.invalid/repo.git";
    const result = installer.install({ sourceRef: url, kind: "git", trust: true });
    expect(result.skillRef.skillId).toBe("git-skill");
    expect(result.skillRef.version).toBe("1.0.0");
  });

  it("git stage 可直接暂存到受控目录（版本取 frontmatter）", () => {
    const { paths } = makeHarness();
    const git = new GitSkillSource(paths, { exec: mockGitExec });
    const staged = git.stage("https://example.invalid/repo.git", { stagingRoot: path.join(paths.skillsStaging, "op-git-test") });
    expect(fs.existsSync(path.join(staged.packageRoot, "SKILL.md"))).toBe(true);
    expect(staged.contentHash.startsWith("sha256-")).toBe(true);
    fs.rmSync(path.join(paths.skillsStaging, "op-git-test"), { recursive: true, force: true });
  });

  it("http：mock downloader 安装成功", () => {
    const { installer } = makeHarness();
    const result = installer.install({ sourceRef: "https://example.invalid/skill.skill", kind: "http", trust: true });
    expect(result.skillRef.skillId).toBe("http-skill");
    expect(result.skillRef.version).toBe("1.0.0");
  });

  it("http 返回 text/markdown → skill_not_a_complete_package（网络失败不伪装成没有 Skill）", () => {
    const { paths } = makeHarness();
    const downloader = () => ({
      ok: true,
      status: 200,
      contentType: "text/markdown",
      body: Buffer.from("# 裸 Markdown"),
      finalUrl: "https://example.invalid/note.md",
    });
    const http = new HttpSkillSource(paths, { downloader });
    expectSkillError(() => http.stage("https://example.invalid/note.md", { stagingRoot: path.join(paths.skillsStaging, "op-http") }), "skill_not_a_complete_package");
  });

  it("http 网络失败 → skill_source_not_found（明确诊断）", () => {
    const { paths } = makeHarness();
    const downloader = () => ({ ok: false, status: 503, contentType: null, body: Buffer.alloc(0), finalUrl: "https://example.invalid/x" });
    const http = new HttpSkillSource(paths, { downloader });
    expectSkillError(() => http.stage("https://example.invalid/x", { stagingRoot: path.join(paths.skillsStaging, "op-http2") }), "skill_source_not_found");
  });
});
