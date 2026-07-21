import * as readline from "node:readline";

import { TuiApiClient } from "./api-client.js";
import { TuiEventClient, type TuiEvent } from "./event-client.js";
import { DIM, RESET, renderEvent } from "./render-event.js";

type AppState =
  | { name: "connecting" }
  | { name: "main" }
  | { name: "chat"; sessionId: string; streamId?: string };

export class TuiApp {
  private readonly api: TuiApiClient;
  private readonly events: TuiEventClient;
  private readonly rl: readline.Interface;
  private state: AppState = { name: "connecting" };
  private running = true;

  constructor(baseUrl: string) {
    this.api = new TuiApiClient(baseUrl);
    this.events = new TuiEventClient(this.api);
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "",
    });
  }

  async start(): Promise<void> {
    this.rl.on("line", (line) => {
      this.handleInput(line.trim());
    });

    this.rl.on("SIGINT", () => {
      if (this.state.name === "chat" && this.state.streamId) {
        this.write("[中断] 发送 Abort...\n");
        this.api
          .abort(this.state.sessionId, this.state.streamId)
          .then(() => {
            this.write("已中断\n");
          })
          .catch(() => {
            this.write("中断失败\n");
          });
      } else {
        this.stop();
      }
    });

    try {
      const health = await this.api.getHealth();
      this.state = { name: "main" };
      this.write(
        `person-agent TUI — Server ${health.status} v${health.version}\n`,
      );
      this.write("输入 /help 查看命令\n\n");
      this.prompt();
    } catch {
      this.write("无法连接 Server，请确认 Server 已启动\n");
      this.stop();
    }
  }

  private stop(): void {
    this.running = false;
    this.events.disconnect();
    this.rl.close();
    process.exit(0);
  }

  private write(text: string): void {
    process.stdout.write(text);
  }

  private prompt(): void {
    if (!this.running) return;
    this.rl.setPrompt("> ");
    this.rl.prompt();
  }

  private async handleInput(input: string): Promise<void> {
    if (!input) {
      this.prompt();
      return;
    }

    if (input.startsWith("/")) {
      await this.handleCommand(input.slice(1));
    } else if (this.state.name === "chat") {
      await this.sendPrompt(input);
    } else {
      this.write("请先进入聊天模式: /chat <sessionId>\n");
      this.prompt();
    }
  }

  private async handleCommand(cmd: string): Promise<void> {
    const [name, ...args] = cmd.split(/\s+/);
    const rest = args.join(" ");

    switch (name) {
      case "help":
        this.showHelp();
        break;
      case "sessions":
        await this.listSessions();
        break;
      case "new":
        await this.createSession(rest);
        break;
      case "open":
      case "chat":
        await this.enterChat(rest);
        break;
      case "models":
        await this.listModels();
        break;
      case "health":
        await this.showHealth();
        break;
      case "abort":
        if (this.state.name === "chat" && this.state.streamId) {
          await this.doAbort(this.state.sessionId, this.state.streamId);
        } else {
          this.write("当前没有活跃的流可以中断\n");
        }
        break;
      case "quit":
      case "exit":
        this.stop();
        return;
      default:
        this.write(`未知命令: /${name}，输入 /help 查看帮助\n`);
    }
    if (this.running) this.prompt();
  }

  private showHelp(): void {
    this.write("可用命令:\n");
    this.write("  /sessions              列出所有会话\n");
    this.write("  /new <标题>            创建新会话\n");
    this.write("  /open <sessionId>      打开并进入会话\n");
    this.write("  /chat <sessionId>      同上\n");
    this.write("  /models                列出可用模型\n");
    this.write("  /health                Server 状态\n");
    this.write("  /abort                 中断当前流\n");
    this.write("  /quit                  退出\n");
    this.write("\n聊天模式下直接输入文本即可发送 Prompt\n");
    this.write("Ctrl+C 可中断当前流\n");
  }

  private async listSessions(): Promise<void> {
    try {
      const sessions = await this.api.listSessions();
      if (sessions.length === 0) {
        this.write("暂无会话\n");
        return;
      }
      for (const s of sessions) {
        this.write(
          `  ${s.id.slice(0, 8)}... ${s.title} [${s.messages.length} 条消息]\n`,
        );
      }
    } catch (error) {
      this.write(`获取会话列表失败: ${String(error)}\n`);
    }
  }

  private async createSession(title: string): Promise<void> {
    if (!title) {
      this.write("用法: /new <标题>\n");
      return;
    }
    try {
      const session = await this.api.createSession(title, process.cwd());
      this.write(`已创建会话: ${session.id}\n`);
    } catch (error) {
      this.write(`创建失败: ${String(error)}\n`);
    }
  }

  private async enterChat(sessionId: string): Promise<void> {
    if (!sessionId) {
      this.write("用法: /chat <sessionId>\n");
      return;
    }
    try {
      const session = await this.api.getSession(sessionId);
      this.state = { name: "chat", sessionId: session.id };
      this.write(`进入会话: ${session.title}\n`);
      if (session.messages.length > 0) {
        this.write("历史消息:\n");
        for (const msg of session.messages.slice(-5)) {
          this.write(`  ${DIM}${msg.slice(0, 120)}${RESET}\n`);
        }
      }

      // 建立 SSE 连接接收事件
      this.events.connect(sessionId, (event) => {
        this.handleEvent(event);
      });
    } catch (error) {
      this.write(`打开会话失败: ${String(error)}\n`);
    }
  }

  private async listModels(): Promise<void> {
    try {
      const models = await this.api.listModels();
      if (models.length === 0) {
        this.write("暂无可用模型\n");
        return;
      }
      for (const m of models.slice(0, 20)) {
        this.write(`  ${m.providerId}/${m.modelId}: ${m.name}\n`);
      }
      if (models.length > 20) {
        this.write(`  ... 共 ${models.length} 个模型\n`);
      }
    } catch (error) {
      this.write(`获取模型列表失败: ${String(error)}\n`);
    }
  }

  private async showHealth(): Promise<void> {
    try {
      const health = await this.api.getHealth();
      this.write(
        `Server: ${health.status} v${health.version} ` +
          `uptime ${health.uptimeSeconds}s\n`,
      );
    } catch {
      this.write("Server 不可达\n");
    }
  }

  private async sendPrompt(text: string): Promise<void> {
    if (this.state.name !== "chat") return;
    try {
      const result = await this.api.sendPrompt(this.state.sessionId, text);
      this.state = { ...this.state, streamId: result.streamId };
    } catch (error) {
      this.write(`发送失败: ${String(error)}\n`);
    }
  }

  private async doAbort(
    sessionId: string,
    streamId: string,
  ): Promise<void> {
    try {
      const result = await this.api.abort(sessionId, streamId);
      this.write(`中断结果: ${result.status}\n`);
      if (this.state.name === "chat") {
        this.state = { name: "chat", sessionId: this.state.sessionId };
      }
    } catch (error) {
      this.write(`中断失败: ${String(error)}\n`);
    }
  }

  private handleEvent(event: TuiEvent): void {
    const output = renderEvent(event);
    if (output !== undefined) {
      process.stdout.write(output);
      if (
        event.type === "message.completed" ||
        event.type === "turn.completed" ||
        event.type === "session.status" ||
        event.type === "error"
      ) {
        process.stdout.write("\n");
      }
    }
  }
}
