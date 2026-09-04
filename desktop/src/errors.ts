import type { SettingsCategory } from "./components/SettingsModal.js";

/**
 * 错误场景上下文。
 * 同一底层错误（如 401）在不同场景下的兜底文案可能不同，
 * 因此需要调用方提供上下文，而不是只传 Error.message。
 */
export type ErrorContext =
  | "send"
  | "compact"
  | "renameThread"
  | "unarchiveThread"
  | "changeModel"
  | "changeThinking"
  | "changeTool"
  | "confirmWorkspace"
  | "switchReadOnly"
  | "listProviders"
  | "saveProvider"
  | "createAgent"
  | "loadLogs"
  | "queryActivity"
  | "loadMoreActivity";

/** 面向用户的错误建议：提示 + 可选下一步动作 + 可选诊断关联引用 */
export interface ErrorAdvice {
  /** 中文可读提示，不出现英文原文或堆栈 */
  readonly message: string;
  /** 下一步动作：label 供按钮显示，category 供调用方打开设置对应分类 */
  readonly action?: {
    readonly label: string;
    readonly category: SettingsCategory;
  };
  /**
   * A5 诊断关联引用（存在时）：安全字符串，仅含 id 与时间戳，
   * 不含任何请求/响应载荷或敏感值；可人工复制，也可跳转日志页预填定位。
   */
  readonly correlation?: ErrorCorrelation;
}

/**
 * A5 诊断关联引用。
 * - origin="server"：traceId 是服务端记录可查的真值（会话路由以 sessionId 作为
 *   traceId 盖章，routes/sessions.ts 的 trace 三元组；turn 失败记录另有 per-turn
 *   traceId，由 ChatView 从最新 failed 记录解析）；
 * - origin="local"：纯 IPC/启动失败没有服务端 traceId，用主进程签发的短 id
 *   （同步落 shell.log）或 renderer 本地生成的短 id。
 */
export interface ErrorCorrelation {
  readonly traceId: string;
  readonly origin: "server" | "local";
  /** 引用生成时间（ISO 8601），用于在日志/诊断记录中定位时间窗 */
  readonly at: string;
}

/** 短引用展示形态：来源前缀 + id 前 8 位；完整 id 经 title/跳转参数传递。
 * 对已带 tr-/ipc- 前缀的 id 幂等（mock fixture 与本地短 id 直接复用原前缀）。 */
export function correlationShortRef(correlation: ErrorCorrelation): string {
  const prefix = correlation.origin === "server" ? "tr-" : "ipc-";
  const raw = correlation.traceId.replace(/^(tr-|ipc-)/, "");
  return `${prefix}${raw.slice(0, 8)}`;
}

/** renderer 本地诊断 id 兜底（主进程 diagRef 不可用时；不含任何用户输入） */
export function localCorrelation(at = new Date()): ErrorCorrelation {
  return { traceId: crypto.randomUUID(), origin: "local", at: at.toISOString() };
}

/** 携带诊断引用的错误：ipc-source 失败点抛出；文案仍按场景映射，correlation 原样透传 */
export class CorrelatedError extends Error {
  readonly correlation: ErrorCorrelation;

  constructor(message: string, correlation: ErrorCorrelation) {
    super(message);
    this.name = "CorrelatedError";
    this.correlation = correlation;
  }
}

/** 场景兜底文案表 */
const FALLBACK: Record<ErrorContext, string> = {
  send: "消息发送失败，请重试。",
  compact: "会话压缩失败，请重试。",
  renameThread: "重命名失败，请重试。",
  unarchiveThread: "恢复会话失败，请重试。",
  changeModel: "模型切换失败，请重试。",
  changeThinking: "思考级别更新失败，请重试。",
  changeTool: "工具模式更新失败，请重试。",
  confirmWorkspace: "工作区确认失败，请重试。",
  switchReadOnly: "切换只读模式失败，请重试。",
  listProviders: "Provider 列表加载失败，请重试。",
  saveProvider: "Provider 保存失败，请检查表单内容后重试。",
  createAgent: "创建助理失败，请重试。",
  loadLogs: "日志加载失败，请重试。",
  queryActivity: "活动事件加载失败，请重试。",
  loadMoreActivity: "加载更多失败，请重试。",
};

