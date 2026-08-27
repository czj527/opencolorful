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

/** 面向用户的错误建议：提示 + 可选下一步动作 */
export interface ErrorAdvice {
  /** 中文可读提示，不出现英文原文或堆栈 */
  readonly message: string;
  /** 下一步动作：label 供按钮显示，category 供调用方打开设置对应分类 */
  readonly action?: {
    readonly label: string;
    readonly category: SettingsCategory;
  };
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

  // 4. Provider / 模型未配置
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
  return classify(raw, context);
}

/** 将 ErrorAdvice 展平为纯字符串（用于只需要文案、不需要动作按钮的场景） */
export function formatErrorAdvice(advice: ErrorAdvice): string {
  return advice.message;
}
