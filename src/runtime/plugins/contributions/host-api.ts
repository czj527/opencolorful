import type { RuntimePaths } from "../../../config/paths.js";
import type { ManifestRuntime } from "../../../contracts/plugin-protocol.js";
import type { Contributions } from "../../../contracts/plugin-protocol.js";
import type { AuditRecorder } from "../../../observability/audit-recorder.js";
import { createExtensionObservabilityPort } from "../../../observability/extension-port.js";
import { instrument } from "../../../observability/instrument.js";
import type { PluginConfigStore } from "../../../storage/plugin-config-store.js";
import { readManifestFile } from "../sources/source-adapter.js";
import { pluginVersionDir } from "../paths.js";
import type { HostBroker, HostCallContext } from "../grants/host-broker.js";
import type { EffectivePolicy } from "../grants/effective-policy.js";
import type { PluginRegistry } from "../registry/plugin-registry.js";
import type { RuntimeHost } from "../runtimes/runtime-host.js";
import type { ContributionRegistry, ManifestPermissionRequest } from "./contribution-registry.js";
import { ContributionRegistry as ContributionRegistryImpl } from "./contribution-registry.js";
import { AttachmentService } from "./attachment-contribution.js";
import { BackgroundService } from "./background-contribution.js";
import { CommandService } from "./command-contribution.js";
import { ConfigService } from "./config-contribution.js";
import { CustomActivityService } from "./custom-activity-contribution.js";
import { ProviderService } from "./provider-contribution.js";
import { RouteService, validateRoutePath, assertValidRouteMethods } from "./route-contribution.js";
import { SecretService, type PluginSecretStore } from "./secret-contribution.js";
import { SkillBundleService } from "./skill-bundle.js";
import { SurfaceService } from "./surface-contribution.js";
import { ToolService } from "./tool-contribution.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Host API（plans/phase-12.md §8 / §19.2 / §21.2）
//
// - 组装全部 contribution service，统一暴露给 RuntimeHost / HostBroker
//   调用方（主 Agent T10 接线到 start.ts/app.ts）；
// - activate(pluginId)：解析 active 安装的 Manifest → 校验并登记
//   contributions（唯一性/路由路径/Hook 时点）→ 声明 Secret → 注册 Hook
//   → 启动 Runtime；任何失败回滚已登记状态；
// - deactivate(pluginId, reasonCode)：终止后台任务、清除 Hook、注销
//   contribution、停止 Runtime（禁用/更新/卸载统一走这里）；
// - registerHostBrokerApis：把平台中介操作（config/secret/attachment/
//   custom-activity）注册为 HostBroker 白名单 API，插件 worker 只能经
//   broker 调用，不能直接写 Store/spool/Audit。
// ═══════════════════════════════════════════════════════════════

export interface PluginHostApiDeps {
  readonly paths: RuntimePaths;
  readonly registry: PluginRegistry;
  readonly runtimeHost: RuntimeHost;
  readonly broker: HostBroker;
  readonly policy: EffectivePolicy;
  readonly configStore: PluginConfigStore;
  readonly secretStore: PluginSecretStore;
  readonly audit: AuditRecorder;
}

interface ManifestLike {
  readonly id: string;
  readonly version: string;
  readonly trust?: "restricted" | "full-access";
  readonly permissions?: readonly { capability: string; reason?: string }[];
  readonly contributions?: Contributions;
  readonly runtime?: ManifestRuntime;
}

export class PluginHostApi {
  readonly contributions: ContributionRegistry;
  readonly tools: ToolService;
  readonly commands: CommandService;
  readonly providers: ProviderService;
  readonly routes: RouteService;
  readonly surfaces: SurfaceService;
  readonly background: BackgroundService;
  readonly config: ConfigService;
  readonly secrets: SecretService;
  readonly attachments: AttachmentService;
  readonly customActivity: CustomActivityService;
  readonly skills: SkillBundleService;

