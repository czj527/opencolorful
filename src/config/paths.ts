import os from "node:os";
import path from "node:path";

export interface RuntimePaths {
  readonly home: string;
  readonly config: string;
  readonly auth: string;
  readonly sessions: string;
  readonly agents: string;
  readonly logs: string;
  readonly runtime: string;
  readonly cache: string;
  readonly database: string;
  readonly providerSettings: string;
  readonly preferences: string;
  readonly authFile: string;
  readonly serverState: string;
  readonly serverLock: string;
  readonly serverLog: string;
  // ── Phase 12 插件目录（plans/phase-12.md §7.2）──
  // 所有路径由 paths.ts 统一生成，调用方不得自行拼接用户数据目录
  readonly pluginsInstalled: string;
  readonly pluginsStaging: string;
  readonly pluginsData: string;
  readonly pluginsCache: string;
  readonly pluginsDev: string;
  readonly pluginDevSources: string;
  readonly pluginSources: string;
  readonly pluginSecrets: string;
  // ── Phase 13 Skill 目录（plans/phase-13.md §9.2）──
  // 正文仍在文件系统（不可变 Managed Artifact / Linked Source / 缓存 / 内置投影）
  readonly skillsInstalled: string;
  readonly skillsStaging: string;
  readonly skillsCache: string;
  readonly skillsBuiltin: string;
  readonly skillDevSources: string;
  readonly skillSources: string;
  // ── Phase 14 Subagent 目录（plans/phase-14.md §16.3）──
  // 约定：<subagentsBase>/<ownerAgentId>/subagents/<threadId>/（session.jsonl + artifacts/）
  readonly subagentsBase: string;
}

export function getRuntimePaths(environment: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const override = environment.OPENCOLORFUL_HOME?.trim();
  const home = override ? path.resolve(override) : path.join(os.homedir(), ".opencolorful");
  const config = path.join(home, "config");
  const auth = path.join(home, "auth");
  const logs = path.join(home, "logs");
  const runtime = path.join(home, "runtime");

  return {
    home,
    config,
    auth,
    sessions: path.join(home, "sessions"),
    agents: path.join(home, "agents"),
    logs,
    runtime,
    cache: path.join(home, "cache"),
    database: path.join(home, "metadata.sqlite"),
    providerSettings: path.join(config, "providers.json"),
    preferences: path.join(config, "preferences.json"),
    authFile: path.join(auth, "auth.json"),
    serverState: path.join(runtime, "server.json"),
    serverLock: path.join(runtime, "server.lock"),
    serverLog: path.join(logs, "server.log"),
    pluginsInstalled: path.join(home, "plugins", "installed"),
    pluginsStaging: path.join(home, "plugins", "staging"),
    pluginsData: path.join(home, "plugins", "data"),
    pluginsCache: path.join(home, "plugins", "cache"),
    pluginsDev: path.join(home, "plugins-dev"),
    pluginDevSources: path.join(home, "plugin-dev-sources"),
    pluginSources: path.join(config, "plugin-sources.json"),
    pluginSecrets: path.join(auth, "plugin-secrets.json"),
    skillsInstalled: path.join(home, "skills", "installed"),
    skillsStaging: path.join(home, "skills", "staging"),
    skillsCache: path.join(home, "skills", "cache"),
    skillsBuiltin: path.join(home, "skills", "builtin"),
    skillDevSources: path.join(home, "skill-dev-sources"),
    skillSources: path.join(config, "skill-sources.json"),
    // Phase 14：agents 根目录——Subagent Thread 目录由
    // <subagentsBase>/<ownerAgentId>/subagents/<threadId> 生成（threadId 为平台
    // 生成的稳定 ID，调用方不得拼接用户提供的路径片段）
    subagentsBase: path.join(home, "agents"),
  };
}
