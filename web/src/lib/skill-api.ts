import { ApiClientError } from "./api-client.js";
import type {
  BundleListResult,
  LinkedSourceStatusView,
  SafeSkillView,
  SetLearningPolicyResult,
  SkillBundleResult,
  SkillDetailResult,
  SkillFileTree,
  SkillInstallResult,
  SkillInspectResult,
  SkillLearningPolicy,
  SkillManageResult,
  SkillRef,
  SkillSearchResult,
  SourceConfigView,
} from "./skill-types.js";

/**
 * Phase 13 T8 Skill API client（plans/phase-13.md §14.1 / §14.4）。
 *
 * - 全部端点基于 T6/T8 冻结契约：/api/skills*、/api/skill-sources、
 *   /api/agents/:id/skills；
 * - `install` 四态：installed（201）/ confirmation_required（202）/
 *   rejected（403）/ failed（400），按 body.status 结构化判断；
 * - `approve` 经 /api/skills/confirmation/:tokenId/approve（一次性令牌）；
 * - Server 未接线（404/405/502/503）时抛 ApiClientError，由页面降级为
 *   「Skill 服务未就绪」空态（与插件中心一致）。
 */
export class SkillApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    if (!response.ok) {
      let error: { code?: string; message?: string; retryable?: boolean; details?: { reasonCode?: string; reason?: string } };
      try {
        error = (await response.json()) as { code?: string; message?: string; retryable?: boolean; details?: { reasonCode?: string; reason?: string } };
      } catch {
        error = {};
      }
      const reasonCode = error.details?.reasonCode;
      if (reasonCode !== undefined) {
        // 结构化失败：保留稳定 reasonCode（SKILL_ERROR_CODES），UI 卡可直接展示
        throw new SkillApiError(
          error.code ?? "UNKNOWN",
          error.message ?? error.details?.reason ?? response.statusText,
          error.retryable ?? false,
          response.status,
          reasonCode,
        );
      }
      throw new ApiClientError(
        error.code ?? "UNKNOWN",
        error.message ?? response.statusText,
        error.retryable ?? false,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  // ── Catalog / 详情 ──────────────────────────────────────────
  async listSkills(): Promise<readonly SafeSkillView[]> {
    return this.request<readonly SafeSkillView[]>("GET", "/api/skills");
  }

  async getSkillDetail(skillRefKey: string): Promise<SafeSkillView> {
    return this.request<SafeSkillView>("GET", `/api/skills/${encodeURIComponent(skillRefKey)}`);
  }

  async getSkillFiles(skillRefKey: string): Promise<SkillFileTree> {
    return this.request<SkillFileTree>("GET", `/api/skills/${encodeURIComponent(skillRefKey)}/files`);
  }

  /** 详情（正文摘要经 loadHandle 受控读取；sessionId 缺省时只返回元数据）。 */
  async getSkillDetailWithBody(skillRefKey: string, sessionId?: string): Promise<SkillDetailResult> {
    return this.request<SkillDetailResult>("POST", "/api/skills/detail", {
      skillRefKey,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }

  // ── 搜索 / 检查 / 安装 / 审批 ────────────────────────────────
  async searchSkills(query: string, scope?: string): Promise<SkillSearchResult> {
    return this.request<SkillSearchResult>("POST", "/api/skills/search", {
      ...(query !== "" ? { query } : {}),
      ...(scope !== undefined ? { scope } : {}),
    });
  }

  async inspectSkill(input: {
    sourceRef?: string;
    kind?: string;
    skillRef?: SkillRef;
    sessionId?: string;
  }): Promise<SkillInspectResult> {
    return this.request<SkillInspectResult>("POST", "/api/skills/inspect", input);
  }

  async installSkill(input: {
    sourceRef: string;
    kind: string;
    agentId?: string;
    sessionId?: string;
    confirmationToken?: string;
  }): Promise<SkillInstallResult> {
    return this.request<SkillInstallResult>("POST", "/api/skills/install", input);
  }

  async approveConfirmation(token: string, input?: { agentId?: string; sessionId?: string }): Promise<{ status: string }> {
    return this.request<{ status: string }>(
      "POST",
      `/api/skills/confirmation/${encodeURIComponent(token)}/approve`,
      input ?? {},
    );
  }

  // ── Agent 绑定 / 选择 / 学习策略 ─────────────────────────────
  async listAgentSkills(agentId: string): Promise<SkillManageResult> {
    return this.request<SkillManageResult>("GET", `/api/agents/${encodeURIComponent(agentId)}/skills`);
  }

  async updateAgentSkills(
    agentId: string,
    body: {
      action: "bind" | "unbind" | "set-selection";
      skillRef?: SkillRef;
      skillRefKey?: string;
      selection?: "implicit" | "explicit-only" | "disabled";
      confirmationToken?: string;
    },
  ): Promise<SkillManageResult> {
    return this.request<SkillManageResult>("PUT", `/api/agents/${encodeURIComponent(agentId)}/skills`, body);
  }

  async setLearningPolicy(agentId: string, policy: SkillLearningPolicy): Promise<SetLearningPolicyResult> {
    return this.request<SetLearningPolicyResult>(
      "PUT",
      `/api/agents/${encodeURIComponent(agentId)}/skills/policy`,
      { policy, confirmed: true },
    );
  }

  // ── Bundle 列表 / 版本化 ─────────────────────────────────────
  async listBundles(bundleId?: string): Promise<BundleListResult> {
    const qs = bundleId !== undefined ? `?bundleId=${encodeURIComponent(bundleId)}` : "";
    return this.request<BundleListResult>("GET", `/api/skills/bundles${qs}`);
  }

  async createBundleVersion(input: {
    bundleId: string;
    name: string;
    items: readonly { readonly skillRef: SkillRef; readonly selection?: "implicit" | "explicit-only" | "disabled" }[];
  }): Promise<SkillBundleResult> {
    return this.request<SkillBundleResult>("POST", "/api/skills/bundles", input);
  }

  // ── 来源与信任配置 / Linked Source 只读 ──────────────────────
  async getSourceConfig(): Promise<SourceConfigView> {
    return this.request<SourceConfigView>("GET", "/api/skill-sources");
  }

  async updateSourceConfig(patch: {
    trustedRoots?: readonly string[];
    disabledKinds?: readonly string[];
    trustedSourceIds?: Readonly<Record<string, boolean>>;
  }): Promise<SourceConfigView> {
    return this.request<SourceConfigView>("PUT", "/api/skill-sources", patch);
  }

  async listLinkedSources(): Promise<readonly LinkedSourceStatusView[]> {
    return this.request<readonly LinkedSourceStatusView[]>("GET", "/api/skills/linked-sources");
  }
}

/**
 * 判断错误是否表示 Skill 服务未就绪（路由未接线 / Server 未启动）。
 */
export function isSkillServiceUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  return error.status === 404 || error.status === 405 || error.status === 502 || error.status === 503;
}

/**
 * 结构化失败错误：Server 返回 4xx/5xx 且 body.details.reasonCode 存在时抛出，
 * 保留稳定 reasonCode（SKILL_ERROR_CODES）供 UI/CLI 展示与诊断。
 */
export class SkillApiError extends ApiClientError {
  readonly reasonCode?: string;

  constructor(code: string, message: string, retryable: boolean, status: number, reasonCode?: string) {
    super(code, message, retryable, status);
    this.name = "SkillApiError";
    if (reasonCode !== undefined && reasonCode !== "") {
      this.reasonCode = reasonCode;
    }
  }
}
