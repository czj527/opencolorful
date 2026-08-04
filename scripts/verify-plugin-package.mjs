#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Phase 12 插件包质量门（plans/phase-12.md §15 / §19.4 / §23）
//
// 用法：
//   node scripts/verify-plugin-package.mjs <plugin-dir> [<plugin-dir> ...]
//
// 独立 Node 校验（不依赖 typebox / 协议包构建产物），适用于插件作者
// 在发布前校验 manifest.json 是否符合 Phase 12 Manifest v1 契约：
// - 顶层字段、id/version/兼容范围、trust、runtime、permissions、
//   contributions 逐类字段与必填项、config/dev；
// - 文件存在性：代码运行时 entry、surface entry、skills 目录、
//   dev/scenarios/*.json 可解析且结构合法；
// - 未知字段默认拒绝（与 ManifestV1Schema additionalProperties:false 对齐）。
// 任何错误输出到 stderr 并以非零码退出。
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const TRUST_LEVELS = new Set(["restricted", "full-access"]);
const RUNTIME_KINDS = new Set(["bundle", "mcp", "node-process", "python-process"]);
const CAPABILITIES = new Set([
  "filesystem.read", "filesystem.write", "network.connect", "process.spawn",
  "secret.read-own", "provider.register", "tool.register", "route.register",
  "ui.surface", "ui.host.external-open", "ui.host.clipboard",
  "resource.open", "resource.pick", "background.run", "hook.register", "activity.emit",
]);

const TOP_LEVEL_KEYS = new Set([
  "manifestVersion", "id", "name", "version", "description", "author", "license",
  "compatibility", "trust", "runtime", "permissions", "contributions", "config", "dev",
]);

const CONTRIBUTION_KINDS = new Set([
  "tool", "command", "provider", "route", "page", "widget", "chat-surface",
  "background", "hook", "config", "secret", "context-attachment",
  "custom-activity", "skill-bundle",
]);

const CONTRIBUTION_ALLOWED_KEYS = {
  tool: new Set(["id", "name", "description", "requiredCapabilities", "inputSchema", "outputSchema", "riskLevel"]),
  command: new Set(["id", "name", "description", "requiredCapabilities", "argumentsSchema"]),
  provider: new Set(["id", "name", "description", "requiredCapabilities", "configSchema", "kind"]),
  route: new Set(["id", "name", "description", "requiredCapabilities", "path", "methods"]),
  page: new Set(["id", "name", "description", "requiredCapabilities", "entry", "hostCapabilities"]),
  widget: new Set(["id", "name", "description", "requiredCapabilities", "entry", "hostCapabilities"]),
  "chat-surface": new Set(["id", "name", "description", "requiredCapabilities", "entry", "hostCapabilities"]),
  background: new Set(["id", "name", "description", "requiredCapabilities", "maxConcurrency", "maxRetries", "timeoutMs"]),
  hook: new Set(["id", "name", "description", "requiredCapabilities", "point", "behavior"]),
  config: new Set(["id", "name", "description", "requiredCapabilities", "schema"]),
  secret: new Set(["id", "name", "description", "requiredCapabilities", "secretName", "purpose"]),
  "context-attachment": new Set(["id", "name", "description", "requiredCapabilities", "schema"]),
  "custom-activity": new Set(["id", "name", "description", "requiredCapabilities", "eventNamespace", "payloadSchema"]),
  "skill-bundle": new Set(["id", "name", "description", "requiredCapabilities", "skillsDir"]),
};

const AUTHOR_KEYS = new Set(["name", "email", "url"]);
const DEV_KEYS = new Set(["sourceDir", "engines"]);

const errors = [];
function error(pluginDir, message) {
  errors.push(`${pluginDir}: ${message}`);
}