function normalize(raw: string): string {
  return raw.toLowerCase();
}

function isOffline(raw: string): boolean {
  const text = normalize(raw);
  return [
    "请求失败（0）",
    "请求失败(0)",
    "fetch failed",
    "econnrefused",
    "econnreset",
    "etimedout",
    "enotfound",
    "connection refused",
    "networkerror",
    "offline",
    "offline",
  ].some((marker) => text.includes(marker));
}

function isBusy(raw: string): boolean {
  const text = normalize(raw);
  return ["409", "busy", "忙", "无法压缩", "正在处理"].some((marker) => text.includes(marker));
}

function isAuth(raw: string): boolean {
  const text = normalize(raw);
  return [
    "401",
    "403",
    "unauthorized",
    "forbidden",
    "invalid api key",
    "api key",
    "apikey",
    "认证",
    "凭据",
    "credential",
    "未配置凭据",
  ].some((marker) => text.includes(marker));
}

function isNoModel(raw: string): boolean {
  const text = normalize(raw);
  return [
    "没有可用模型",
    "未配置模型",
    "no model",
    "no provider",
    "未配置 provider",
    "未配置凭据",
  ].some((marker) => text.includes(marker));
}

function isModelSelectionMissing(raw: string): boolean {
  const text = normalize(raw);
  return ["未选择模型", "请选择模型"].some((marker) => text.includes(marker));
}

function modelsAction(): ErrorAdvice["action"] {
  return { label: "去设置 → 模型与 Provider", category: "models" };
}

function classify(raw: string, context: ErrorContext): ErrorAdvice {
  // 1. 断线 / 离线：优先级最高，避免把网络错误误映射为凭据错误
  if (isOffline(raw)) {
    return {
      message: "连接已断开，请检查本地服务是否运行，恢复后会自动重连。",
    };
  }

  // 2. 凭据失效 / Provider 报错
  if (isAuth(raw)) {
    return {
      message: "API Key 可能已失效或权限不足，无法完成请求。",
      action: modelsAction(),
    };
  }

  // 3. 会话忙（409 / BUSY）
  if (isBusy(raw)) {
    return {
      message: "会话正在处理其他请求，请稍后再试。",
    };
  }

  // 4. 当前草稿尚未显式选择模型（与“没有任何可用模型”区分）
  if (isModelSelectionMissing(raw)) {
    return { message: "请先选择模型，再发送消息。" };
  }

  // 5. Provider / 模型未配置
  if (isNoModel(raw)) {
    return {
      message: "还没有可用模型，请先在设置中配置 Provider 与 API Key。",
      action: modelsAction(),
    };
  }

  // 5. 兜底：用中文场景文案覆盖，不暴露英文原文
  return { message: FALLBACK[context] };
}

/**
 * 将任意异常转换为面向用户的中文错误建议。
 *
 * - 网络层错误（离线、502、fetch 失败等）→ "连接已断开..."
 * - 401/403/API Key 错误 → "API Key 可能已失效..." + 打开设置 models 动作
 * - 409/BUSY → "会话正在处理其他请求，请稍后再试"
 * - 无可用模型 → "还没有可用模型..." + 打开设置 models 动作
 * - 其他 → 按 context 给出中文兜底文案
 */
export function toUserError(cause: unknown, context: ErrorContext): ErrorAdvice {
  const raw = cause instanceof Error ? cause.message : String(cause ?? "");
  const advice = classify(raw, context);
  // A5：CorrelatedError（ipc-source 失败点抛出）把诊断引用透传给 UI，
  // 文案映射不受影响（CorrelatedError 继承 Error，message 分类逻辑一致）
  if (cause instanceof CorrelatedError) return { ...advice, correlation: cause.correlation };
  return advice;
}

/** 将 ErrorAdvice 展平为纯字符串（用于只需要文案、不需要动作按钮的场景） */
export function formatErrorAdvice(advice: ErrorAdvice): string {
  return advice.message;
}
