// ═══════════════════════════════════════════════════════════════
// Phase 12 CLI plugins 命令组（plans/phase-12.md §19.4）
//
// `ocf plugins dev ...` 通过 Server HTTP API 调用 /api/plugins/dev/* 端点。
// Server 端点未接线（T10 组合根尚未提供 dev 路由）时返回明确错误。
//
// 子命令：
//   install <sourceDir> [--full-access] [--source-type local]
//   reload <pluginId>
//   enable <pluginId>
//   disable <pluginId>
//   reset <pluginId>
//   uninstall <pluginId>
//   diagnostics <pluginId>
//   invoke-tool <pluginId> <toolName> --agent <agentId> [--session <id>] [--arg k=v ...]
//   list-surfaces
//   describe-surface <pluginId> <surfaceId>
//   run-scenario <pluginId> <scenarioName> [--agent <id>] [--destructive] [--approve] [--arg k=v ...]
//
// devRunId 自动传递：install 成功后把 devRunId 保存到
// ~/.opencolorful/dev-runs.json（key 为 pluginId）；reload 生成新
// devRunId 时同步覆盖；uninstall/reset 后清除。reload/enable/disable/
// reset/uninstall/invoke-tool/run-scenario 未显式指定 --dev-run-id 时
// 自动读取已保存值传入请求体。
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

import { loadEnvironment } from "../../config/environment.js";
import { getRuntimePaths } from "../../config/paths.js";

export async function runPluginsCommand(args: readonly string[]): Promise<void> {
  const command = args[0] ?? "dev";
  if (command === "dev") {
    await runDevCommand(args.slice(1));
    return;
  }
  throw new Error(`未知 plugins 命令: ${command}（当前支持：dev）`);
}

// ═══════════════════════════════════════════════════════════════
// dev 命令组
// ═══════════════════════════════════════════════════════════════