function verifyPluginDir(pluginDir) {
  const root = path.resolve(pluginDir);
  if (!fs.existsSync(path.join(root, "manifest.json"))) {
    error(root, "缺少 manifest.json");
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  } catch (parseError) {
    error(root, `manifest.json 不是合法 JSON：${parseError.message}`);
    return;
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    error(root, "manifest 顶层必须是 JSON 对象");
    return;
  }

  // ── 顶层字段与版本 ─────────────────────────────────────────
  for (const key of Object.keys(manifest)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      error(root, `未知顶层字段 "${key}"（默认拒绝）`);
    }
  }
  if (manifest.manifestVersion !== 1) {
    error(root, `manifestVersion 必须为 1（收到 ${JSON.stringify(manifest.manifestVersion)}）`);
  }
  if (typeof manifest.id !== "string" || !PLUGIN_ID_PATTERN.test(manifest.id)) {
    error(root, `id 不合法（需匹配 ${PLUGIN_ID_PATTERN}）`);
  }
  if (typeof manifest.version !== "string" || !SEMVER_PATTERN.test(manifest.version)) {
    error(root, `version 不合法（需为 SemVer，收到 ${JSON.stringify(manifest.version)}）`);
  }
  if (typeof manifest.name !== "string" || manifest.name.length < 1 || manifest.name.length > 128) {
    error(root, "name 必须是 1-128 字符的字符串");
  }
  if (manifest.description !== undefined && (typeof manifest.description !== "string" || manifest.description.length > 1024)) {
    error(root, "description 必须是 ≤1024 字符的字符串");
  }
  if (manifest.author !== undefined) {
    if (typeof manifest.author !== "object" || manifest.author === null) {
      error(root, "author 必须是对象");
    } else {
      for (const key of Object.keys(manifest.author)) {
        if (!AUTHOR_KEYS.has(key)) {
          error(root, `author 未知字段 "${key}"`);
        }
      }
      if (typeof manifest.author.name !== "string" || manifest.author.name.length < 1) {
        error(root, "author.name 必须是非空字符串");
      }
    }
  }
  if (manifest.license !== undefined && (typeof manifest.license !== "string" || manifest.license.length < 1 || manifest.license.length > 128)) {
    error(root, "license 必须是 1-128 字符的字符串");
  }

  // ── compatibility / trust / runtime ─────────────────────────
  const compatibility = manifest.compatibility;
  if (typeof compatibility !== "object" || compatibility === null) {
    error(root, "compatibility 必须是对象");
  } else {
    if (compatibility.pluginApi !== 1) {
      error(root, `compatibility.pluginApi 必须为 1（收到 ${JSON.stringify(compatibility.pluginApi)}）`);
    }
    if (typeof compatibility.opencolorful !== "string" || compatibility.opencolorful.length < 1 || compatibility.opencolorful.length > 64) {
      error(root, "compatibility.opencolorful 必须是非空版本范围字符串");
    }
  }
  if (!TRUST_LEVELS.has(manifest.trust)) {
    error(root, `trust 必须为 restricted 或 full-access（收到 ${JSON.stringify(manifest.trust)}）`);
  }
  const runtime = manifest.runtime;
  if (typeof runtime !== "object" || runtime === null) {
    error(root, "runtime 必须是对象");
  } else {
    if (!RUNTIME_KINDS.has(runtime.kind)) {
      error(root, `runtime.kind 不合法（收到 ${JSON.stringify(runtime.kind)}）`);
    }
    if (runtime.entry !== undefined && (typeof runtime.entry !== "string" || runtime.entry.length < 1 || runtime.entry.length > 256)) {
      error(root, "runtime.entry 必须是 1-256 字符的字符串");
    }
    if (runtime.kind !== "bundle") {
      if (typeof runtime.entry !== "string" || runtime.entry.length < 1) {
        error(root, `代码/进程运行时（${runtime.kind}）必须声明 runtime.entry`);
      } else if (!fs.existsSync(path.join(root, runtime.entry))) {
        error(root, `runtime.entry 文件不存在：${runtime.entry}`);
      }
      if (runtime.kind === "node-process" || runtime.kind === "python-process") {
        if (manifest.trust !== "full-access") {
          error(root, `代码运行时（${runtime.kind}）必须声明 trust: full-access`);
        }
      }
    }
  }

  // ── permissions ─────────────────────────────────────────────
  const permissions = manifest.permissions;
  if (!Array.isArray(permissions) || permissions.length > 256) {
    error(root, "permissions 必须是数组（≤256 项）");
  } else {
    const seen = new Set();
    for (const request of permissions) {
      if (typeof request !== "object" || request === null) {
        error(root, "permission 必须是对象");
        continue;
      }
      if (!CAPABILITIES.has(request.capability)) {
        error(root, `permission 能力不合法：${JSON.stringify(request.capability)}`);
      }
      if (seen.has(request.capability)) {
        error(root, `permission 能力重复：${request.capability}`);
      }
      seen.add(request.capability);
      if (request.reason !== undefined && (typeof request.reason !== "string" || request.reason.length > 512)) {
        error(root, "permission.reason 必须是 ≤512 字符的字符串");
      }
    }
  }

  // ── contributions ───────────────────────────────────────────
  const contributions = manifest.contributions;
  if (typeof contributions !== "object" || contributions === null) {
    error(root, "contributions 必须是对象");
  } else {
    const seenContributionIds = new Set();
    for (const [kind, list] of Object.entries(contributions)) {
      if (!CONTRIBUTION_KINDS.has(kind)) {
        error(root, `未知 contribution 种类 "${kind}"`);
        continue;
      }
      if (!Array.isArray(list) || list.length > 256) {
        error(root, `contributions.${kind} 必须是数组（≤256 项）`);
        continue;
      }
      for (const item of list) {
        verifyContribution(root, kind, item, seenContributionIds);
      }
    }
  }

  // ── config / dev ────────────────────────────────────────────
  if (manifest.config !== undefined) {
    if (typeof manifest.config !== "object" || manifest.config === null || Array.isArray(manifest.config)) {
      error(root, "config 必须是 JSON Schema 对象");
    }
  }
  if (manifest.dev !== undefined) {
    if (typeof manifest.dev !== "object" || manifest.dev === null) {
      error(root, "dev 必须是对象");
    } else {
      for (const key of Object.keys(manifest.dev)) {
        if (!DEV_KEYS.has(key)) {
          error(root, `dev 未知字段 "${key}"`);
        }
      }
      if (manifest.dev.sourceDir !== undefined && typeof manifest.dev.sourceDir !== "string") {
        error(root, "dev.sourceDir 必须是字符串");
      }
    }
  }

  // ── dev/scenarios 示例场景文件 ──────────────────────────────
  verifyScenarios(root);
}

