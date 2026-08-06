import type { RuntimePaths } from "../../../config/paths.js";
import { ArchiveSkillSource } from "./archive-source.js";
import { BuiltinSkillSource } from "./builtin-source.js";
import { ExternalLocalSkillSource } from "./external-local-source.js";
import { GitSkillSource, type GitCommandRunner } from "./git-source.js";
import { HttpSkillSource, type HttpDownloader } from "./http-source.js";
import { ManagedSkillSource } from "./managed-source.js";
import { PluginSkillSource, type PluginSkillBundleProvider } from "./plugin-source.js";
import { WorkspaceSkillSource } from "./workspace-source.js";
import { OpenClawSkillSource } from "./openclaw-skill-source.js";
import { HermesSkillSource } from "./hermes-skill-source.js";
import type { SkillSourceAdapter } from "./skill-source-adapter.js";
import type { SkillTrustPolicy } from "./trust-config.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 标准来源适配器集合（plans/phase-13.md §8.1 / §8.3）
//
// - T6/T8 组合根用 createStandardAdapters 一次性构建全部适配器；
// - git/http 的 exec/downloader 可注入（单元测试/离线 CI 不请求真实网络）；
// - workspace 只在提供 trust + cwd/home 时加入；plugin 只在提供 provider 时加入。
// ═══════════════════════════════════════════════════════════════

export interface SkillAdapterFactoryOptions {
  readonly workspace?: { readonly cwd: string; readonly home: string; readonly trust: SkillTrustPolicy };
  readonly externalTrust?: SkillTrustPolicy;
  readonly pluginProvider?: PluginSkillBundleProvider;
  readonly gitExec?: GitCommandRunner;
  readonly httpDownloader?: HttpDownloader;
  readonly httpMaxBytes?: number;
  /** T9：OpenClaw/Hermes 本地镜像目录（固定版本夹具；缺省无市场可用但诊断明确） */
  readonly ecosystemRegistryDir?: string;
}

export function createStandardAdapters(paths: RuntimePaths, options: SkillAdapterFactoryOptions = {}): readonly SkillSourceAdapter[] {
  const adapters: SkillSourceAdapter[] = [
    new BuiltinSkillSource(paths),
    new ManagedSkillSource(paths),
    new ArchiveSkillSource(paths),
    new GitSkillSource(paths, { ...(options.gitExec !== undefined ? { exec: options.gitExec } : {}) }),
    new HttpSkillSource(paths, {
      ...(options.httpDownloader !== undefined ? { downloader: options.httpDownloader } : {}),
      ...(options.httpMaxBytes !== undefined ? { maxBytes: options.httpMaxBytes } : {}),
    }),
    // T9：生态适配器（离线优先：本地镜像；无镜像时明确诊断，不伪装"没有 Skill"）
    new OpenClawSkillSource({ ...(options.ecosystemRegistryDir !== undefined ? { registryDir: options.ecosystemRegistryDir } : {}) }),
    new HermesSkillSource({ ...(options.ecosystemRegistryDir !== undefined ? { registryDir: options.ecosystemRegistryDir } : {}) }),
  ];
  if (options.workspace !== undefined) {
    adapters.push(new WorkspaceSkillSource(options.workspace));
  }
  if (options.externalTrust !== undefined) {
    adapters.push(new ExternalLocalSkillSource(options.externalTrust));
  }
  if (options.pluginProvider !== undefined) {
    adapters.push(new PluginSkillSource({ provider: options.pluginProvider }));
  }
  return adapters;
}