async function runDevCommand(args: readonly string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "install": {
      const [sourceDir] = rest;
      requireValue(sourceDir, "sourceDir（install <sourceDir>）");
      const fullAccess = hasFlag(rest, "--full-access");
      const sourceType = flagValue(rest, "--source-type") ?? "local";
      const state = await post("/api/plugins/dev/install", { sourceDir, fullAccess, sourceType });
      // dev install 成功后保存 Server 返回的 devRunId（后续 dev 子命令自动复用）
      const installed = state as { pluginId?: unknown; devRunId?: unknown };
      if (typeof installed.pluginId === "string" && typeof installed.devRunId === "string" && installed.devRunId !== "") {
        saveDevRun(installed.pluginId, installed.devRunId);
      }
      printState(state);
      return;
    }
    case "reload": {
      const [pluginId] = rest;
      requireValue(pluginId, "pluginId（reload <pluginId>）");
      const devRunId = resolveDevRunId(pluginId, rest);
      const state = await post(`/api/plugins/dev/${encodeURIComponent(pluginId)}/reload`, { devRunId });
      // reload 生成新 devRunId（旧运行上下文失效），CLI 侧同步覆盖保存值
      const reloaded = state as { devRunId?: unknown };
      if (typeof reloaded.devRunId === "string" && reloaded.devRunId !== "") {
        saveDevRun(pluginId, reloaded.devRunId);
      }
      printState(state);
      return;
    }
    case "enable": {
      const [pluginId] = rest;
      requireValue(pluginId, "pluginId（enable <pluginId>）");
      printState(await post(`/api/plugins/dev/${encodeURIComponent(pluginId)}/enable`, { devRunId: resolveDevRunId(pluginId, rest) }));
      return;
    }
    case "disable": {
      const [pluginId] = rest;
      requireValue(pluginId, "pluginId（disable <pluginId>）");
      printState(await post(`/api/plugins/dev/${encodeURIComponent(pluginId)}/disable`, { devRunId: resolveDevRunId(pluginId, rest) }));
      return;
    }
    case "reset": {
      const [pluginId] = rest;
      requireValue(pluginId, "pluginId（reset <pluginId>）");
      const result = await post(`/api/plugins/dev/${encodeURIComponent(pluginId)}/reset`, { devRunId: resolveDevRunId(pluginId, rest) });
      // dev 槽已重置，运行上下文失效 → 清除保存值
      clearDevRun(pluginId);
      console.log(`插件 ${pluginId} dev 槽已重置（${String((result as { status?: string })["status"] ?? "reset")}）`);
      return;
    }
    case "uninstall": {
      const [pluginId] = rest;
      requireValue(pluginId, "pluginId（uninstall <pluginId>）");
      const result = await post(`/api/plugins/dev/${encodeURIComponent(pluginId)}/uninstall`, { devRunId: resolveDevRunId(pluginId, rest) });
      // 已卸载 → 清除保存值
      clearDevRun(pluginId);
      console.log(`插件 ${pluginId} dev 槽已卸载`);
      void result;
      return;
    }
    case "diagnostics": {
      const [pluginId] = rest;
      requireValue(pluginId, "pluginId（diagnostics <pluginId>）");
      const result = await get(`/api/plugins/dev/${encodeURIComponent(pluginId)}/diagnostics`);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "invoke-tool": {
      const [pluginId, toolName] = rest;
      requireValue(pluginId, "pluginId（invoke-tool <pluginId> <toolName>）");
      requireValue(toolName, "toolName（invoke-tool <pluginId> <toolName>）");
      const agentId = flagValue(rest, "--agent");
      requireValue(agentId, "--agent <agentId>（复用真实权限/绑定）");
      const sessionId = flagValue(rest, "--session");
      const args = parseKeyValueArgs(rest, "--arg");
      const result = await post(`/api/plugins/dev/${encodeURIComponent(pluginId)}/invoke-tool`, {
        devRunId: resolveDevRunId(pluginId, rest),
        agentId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        toolName,
        ...(Object.keys(args).length > 0 ? { args } : {}),
      });
      printInvokeResult(result);
      return;
    }
    case "list-surfaces": {
      const result = await get("/api/plugins/dev/surfaces");
      const list = Array.isArray(result) ? result : [];
      if (list.length === 0) {
        console.log("（无已登记 Surface）");
        return;
      }
      for (const item of list) {
        console.log(typeof item === "string" ? item : JSON.stringify(item));
      }
      return;
    }
    case "describe-surface": {
      const [pluginId, surfaceId] = rest;
      requireValue(pluginId, "pluginId（describe-surface <pluginId> <surfaceId>）");
      requireValue(surfaceId, "surfaceId（describe-surface <pluginId> <surfaceId>）");
      const result = await post(`/api/plugins/dev/${encodeURIComponent(pluginId)}/describe-surface`, { surfaceId });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "run-scenario": {
      const [pluginId, scenarioName] = rest;
      requireValue(pluginId, "pluginId（run-scenario <pluginId> <scenarioName>）");
      requireValue(scenarioName, "scenarioName（run-scenario <pluginId> <scenarioName>）");
      const agentId = flagValue(rest, "--agent");
      const destructive = hasFlag(rest, "--destructive");
      const approve = hasFlag(rest, "--approve");
      const args = parseKeyValueArgs(rest, "--arg");
      const result = await post(`/api/plugins/dev/${encodeURIComponent(pluginId)}/run-scenario`, {
        devRunId: resolveDevRunId(pluginId, rest),
        scenarioName,
        ...(agentId !== undefined ? { agentId } : {}),
        ...(destructive ? { destructive: true } : {}),
        ...(approve ? { approval: true } : {}),
        ...(Object.keys(args).length > 0 ? { args } : {}),
      });
      const record = result as { ok?: boolean; result?: unknown; error?: string };
      if (record.ok === true) {
        console.log(`场景 ${scenarioName} 通过：${JSON.stringify(record.result ?? {})}`);
      } else {
        console.error(`场景 ${scenarioName} 失败：${record.error ?? "未知错误"}`);
        process.exitCode = 1;
      }
      return;
    }
    default:
      throw new Error(`未知 plugins dev 命令: ${sub ?? "(空)"}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// devRunId 状态文件（~/.opencolorful/dev-runs.json）
//
// dev install 成功后保存 Server 返回的 devRunId；reload 生成新 devRunId
// 时同步覆盖；uninstall/reset 后清除。其余 dev 子命令自动读取并随请求体
// 传递，用户可用 --dev-run-id 显式覆盖。
// 写文件采用临时文件 + rename 原子替换（与 PreferencesStore 一致）。
// ═══════════════════════════════════════════════════════════════

interface DevRunsDocument {
  version: number;
  devRuns: Record<string, string>;
}

function devRunsPath(): string {
  return path.join(getRuntimePaths().home, "dev-runs.json");
}

function readDevRuns(): DevRunsDocument {
  const filePath = devRunsPath();
  if (!fs.existsSync(filePath)) {
    return { version: 1, devRuns: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { devRuns?: unknown };
    if (parsed !== null && typeof parsed === "object" && typeof parsed.devRuns === "object" && parsed.devRuns !== null) {
      return { version: 1, devRuns: parsed.devRuns as Record<string, string> };
    }
  } catch {
    // 文件损坏/不可解析：按空状态处理，后续写入会重建
  }
  return { version: 1, devRuns: {} };
}

function writeDevRuns(document: DevRunsDocument): void {
  const filePath = devRunsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function saveDevRun(pluginId: string, devRunId: string): void {
  const document = readDevRuns();
  document.devRuns[pluginId] = devRunId;
  writeDevRuns(document);
}

function clearDevRun(pluginId: string): void {
  const document = readDevRuns();
  if (document.devRuns[pluginId] === undefined) {
    return;
  }
  delete document.devRuns[pluginId];
  writeDevRuns(document);
}

function savedDevRunId(pluginId: string): string | undefined {
  return readDevRuns().devRuns[pluginId];
}

/** 解析 devRunId：--dev-run-id 显式值优先，否则回退已保存值；两者皆无 → 清晰中文错误 */
function resolveDevRunId(pluginId: string, args: readonly string[]): string {
  const explicit = flagValue(args, "--dev-run-id");
  if (explicit !== undefined) {
    return explicit;
  }
  const saved = savedDevRunId(pluginId);
  if (saved !== undefined) {
    return saved;
  }
  throw new Error(
    `插件 ${pluginId} 没有已保存的 devRunId（~/.opencolorful/dev-runs.json 无记录）。\n` +
      `请先运行 dev install 安装该插件，或显式指定 --dev-run-id <devRunId>。`,
  );
}

// ═══════════════════════════════════════════════════════════════
// Server HTTP 客户端（dev 端点；未接线时返回明确错误）
// ═══════════════════════════════════════════════════════════════

function baseUrl(): string {
  const environment = loadEnvironment();
  return `http://${environment.host}:${environment.port}`;
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${baseUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法连接 Server（${url}）：${reason}\n请先启动 server（ocf server start）`);
  }
  if (response.status === 404 || response.status === 405 || response.status === 502 || response.status === 503) {
    throw new Error(`Server 的 dev 端点未接线（T10 组合根尚未提供 /api/plugins/dev/* 路由，HTTP ${response.status}）。\n请等待主 Agent 完成 Server 路由接线后再运行 dev 命令。`);
  }
  if (!response.ok) {
    let message = response.statusText;
    try {
      const data = (await response.json()) as { message?: string };
      if (typeof data.message === "string") {
        message = data.message;
      }
    } catch {
      // 非 JSON 错误体
    }
    throw new Error(`HTTP ${response.status}：${message}`);
  }
  return (await response.json()) as unknown;
}

async function post(path: string, body: unknown): Promise<unknown> {
  return request("POST", path, body);
}

async function get(path: string): Promise<unknown> {
  return request("GET", path);
}

// ═══════════════════════════════════════════════════════════════
// 参数解析与输出
// ═══════════════════════════════════════════════════════════════

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function parseKeyValueArgs(args: readonly string[], flag: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = 0;
  while (i < args.length) {
    if (args[i] === flag) {
      const pair = args[i + 1];
      if (pair !== undefined) {
        const separator = pair.indexOf("=");
        if (separator > 0) {
          const key = pair.slice(0, separator);
          const raw = pair.slice(separator + 1);
          result[key] = parseScalar(raw);
        }
      }
      i += 2;
      continue;
    }
    i += 1;
  }
  return result;
}

function parseScalar(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const numeric = Number(raw);
  if (raw.trim() !== "" && !Number.isNaN(numeric)) {
    return numeric;
  }
  return raw;
}

function requireValue(value: string | undefined, what: string): asserts value is string {
  if (value === undefined || value === "") {
    throw new Error(`缺少必填参数：${what}`);
  }
}

function printState(state: unknown): void {
  console.log(JSON.stringify(state, null, 2));
}

function printInvokeResult(result: unknown): void {
  const record = result as { ok?: boolean; result?: unknown; error?: string };
  if (record.ok === true) {
    console.log(JSON.stringify(record.result ?? {}, null, 2));
  } else {
    console.error(record.error ?? "invoke-tool 失败");
    process.exitCode = 1;
  }
}
