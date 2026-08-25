/**
 * NewSessionPage T9 测试。
 *
 * 覆盖六个核心场景：
 *  1. 草稿离开不落库（路由切换不调创建 API）
 *  2. 首次发送只创建一次（submitting 锁 + 重复点击防护）
 *  3. 创建失败保留草稿
 *  4. 创建成功 Prompt 失败保留 session+草稿可重试
 *  5. Agent 选择切换 defaultCwd 继承
 *  6. 无 Agent 无 cwd 时禁用发送
 *
 * Mock 策略：用 vi.fn 替换 ApiClient 实例方法，避免触发真实网络。
 * happy-dom 默认 UA 派生自宿主平台（win32→含 "win32"，linux→不含），
 * 而 DirectoryPicker 按 UA 判定平台（仅 Windows 显示原生选择按钮）——
 * 为避免 Linux CI 上选择器落到手工输入模式，测试显式固定 Windows UA，
 * 并通过 mock api.pickDirectory 注入路径。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { NewSessionPage } from "./NewSessionPage.js";
import { ApiClient } from "../../lib/api-client.js";
import type {
  AgentView,
  ModelSummary,
  PreferencesDocument,
  SessionView,
} from "../../lib/types.js";
import { renderWithTheme } from "../../test/render.js";

// 固定 Windows UA：让 DirectoryPicker 在任何宿主平台上都进入原生选择模式
Object.defineProperty(window.navigator, "userAgent", {
  value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  configurable: true,
});

// --- 测试夹具 ---

const fakeSession: SessionView = {
  id: "session-1",
  title: "新会话",
  sessionPath: "/tmp/session-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  archived: false,
  model: null,
  toolMode: "off",
  workspaceCwd: "D:\\test",
  workspaceConfirmed: false,
  thinkingLevel: "off",
  messages: [],
  messageEntries: [],
  agentId: null,
};

const fakeAgents: AgentView[] = [
  {
    identity: {
      version: 2,
      id: "agent-1",
      name: "HelperBot",
      createdAt: "2025-01-01T00:00:00Z",
    },
    baseColor: {
      version: 1,
      persona: "A helpful assistant",
      personality: ["helpful"],
      replyStyle: "conversational",
      innerSetting: "Be supportive.",
      updatedAt: "2025-01-02T00:00:00Z",
    },
    settings: {
      version: 2,
      defaultCwd: null,
      updatedAt: "2025-01-02T00:00:00Z",
    },
    sessionCount: 0,
    decorColor: "blue",
  },
  {
    identity: {
      version: 2,
      id: "agent-2",
      name: "CodeBot",
      createdAt: "2025-03-01T00:00:00Z",
    },
    baseColor: {
      version: 1,
      persona: "A coding partner",
      personality: ["precise"],
      replyStyle: "concise",
      innerSetting: "Focus on correctness.",
      updatedAt: "2025-03-02T00:00:00Z",
    },
    settings: {
      version: 2,
      defaultCwd: "D:\\projects\\demo",
      updatedAt: "2025-03-02T00:00:00Z",
    },
    sessionCount: 0,
    decorColor: "green",
  },
];

const fakeModels: ModelSummary[] = [];

const fakePreferences: PreferencesDocument = {
  version: 1,
  defaults: {
    model: null,
    thinkingLevel: "off",
    toolMode: "off",
  },
  layout: {
    leftSidebarWidth: 240,
    rightSidebarWidth: 320,
    leftCollapsed: false,
    rightCollapsed: false,
    focusMode: false,
    reducedMotion: "system",
  },
  appearance: {
    theme: "dark",
    showToolCalls: true,
    showThinking: true,
  },
};

interface MockApi {
  createSession: ReturnType<typeof vi.fn>;
  sendPrompt: ReturnType<typeof vi.fn>;
  pickDirectory: ReturnType<typeof vi.fn>;
}

function makeMockApi(): MockApi & ApiClient {
  return {
    createSession: vi.fn(),
    sendPrompt: vi.fn(),
    pickDirectory: vi.fn(),
  } as unknown as MockApi & ApiClient;
}

/** 在 DirectoryPicker 的"选择目录"按钮上触发选择并注入路径 */
async function pickDirectoryPath(api: MockApi, path: string): Promise<void> {
  api.pickDirectory.mockResolvedValueOnce({ path, cancelled: false });
  fireEvent.click(screen.getByLabelText("选择目录"));
  await waitFor(() => {
    expect(screen.getByTestId("directory-picker-value").textContent).toContain(path);
  });
}