  constructor(private readonly deps: PluginHostApiDeps) {
    this.contributions = new ContributionRegistryImpl();
    this.secrets = new SecretService({
      registry: this.contributions,
      policy: deps.policy,
      store: deps.secretStore,
      audit: deps.audit,
    });
    this.tools = new ToolService({ registry: this.contributions, policy: deps.policy, runtimeHost: deps.runtimeHost });
    this.commands = new CommandService({ registry: this.contributions, policy: deps.policy, runtimeHost: deps.runtimeHost });
    this.providers = new ProviderService({
      registry: this.contributions,
      policy: deps.policy,
      runtimeHost: deps.runtimeHost,
      secrets: this.secrets,
    });
    this.routes = new RouteService({ registry: this.contributions, policy: deps.policy, runtimeHost: deps.runtimeHost });
    this.surfaces = new SurfaceService({ registry: this.contributions, policy: deps.policy, paths: deps.paths });
    this.background = new BackgroundService({ registry: this.contributions, runtimeHost: deps.runtimeHost, policy: deps.policy });
    this.config = new ConfigService({ registry: this.contributions, store: deps.configStore, audit: deps.audit });
    this.attachments = new AttachmentService({ registry: this.contributions, policy: deps.policy });
    this.customActivity = new CustomActivityService({
      registry: this.contributions,
      portFactory: (pluginId) =>
        createExtensionObservabilityPort({
          manifest: { pluginId, eventNamespace: `plugin.${pluginId}` },
          instrument,
        }),
    });
    this.skills = new SkillBundleService({ registry: this.contributions });
  }

  /**
   * 激活插件：解析 active 安装 Manifest → 校验/登记 contributions →
   * 声明 Secret / 注册 Hook → 启动 Runtime。失败回滚已登记状态。
   */
  async activate(pluginId: string): Promise<void> {
    const active = this.deps.registry.getActive(pluginId);
    if (active === undefined) {
      throw new Error(`插件未安装：${pluginId}`);
    }
    if (active.status === "disabled" || active.status === "removed") {
      throw new Error(`插件 ${pluginId} 状态为 ${active.status}，无法激活`);
    }
    const manifest = this.readManifest(pluginId, active.version);
    const contributions = manifest.contributions ?? {};

    // 1. 登记前校验（fail-closed）：路由 path/方法、Hook 时点
    this.validateContributions(pluginId, contributions);

    // 2. 登记 contribution（唯一性由 Registry 保证）
    const manifestPermissions: ManifestPermissionRequest[] = (manifest.permissions ?? []).map((request) =>
      request.reason !== undefined ? { ...request } : { capability: request.capability },
    );
    this.contributions.register({
      pluginId,
      version: active.version,
      contributions,
      manifestPermissions,
      trust: manifest.trust ?? "restricted",
    });

    try {
      // 3. 声明 Secret / 注册 Hook（无值；Hook 时点平台冻结）
      this.declareSecrets(pluginId, contributions);
      this.background.registerHooks(pluginId);

      // 4. 启动 Runtime（T4）
      await this.deps.runtimeHost.start(pluginId);
    } catch (error) {
      this.background.clearHooks(pluginId);
      this.contributions.unregister(pluginId);
      throw error;
    }
  }

  /** 停用插件：终止后台任务、清除 Hook、注销 contribution、停止 Runtime。 */
  async deactivate(pluginId: string, reasonCode: "plugin_disabled" | "plugin_updated" | "plugin_uninstalled" | "shutdown"): Promise<void> {
    this.background.terminateAll(pluginId, reasonCode);
    this.background.clearHooks(pluginId);
    this.contributions.unregister(pluginId);
    await this.deps.runtimeHost.handoff(pluginId, reasonCode);
  }

