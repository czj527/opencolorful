/**
 * Web 会话命令注册表（v1）。
 * 输入框首字符为 `/` 时弹出命令面板；命令消息本身不发送给 LLM。
 * 注意：TUI 现有 switch 本阶段不动，后续收敛为共享命令目录。
 */

export type CommandName = "help" | "compact" | "new" | "abort" | "clear";

export interface ChatCommand {
  /** 命令名（不含斜杠） */
  readonly name: CommandName;
  /** 面板中展示的命令（含斜杠） */
  readonly usage: string;
  /** 中文描述 */
  readonly description: string;
}

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  { name: "help", usage: "/help", description: "显示可用命令帮助" },
  { name: "compact", usage: "/compact", description: "压缩当前会话上下文" },
  { name: "new", usage: "/new", description: "新建会话" },
  { name: "abort", usage: "/abort", description: "中断当前生成" },
  { name: "clear", usage: "/clear", description: "清空输入框" },
];

/** 解析输入文本为命令名；首字符不是 `/` 或无法匹配时返回 null */
export function parseCommandName(input: string): CommandName | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const name = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
  const command = CHAT_COMMANDS.find((candidate) => candidate.name === name);
  return command?.name ?? null;
}

/** 按已输入的前缀过滤命令（不含斜杠的查询串） */
export function filterCommands(query: string): readonly ChatCommand[] {
  const normalized = query.toLowerCase();
  if (normalized === "") return CHAT_COMMANDS;
  return CHAT_COMMANDS.filter((command) => command.name.startsWith(normalized));
}

/** 从输入值提取命令查询串；首字符为 `/` 时返回后续文本，否则返回 null */
export function extractCommandQuery(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const rest = value.slice(1);
  // 含空白说明已越过命令名进入参数区，v1 命令均无参数，不再展示面板
  if (/\s/.test(rest)) return null;
  return rest;
}

/** 命令执行上下文：由 WorkspaceApp 接线注入 */
export interface CommandExecutorContext {
  /** 是否有进行中的生成 */
  readonly running: boolean;
  readonly onCompact: () => Promise<CommandOutcome>;
  readonly onNewSession: () => void;
  readonly onAbort: () => void;
}

export type CommandOutcome =
  | { readonly kind: "card"; readonly title: string; readonly lines: readonly string[]; readonly tone?: "info" | "error" }
  | { readonly kind: "clear" }
  | { readonly kind: "none" };

/** 帮助卡片内容（列出全部可用命令与说明） */
export function buildHelpCardLines(): readonly string[] {
  return CHAT_COMMANDS.map((command) => `${command.usage} — ${command.description}`);
}

/**
 * 执行命令，返回需要插入时间线的本地卡片内容（或不插入）。
 * 命令消息本身不发送给 LLM；执行后由调用方清空输入框。
 */
export async function executeCommand(
  name: CommandName,
  context: CommandExecutorContext,
): Promise<CommandOutcome> {
  switch (name) {
    case "help":
      return { kind: "card", title: "可用命令", lines: buildHelpCardLines(), tone: "info" };
    case "compact":
      return context.onCompact();
    case "new":
      context.onNewSession();
      return { kind: "none" };
    case "abort":
      if (!context.running) {
        return { kind: "card", title: "提示", lines: ["当前没有进行中的生成"], tone: "info" };
      }
      context.onAbort();
      return { kind: "card", title: "提示", lines: ["已发送中断请求"], tone: "info" };
    case "clear":
      return { kind: "clear" };
  }
}