function verifyContribution(root, kind, item, seenIds) {
  if (typeof item !== "object" || item === null) {
    error(root, `contributions.${kind} 项必须是对象`);
    return;
  }
  for (const key of Object.keys(item)) {
    const allowed = CONTRIBUTION_ALLOWED_KEYS[kind];
    if (allowed !== undefined && !allowed.has(key)) {
      error(root, `contributions.${kind} 未知字段 "${key}"（kind=${kind}）`);
    }
  }
  if (typeof item.id !== "string" || item.id.length < 1 || item.id.length > 128) {
    error(root, `contributions.${kind} 缺少合法 id`);
  } else if (seenIds.has(item.id)) {
    error(root, `contributions.${kind} id 重复：${item.id}`);
  }
  seenIds.add(item.id);
  if (typeof item.name !== "string" || item.name.length < 1 || item.name.length > 128) {
    error(root, `contributions.${kind}(${item.id}) 缺少合法 name`);
  }
  if (item.requiredCapabilities !== undefined) {
    if (!Array.isArray(item.requiredCapabilities)) {
      error(root, `contributions.${kind}(${item.id}) requiredCapabilities 必须是数组`);
    } else {
      for (const capability of item.requiredCapabilities) {
        if (!CAPABILITIES.has(capability)) {
          error(root, `contributions.${kind}(${item.id}) 声明了平台不支持的能力：${JSON.stringify(capability)}`);
        }
      }
    }
  }
  // kind 专属必填与文件存在性
  switch (kind) {
    case "route":
      if (typeof item.path !== "string" || item.path.length < 1) {
        error(root, `contributions.route(${item.id}) 缺少 path`);
      }
      break;
    case "secret":
      if (typeof item.secretName !== "string" || item.secretName.length < 1 || item.secretName.length > 128) {
        error(root, `contributions.secret(${item.id}) 缺少合法 secretName`);
      }
      break;
    case "hook":
      if (typeof item.point !== "string" || item.point.length < 1) {
        error(root, `contributions.hook(${item.id}) 缺少 point`);
      }
      break;
    case "custom-activity":
      if (typeof item.eventNamespace !== "string" || item.eventNamespace.length < 1) {
        error(root, `contributions.custom-activity(${item.id}) 缺少 eventNamespace`);
      }
      break;
    case "page":
    case "widget":
    case "chat-surface":
      if (typeof item.entry === "string" && item.entry.length > 0) {
        if (!fs.existsSync(path.join(root, item.entry))) {
          error(root, `contributions.${kind}(${item.id}) entry 文件不存在：${item.entry}`);
        }
      }
      break;
    case "skill-bundle":
      if (typeof item.skillsDir === "string" && item.skillsDir.length > 0) {
        if (!fs.existsSync(path.join(root, item.skillsDir))) {
          error(root, `contributions.skill-bundle(${item.id}) skillsDir 目录不存在：${item.skillsDir}`);
        }
      }
      break;
    default:
      break;
  }
}