  /**
   * 把平台中介操作注册为 HostBroker 白名单 API：插件 worker 只能经
   * broker 调用（携带平台签发身份 + Agent/Session scope）。
   */
  registerHostBrokerApis(): void {
    this.deps.broker.registerApi({
      name: "plugin.host.config.get",
      description: "读取插件配置（非敏感）",
      handler: (ctx, args) => {
        const { agentId } = this.requireAgent(ctx, "plugin.host.config.get");
        return this.config.getConfig(ctx.identity.pluginId, agentId);
      },
    });
    this.deps.broker.registerApi({
      name: "plugin.host.config.set",
      description: "写入插件配置（走严格审计）",
      handler: (ctx, args) => {
        const { agentId } = this.requireAgent(ctx, "plugin.host.config.set");
        const configArgs = this.requireRecord(args, "config.set");
        const config = this.requireRecord(configArgs["config"], "config");
        return this.config.setConfig({
          pluginId: ctx.identity.pluginId,
          agentId,
          config,
          actor: { kind: "plugin", id: ctx.identity.pluginId },
        });
      },
    });
    this.deps.broker.registerApi({
      name: "plugin.host.secret.list-names",
      description: "列出插件已声明 Secret 名称（不含值）",
      handler: (ctx) => this.secrets.listSecretNames(ctx.identity.pluginId),
    });
    this.deps.broker.registerApi({
      name: "plugin.host.secret.read",
      description: "读取插件自身已授权 Secret",
      requiredCapabilities: ["secret.read-own"],
      handler: (ctx, args) => {
        const { agentId } = this.requireAgent(ctx, "plugin.host.secret.read");
        const secretArgs = this.requireRecord(args, "secret");
        const secretName = this.requireString(secretArgs, "secretName");
        return this.secrets.readSecret({
          pluginId: ctx.identity.pluginId,
          secretName,
          agentId,
          ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.snapshot !== undefined ? { snapshot: ctx.snapshot } : {}),
          ...(ctx.state !== undefined ? { state: ctx.state } : {}),
        });
      },
    });
    this.deps.broker.registerApi({
      name: "plugin.host.attachment.validate",
      description: "校验结构化附件（Schema/大小/来源/权限）",
      handler: (ctx, args) => {
        const input = this.requireRecord(args, "attachment");
        const pluginId = ctx.identity.pluginId;
        const typeId = this.requireString(input, "typeId");
        const source = this.requireString(input, "source");
        const result = this.attachments.validateAttachment({
          pluginId,
          typeId,
          value: input["value"],
          source,
          ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
          ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.snapshot !== undefined ? { snapshot: ctx.snapshot } : {}),
          ...(ctx.state !== undefined ? { state: ctx.state } : {}),
        });
        return result;
      },
    });
    this.deps.broker.registerApi({
      name: "plugin.host.custom-activity.emit",
      description: "按注册 namespace 发出自定义 Activity（默认 routine）",
      requiredCapabilities: ["activity.emit"],
      handler: (ctx, args) => {
        const input = this.requireRecord(args, "activity");
        const eventNamespace = this.requireString(input, "eventNamespace");
        const action = this.requireString(input, "action");
        const payload = typeof input["payload"] === "object" && input["payload"] !== null ? input["payload"] as Record<string, unknown> : {};
        return this.customActivity.emit({
          pluginId: ctx.identity.pluginId,
          eventNamespace,
          action,
          payload,
        });
      },
    });
  }

  // ── private helpers ───────────────────────────────────────────

  private readManifest(pluginId: string, version: string): ManifestLike {
    try {
      const raw = readManifestFile(pluginVersionDir(this.deps.paths, pluginId, version)) as unknown;
      if (typeof raw !== "object" || raw === null) {
        throw new Error("manifest 不是对象");
      }
      return raw as ManifestLike;
    } catch (error) {
      throw new Error(`插件 ${pluginId}@${version} manifest 读取失败：${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
    }
  }

  private validateContributions(pluginId: string, contributions: Contributions): void {
    for (const route of contributions.route ?? []) {
      const path = (route as { path?: unknown }).path;
      if (typeof path !== "string") {
        throw new Error(`插件 ${pluginId} 的 route contribution 缺少 path`);
      }
      validateRoutePath(pluginId, path);
      const methods = (route as { methods?: unknown }).methods;
      if (Array.isArray(methods)) {
        assertValidRouteMethods(methods);
      }
    }
    for (const hook of contributions.hook ?? []) {
      // 冻结时点校验由 BackgroundService.registerHooks 承担（这里先暴露非法时点）
      const point = (hook as { point?: unknown }).point;
      if (typeof point !== "string" || point.length === 0) {
        throw new Error(`插件 ${pluginId} 的 hook contribution 缺少 point`);
      }
    }
  }

  private declareSecrets(pluginId: string, contributions: Contributions): void {
    for (const secret of contributions.secret ?? []) {
      const secretName = (secret as { secretName?: unknown }).secretName;
      if (typeof secretName !== "string") {
        throw new Error(`插件 ${pluginId} 的 secret contribution 缺少 secretName`);
      }
      const purpose = (secret as { purpose?: unknown }).purpose;
      this.secrets.declareSecret(pluginId, secretName, typeof purpose === "string" ? purpose : undefined);
    }
  }

  private requireAgent(ctx: HostCallContext, apiName: string): { agentId: string } {
    if (ctx.agentId === undefined) {
      throw new Error(`${apiName} 需要 Agent 上下文`);
    }
    return { agentId: ctx.agentId };
  }

  private requireRecord(value: unknown, what: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${what} 必须是对象`);
    }
    return value as Record<string, unknown>;
  }

  private requireString(source: Record<string, unknown>, key: string): string {
    const value = source[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${key} 必须是字符串`);
    }
    return value;
  }
}