/** 在 MessageComposer textarea 输入消息 */
function inputMessage(text: string): void {
  fireEvent.change(screen.getByLabelText("消息输入"), { target: { value: text } });
}

describe("NewSessionPage", () => {
  let api: MockApi & ApiClient;
  // 用 vi.fn 的显式泛型签名确保赋值给 NewSessionPageProps.onSessionCreated 时类型匹配
  let onSessionCreated: ReturnType<typeof vi.fn<(sessionId: string) => void>>;

  beforeEach(() => {
    api = makeMockApi();
    onSessionCreated = vi.fn<(sessionId: string) => void>();
  });

  it("草稿离开不落库：点击返回按钮不调 createSession API", async () => {
    renderWithTheme(
      <NewSessionPage
        agents={fakeAgents}
        api={api}
        models={fakeModels}
        preferences={fakePreferences}
        onSessionCreated={onSessionCreated}
      />,
    );

    fireEvent.click(screen.getByTestId("new-session-back"));

    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.sendPrompt).not.toHaveBeenCalled();
    expect(onSessionCreated).not.toHaveBeenCalled();
  });

  it("不暴露会话创建后的模型、工具与思考配置入口", () => {
    renderWithTheme(
      <NewSessionPage
        agents={fakeAgents}
        api={api}
        models={fakeModels}
        preferences={fakePreferences}
        onSessionCreated={onSessionCreated}
      />,
    );

    expect(screen.queryByLabelText("工具模式")).toBeNull();
    expect(screen.queryByLabelText("思考级别")).toBeNull();
    expect(screen.queryByLabelText("选择模型")).toBeNull();
  });

  it("在草稿状态执行会话命令时显示稳定反馈且不创建 Session", async () => {
    renderWithTheme(
      <NewSessionPage
        agents={fakeAgents}
        api={api}
        models={fakeModels}
        preferences={fakePreferences}
        onSessionCreated={onSessionCreated}
      />,
    );

    await pickDirectoryPath(api, "D:\\test");
    inputMessage("/compact");
    fireEvent.keyDown(screen.getByLabelText("消息输入"), { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("new-session-error").textContent).toContain("创建会话后");
    });
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it("首次发送只创建一次：submitting 锁防止重复点击", async () => {
    // createSession 用延迟 resolve 模拟网络慢，让重复点击落在 submitting=true 期间
    let resolveCreate: (value: SessionView) => void = () => {};
    api.createSession.mockImplementation(
      () =>
        new Promise<SessionView>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    api.sendPrompt.mockResolvedValue({
      status: "accepted",
      sessionId: "session-1",
      streamId: "stream-1",
    });

    renderWithTheme(
      <NewSessionPage
        agents={fakeAgents}
        api={api}
        models={fakeModels}
        preferences={fakePreferences}
        onSessionCreated={onSessionCreated}
      />,
    );

    await pickDirectoryPath(api, "D:\\test");
    inputMessage("你好");
    // 连续点击发送按钮两次
    fireEvent.click(screen.getByLabelText("发送消息"));
    fireEvent.click(screen.getByLabelText("发送消息"));
    // 让 createSession resolve
    resolveCreate(fakeSession);
    await waitFor(() => {
      expect(api.createSession).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(api.sendPrompt).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(onSessionCreated).toHaveBeenCalledWith("session-1");
    });
  });

  it("创建失败保留草稿：error 显示且 Agent/cwd 选择保留", async () => {
    api.createSession.mockRejectedValue(new Error("网络错误"));

    renderWithTheme(
      <NewSessionPage
        agents={fakeAgents}
        api={api}
        models={fakeModels}
        preferences={fakePreferences}
        onSessionCreated={onSessionCreated}
      />,
    );

    // 选 Agent（agent-1，无 defaultCwd）+ 手动选目录
    fireEvent.click(screen.getByTestId("new-session-agent-agent-1"));
    await pickDirectoryPath(api, "D:\\test");
    inputMessage("你好");
    fireEvent.click(screen.getByLabelText("发送消息"));

    await waitFor(() => {
      expect(screen.getByTestId("new-session-error").textContent).toContain("网络错误");
    });

    // 草稿保留：首条消息、Agent chip 与 cwd 均保持不变
    expect((screen.getByLabelText("消息输入") as HTMLTextAreaElement).value).toBe("你好");
    expect(screen.getByTestId("new-session-agent-agent-1").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("directory-picker-value").textContent).toContain("D:\\test");
    expect(api.sendPrompt).not.toHaveBeenCalled();
    expect(onSessionCreated).not.toHaveBeenCalled();
  });

  it("创建成功 Prompt 失败：保留 session+草稿，重试只发 messages 不重建 session", async () => {
    api.createSession.mockResolvedValue(fakeSession);
    api.sendPrompt.mockRejectedValueOnce(new Error("发送失败"));

    renderWithTheme(
      <NewSessionPage
        agents={fakeAgents}
        api={api}
        models={fakeModels}
        preferences={fakePreferences}
        onSessionCreated={onSessionCreated}
      />,
    );

    await pickDirectoryPath(api, "D:\\test");
    inputMessage("你好");
    fireEvent.click(screen.getByLabelText("发送消息"));

    // 第一次：createSession + sendPrompt，sendPrompt 失败
    await waitFor(() => {
      expect(api.createSession).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("new-session-error").textContent).toContain("发送失败");
    });
    expect(onSessionCreated).not.toHaveBeenCalled();
    expect((screen.getByLabelText("消息输入") as HTMLTextAreaElement).value).toBe("你好");

    // 重试：保留原消息，直接再次点击发送
    fireEvent.click(screen.getByLabelText("发送消息"));

    await waitFor(() => {
      expect(api.sendPrompt).toHaveBeenCalledTimes(2);
    });
    // createSession 不应被再次调用
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.sendPrompt).toHaveBeenNthCalledWith(2, "session-1", "你好");
  });

  it("Agent 选择切换 defaultCwd 继承：选 agent-2 后 directory-picker-value 自动填充", () => {
    renderWithTheme(
      <NewSessionPage
        agents={fakeAgents}
        api={api}
        models={fakeModels}
        preferences={fakePreferences}
        onSessionCreated={onSessionCreated}
      />,
    );

    expect(screen.getByTestId("directory-picker-value").textContent).toContain("未设置");

    fireEvent.click(screen.getByTestId("new-session-agent-agent-2"));

    expect(screen.getByTestId("directory-picker-value").textContent).toContain("D:\\projects\\demo");
    expect(screen.getByTestId("new-session-agent-agent-2").getAttribute("aria-pressed")).toBe("true");
  });

  it("无 cwd 时禁用发送：初始状态下发送按钮 disabled", () => {
    renderWithTheme(
      <NewSessionPage
        agents={fakeAgents}
        api={api}
        models={fakeModels}
        preferences={fakePreferences}
        onSessionCreated={onSessionCreated}
      />,
    );

    // 初始状态：cwd=null，canSend=false，MessageComposer disabled=true
    const textarea = screen.getByLabelText("消息输入") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    // 发送按钮在 textarea disabled 时也 disabled（MessageComposer 内部 disabled 透传）
    const sendButton = screen.getByLabelText("发送消息");
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
  });
});
