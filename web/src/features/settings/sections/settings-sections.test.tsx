import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ProvidersSection } from "./ProvidersSection.js";
import { DefaultsSection } from "./DefaultsSection.js";
import { LayoutSection } from "./LayoutSection.js";
import { LogsSection } from "./LogsSection.js";
import { RuntimeSection } from "./RuntimeSection.js";
import { UnavailableSection } from "./UnavailableSection.js";
import type { ProviderView, PreferencesDocument, SupervisorStatusResponse, LogTail } from "../../../lib/types.js";

const fakeProviders: ProviderView[] = [
  {
    providerId: "openai",
    name: "OpenAI",
    protocol: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    models: [{ modelId: "gpt-4o", name: "GPT-4o", capabilities: { reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16384 } }],
    credentialConfigured: true,
  },
  {
    providerId: "local",
    name: "Local",
    protocol: "openai-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: [{ modelId: "llama3", name: "Llama 3", capabilities: { reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096 } }],
    credentialConfigured: false,
  },
];

const fakePreferences: PreferencesDocument = {
  version: 1,
  defaults: { model: null, thinkingLevel: "medium", toolMode: "read-only" },
  layout: { leftSidebarWidth: 280, rightSidebarWidth: 320, leftCollapsed: false, rightCollapsed: false, focusMode: false, reducedMotion: "system" },
  appearance: { theme: "dark", showToolCalls: true, showThinking: true },
};

const fakeSupervisorStatus: SupervisorStatusResponse = {
  status: "online",
  supervisor: { pid: 1, port: 4311, version: "0.1.0", uptimeSeconds: 10 },
  agentServer: { status: "online", pid: 2, port: 4310, version: "0.1.0" },
};

const fakeLogTail: LogTail = { logs: "ok", truncated: false, nextCursor: null };

const fakeObservabilityPreferences = {
  diagnosticLevel: "info",
  diagnosticRetentionDays: { debug: 7, main: 30 },
  diagnosticFileSizeBytes: 10 * 1024 * 1024,
  diagnosticDiskBudgetBytes: 500 * 1024 * 1024,
  activityRetentionDays: { routine: 180, notable: 730 },
  emergencySpoolBudgetBytes: 128 * 1024 * 1024,
};

describe("ProvidersSection", () => {
  it("shows configured credential status without echoing the key", () => {
    const html = renderToStaticMarkup(
      <ProvidersSection
        providers={fakeProviders}
        onSaveProvider={async () => {}}
        saving={false}
        lastSaveError={null}
      />,
    );
    expect(html).toContain("已配置凭据");
    expect(html).toContain("未配置凭据");
    // 不应包含原始 key
    expect(html).not.toContain("sk-");
  });
});

describe("DefaultsSection", () => {
  it("renders current default model as unset when null", () => {
    const html = renderToStaticMarkup(
      <DefaultsSection
        preferences={fakePreferences}
        models={[]}
        onSave={async () => {}}
        saving={false}
        lastSaveError={null}
      />,
    );
    expect(html).toContain("未选择");
  });

  it("shows save error when lastSaveError is provided", () => {
    const html = renderToStaticMarkup(
      <DefaultsSection
        preferences={fakePreferences}
        models={[]}
        onSave={async () => {}}
        saving={false}
        lastSaveError="模型不存在或凭据不可用"
      />,
    );
    expect(html).toContain("模型不存在");
  });

  it("does not offer all as a global tool default", () => {
    const html = renderToStaticMarkup(
      <DefaultsSection
        preferences={fakePreferences}
        models={[]}
        onSave={async () => {}}
        saving={false}
        lastSaveError={null}
      />,
    );
    expect(html).not.toContain('<option value="all"');
  });
});

describe("LayoutSection", () => {
  it("shows current sidebar widths and motion preference", () => {
    const html = renderToStaticMarkup(
      <LayoutSection
        preferences={fakePreferences}
        onSave={async () => {}}
        onSaveTheme={async () => {}}
        saving={false}
        lastSaveError={null}
      />,
    );
    expect(html).toContain("280");
    expect(html).toContain("320");
    expect(html).toContain("默认收起左侧栏");
    expect(html).toContain("默认收起右侧栏");
  });

  it("renders show tool calls and show thinking toggles", () => {
    const html = renderToStaticMarkup(
      <LayoutSection
        preferences={fakePreferences}
        onSave={async () => {}}
        onSaveTheme={async () => {}}
        saving={false}
        lastSaveError={null}
      />,
    );
    expect(html).toContain("显示工具调用卡片");
    expect(html).toContain("显示思考过程");
  });
});

describe("LogsSection", () => {
  it("displays log content from the initial fetch", () => {
    const html = renderToStaticMarkup(
      <LogsSection
        getSupervisorLogs={async () => fakeLogTail}
        api={{ getObservabilityPreferences: async () => fakeObservabilityPreferences, saveObservabilityPreferences: async (prefs: typeof fakeObservabilityPreferences) => prefs } as never}
      />,
    );
    // Phase 7 重构后 LogsSection 返回 fragment（标题由 SettingsPage 的 SettingsSection 包装），
    // 验证日志工具栏与级别选择器渲染。
    expect(html).toContain("日志级别");
    expect(html).toContain("关键词过滤");
    // Phase 11（评审 P1-7）：可观测性偏好表单（SSR 下只渲染加载占位）
    expect(html).toContain("可观测性偏好");
    expect(html).toContain("正在加载偏好");
  });
});

describe("RuntimeSection", () => {
  it("shows supervisor and agent PIDs and ports", () => {
    const html = renderToStaticMarkup(
      <RuntimeSection supervisorStatus={fakeSupervisorStatus} />,
    );
    expect(html).toContain("4311");
    expect(html).toContain("4310");
  });

  it("renders gracefully when supervisor status is null", () => {
    const html = renderToStaticMarkup(<RuntimeSection supervisorStatus={null} />);
    expect(html).toContain("不可用");
  });
});

describe("UnavailableSection", () => {
  it("renders a disabled notice without sending API requests", () => {
    const html = renderToStaticMarkup(<UnavailableSection />);
    expect(html).toContain("尚未启用");
  });
});