function verifyScenarios(root) {
  const scenariosDir = path.join(root, "dev", "scenarios");
  if (!fs.existsSync(scenariosDir)) {
    return; // dev/scenarios 可选
  }
  if (!fs.statSync(scenariosDir).isDirectory()) {
    error(root, "dev/scenarios 不是目录");
    return;
  }
  for (const name of fs.readdirSync(scenariosDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const file = path.join(scenariosDir, name);
    let scenario;
    try {
      scenario = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (parseError) {
      error(root, `dev/scenarios/${name} 不是合法 JSON：${parseError.message}`);
      continue;
    }
    if (typeof scenario !== "object" || scenario === null) {
      error(root, `dev/scenarios/${name} 必须是对象`);
      continue;
    }
    if (typeof scenario.name !== "string" || scenario.name.length < 1) {
      error(root, `dev/scenarios/${name} 缺少 name`);
    }
    if (!Array.isArray(scenario.steps) || scenario.steps.length < 1) {
      error(root, `dev/scenarios/${name} steps 必须是非空数组`);
    } else {
      for (const step of scenario.steps) {
        if (typeof step !== "object" || step === null || typeof step.kind !== "string") {
          error(root, `dev/scenarios/${name} 步骤缺少 kind`);
          continue;
        }
        if (step.kind === "invoke-tool" && typeof step.tool !== "string") {
          error(root, `dev/scenarios/${name} invoke-tool 步骤缺少 tool`);
        }
        if (step.kind === "open-surface" && typeof step.surface !== "string") {
          error(root, `dev/scenarios/${name} open-surface 步骤缺少 surface`);
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("用法：node scripts/verify-plugin-package.mjs <plugin-dir> [<plugin-dir> ...]");
    process.exit(2);
  }
  for (const target of targets) {
    verifyPluginDir(target);
  }
  if (errors.length > 0) {
    for (const line of errors) {
      console.error(`✗ ${line}`);
    }
    console.error(`\nverify-plugin-package: FAIL（${errors.length} 个问题）`);
    process.exit(1);
  }
  console.log("verify-plugin-package: OK");
}

export { verifyPluginDir, errors };
