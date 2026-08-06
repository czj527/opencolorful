import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiClient } from "../../lib/api-client.js";
import { SkillApiClient } from "../../lib/skill-api.js";
import type {
  AgentSkillsViewData,
  SafeSkillView,
  SourceConfigView,
} from "../../lib/skill-types.js";
import { AgentSkillsSection } from "./AgentSkillsSection.js";
import { DiscoverSkillsView } from "./DiscoverSkillsView.js";
import { InstalledSkillsView } from "./InstalledSkillsView.js";
import { SkillBundlesView } from "./SkillBundlesView.js";
import { SkillDevView } from "./SkillDevView.js";
import { SkillInstallFlowCard } from "./SkillInstallFlowCard.js";
import { SkillInstallToolCard } from "./SkillInstallToolCard.js";
import { SkillSourcesView } from "./SkillSourcesView.js";
import { SkillsPage } from "./SkillsPage.js";
import { ToolCallItem } from "../chat/ToolCallItem.js";

const fakeSkillApi = new SkillApiClient("http://test.local");
const fakeServerApi = new ApiClient("http://test.local");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MINIMAL_SKILL: SafeSkillView = {
  skillRef: {
    skillId: "demo-skill",
    sourceId: "C:\\opencolorful\\skills\\installed\\demo-skill",
    sourceKind: "managed",
    version: "1.0.0",
    contentHash: "sha256-43769292510212a29a1f84b8985f0c42b459671e20a57b8403d659bcf",
  },
  skillRefKey: "demo-skill@C:\\opencolorful\\skills\\installed\\demo-skill@1.0.0",
  skillId: "demo-skill",
  displayName: "Demo Skill",
  description: "演示用 Skill",
  version: "1.0.0",
  sourceId: "C:\\opencolorful\\skills\\installed\\demo-skill",
  sourceKind: "managed",
  contentHash: "sha256-43769292510212a29a1f84b8985f0c42b459671e20a57b8403d659bcf",
  sizeBytes: 4096,
  fileCount: 3,
  status: { validity: "valid", trust: "trusted", readiness: "ready", selection: "implicit" },
  compatibility: { level: "native", missing: [], requiresManualMigration: false },
  provenance: { sourceRef: "C:\\tmp\\demo", fetchedAt: "2026-01-01T00:00:00.000Z" },
  validityErrors: [],
};

const MINIMAL_SOURCE_VIEW: SourceConfigView = {
  config: { version: 1, trustedRoots: [], disabledKinds: ["workspace"], trustedSourceIds: {} },
  compatibilityRoots: [
    { root: "C:\\ws\\.claude\\skills", exists: true, trusted: false },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SkillsPage shell", () => {
  it("renders page title and six view tabs", () => {
    const html = renderToStaticMarkup(<SkillsPage api={fakeServerApi} skillApi={fakeSkillApi} />);
    expect(html).toContain("Skill 管理中心");
    for (const id of ["installed", "discover", "sources", "bundles", "diagnostics", "dev"]) {
      expect(html).toContain(`skills-tab-${id}`);
    }
    expect(html).toContain("返回聊天");
  });
});

describe("InstalledSkillsView（列表：来源/版本/哈希/状态四元组/兼容性）", () => {
  it("renders loading state before data arrives", () => {
    const html = renderToStaticMarkup(
      <InstalledSkillsView skillApi={fakeSkillApi} onOpenDetail={() => {}} />,
    );
    expect(html).toContain("加载中");
  });

  it("renders installed rows with status four-tuple and metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([MINIMAL_SKILL])));
    render(<InstalledSkillsView skillApi={fakeSkillApi} onOpenDetail={() => {}} />);
    await waitFor(() => expect(screen.getByText("Demo Skill")).toBeTruthy());
    expect(screen.getByText("有效 / 可信 / 就绪 / 自动匹配")).toBeTruthy();
    expect(screen.getByText(/managed ·/)).toBeTruthy();
    expect(screen.getByText(/sha256-43769292/)).toBeTruthy();
  });

  it("renders blocked reason when readiness is blocked", async () => {
    const blocked: SafeSkillView = {
      ...MINIMAL_SKILL,
      skillId: "blocked-skill",
      displayName: "Blocked Skill",
      status: {
        validity: "valid",
        trust: "trusted",
        readiness: "blocked",
        selection: "implicit",
        blockedReason: "skill_readiness_blocked",
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([blocked])));
    render(<InstalledSkillsView skillApi={fakeSkillApi} onOpenDetail={() => {}} />);
    await waitFor(() => expect(screen.getByText("Blocked Skill")).toBeTruthy());
    expect(screen.getByText(/skill_readiness_blocked/)).toBeTruthy();
  });
});

describe("SkillSourcesView（兼容目录默认关闭的信任开关）", () => {
  it("renders compatibility roots with trust toggle", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MINIMAL_SOURCE_VIEW)));
    render(<SkillSourcesView skillApi={fakeSkillApi} />);
    await waitFor(() => expect(screen.getAllByText(/\.claude\\skills/).length).toBeGreaterThan(0));
    expect(screen.getByText("未信任")).toBeTruthy();
  });

  it("toggle persists trustedRoots via PUT", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/skill-sources") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { disabledKinds?: string[]; trustedRoots?: string[] };
        // 先开 workspace（disabledKinds 去掉 workspace），再信任根目录
        if (body.disabledKinds !== undefined && !body.disabledKinds.includes("workspace")) {
          return jsonResponse({
            config: { version: 1, trustedRoots: [], disabledKinds: [], trustedSourceIds: {} },
            compatibilityRoots: [{ root: "C:\\ws\\.claude\\skills", exists: true, trusted: false }],
          });
        }
        return jsonResponse({
          config: { version: 1, trustedRoots: ["C:\\ws\\.claude\\skills"], disabledKinds: [], trustedSourceIds: {} },
          compatibilityRoots: [{ root: "C:\\ws\\.claude\\skills", exists: true, trusted: true }],
        });
      }
      return jsonResponse(MINIMAL_SOURCE_VIEW);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SkillSourcesView skillApi={fakeSkillApi} />);
    await waitFor(() => expect(screen.getAllByText(/\.claude\\skills/).length).toBeGreaterThan(0));
    // 兼容目录信任开关在 workspace 来源关闭（默认）时禁用：先开启 workspace
    fireEvent.click(screen.getByLabelText("扫描 workspace 来源"));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find((args) => {
        if (String(args[0]).endsWith("/api/skill-sources") && (args[1] as RequestInit)?.method === "PUT") {
          const body = JSON.parse(String((args[1] as RequestInit)?.body)) as { disabledKinds?: string[] };
          return body.disabledKinds !== undefined && !body.disabledKinds.includes("workspace");
        }
        return false;
      });
      expect(put).toBeTruthy();
    });
    // workspace 开启后，根目录信任开关可点：PUT trustedRoots
    const toggle = screen.getByLabelText(/信任 C:\\ws\\.claude\\skills/);
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("已信任")).toBeTruthy());
    const trustPut = fetchMock.mock.calls.find((args) => {
      if (String(args[0]).endsWith("/api/skill-sources") && (args[1] as RequestInit)?.method === "PUT") {
        const body = JSON.parse(String((args[1] as RequestInit)?.body)) as { trustedRoots?: string[] };
        return body.trustedRoots !== undefined && body.trustedRoots.includes("C:\\ws\\.claude\\skills");
      }
      return false;
    });
    expect(trustPut).toBeTruthy();
  });
});

describe("SkillDevView（Linked Source 只读展示）", () => {
  it("renders linked source status read-only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          {
            sourceId: "linked-demo",
            rootPath: "C:\\src\\demo-skill",
            linkedAt: "2026-01-01T00:00:00.000Z",
            valid: true,
            skillName: "Demo Skill",
            version: "1.0.0",
            contentHash: "sha256-43769292510212a29a1f84b8985f0c42b459671e20a57b8403d659bcf",
            sizeBytes: 4096,
            fileCount: 3,
            errors: [],
          },
        ]),
      ),
    );
    render(<SkillDevView skillApi={fakeSkillApi} />);
    await waitFor(() => expect(screen.getByText("linked-demo")).toBeTruthy());
    expect(screen.getByText("有效")).toBeTruthy();
    expect(screen.getByText(/C:\\src\\demo-skill/)).toBeTruthy();
  });
});

describe("SkillBundlesView（Bundle 列表）", () => {
  it("renders bundles and versions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          bundles: [
            {
              bundleId: "crew",
              name: "Crew",
              versions: [
                { version: "1", contentHash: "sha256-abc", createdAt: "2026-01-01T00:00:00.000Z", itemCount: 2 },
              ],
            },
          ],
        }),
      ),
    );
    render(<SkillBundlesView skillApi={fakeSkillApi} />);
    await waitFor(() => expect(screen.getByText("crew")).toBeTruthy());
    expect(screen.getByText(/v1/)).toBeTruthy();
  });
});

describe("SkillInstallFlowCard（一次性确认卡：来源+版本+哈希+风险原因）", () => {
  it("flows inspect → confirmation_required → approve → installed", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/skills/inspect") && method === "POST") {
        return jsonResponse({
          ok: true,
          sourceRef: "C:\\tmp\\demo",
          version: "1.0.0",
          contentHash: "sha256-43769292510212a29a1f84b8985f0c42b459671e20a57b8403d659bcf",
          manifest: { name: "Demo Skill" },
          risks: [],
        });
      }
      if (url.endsWith("/api/skills/install") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { confirmationToken?: string };
        if (body.confirmationToken === undefined) {
          return jsonResponse(
            {
              status: "confirmation_required",
              loadHandle: null,
              confirmation: {
                token: "ct-1",
                expiresAt: "2026-01-01T00:15:00.000Z",
                operationType: "install",
                reason: "来源未被信任，需要用户确认后才能安装",
              },
              risks: [],
            },
            202,
          );
        }
        return jsonResponse(
          {
            status: "installed",
            skillRef: {
              skillId: "demo-skill",
              sourceId: "C:\\opencolorful\\skills\\installed\\demo-skill",
              sourceKind: "managed",
              version: "1.0.0",
              contentHash: "sha256-43769292510212a29a1f84b8985f0c42b459671e20a57b8403d659bcf",
            },
            operationId: "skill-install-1",
            agentBinding: "bound",
            activationGrant: "granted",
            loadHandle: "load-1",
          },
          201,
        );
      }
      if (url.includes("/api/skills/confirmation/") && url.endsWith("/approve") && method === "POST") {
        return jsonResponse({ status: "approved" });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SkillInstallFlowCard skillApi={fakeSkillApi} sourceRef="C:\\tmp\\demo" kind="local" autoStart />,
    );
    // 确认卡显示来源/版本/哈希/风险原因
    await waitFor(() => expect(screen.getByTestId("skill-approval-card")).toBeTruthy());
    expect(screen.getByText(/版本：1\.0\.0/)).toBeTruthy();
    expect(screen.getByText(/sha256-43769292/)).toBeTruthy();
    expect(screen.getByText(/来源未被信任/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("skill-approve"));
    await waitFor(() => expect(screen.getByTestId("skill-install-result")).toBeTruthy());
    expect(screen.getByText("安装完成")).toBeTruthy();
    expect(screen.getByText(/activationGrant：granted/)).toBeTruthy();
  });

  it("renders error state with reasonCode when install fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/skills/inspect") && method === "POST") {
          return jsonResponse({ ok: true, sourceRef: "x", version: "1.0.0", contentHash: "sha256-a", risks: [] });
        }
        if (url.endsWith("/api/skills/install") && method === "POST") {
          // Server 错误形状：createApiError → details.reasonCode（稳定 reasonCode）
          return jsonResponse(
            {
              code: "SKILL_INSTALL_FAILED",
              message: "包损坏",
              retryable: false,
              details: { reasonCode: "skill_package_invalid", reason: "包损坏" },
            },
            400,
          );
        }
        return jsonResponse({});
      }),
    );
    render(<SkillInstallFlowCard skillApi={fakeSkillApi} sourceRef="x" kind="local" autoStart />);
    await waitFor(() => expect(screen.getByTestId("skill-install-error")).toBeTruthy());
    expect(screen.getByText(/包损坏/)).toBeTruthy();
    expect(screen.getByText(/skill_package_invalid/)).toBeTruthy();
  });
});

describe("SkillInstallToolCard（聊天页安装状态卡 + 审批）", () => {
  it("renders approval card from install_skill confirmation_required result", () => {
    const html = renderToStaticMarkup(
      <SkillInstallToolCard
        toolName="install_skill"
        status="completed"
        result={{
          status: "confirmation_required",
          loadHandle: null,
          confirmation: {
            token: "ct-9",
            expiresAt: "2026-01-01T00:15:00.000Z",
            operationType: "install",
            reason: "风险等级 high，需要用户确认后才能安装",
            riskLevel: "high",
          },
          risks: [{ code: "scripts", message: "包含 scripts/ 目录" }],
        }}
      />,
    );
    expect(html).toContain("安装需要你的一次性确认");
    expect(html).toContain("风险等级：high");
    expect(html).toContain("包含 scripts/ 目录");
  });

  it("renders installed result with activation grant state", () => {
    const html = renderToStaticMarkup(
      <SkillInstallToolCard
        toolName="install_skill"
        status="completed"
        result={{
          status: "installed",
          skillRef: { skillId: "demo", sourceId: "s", sourceKind: "managed", version: "1.0.0", contentHash: "sha256-a" },
          operationId: "skill-install-1",
          agentBinding: "bound",
          activationGrant: "granted",
          loadHandle: "load-1",
        }}
      />,
    );
    expect(html).toContain("activationGrant：granted");
    expect(html).toContain("loadHandle=load-1");
  });

  it("ToolCallItem renders the install card for install_skill tool calls", () => {
    const html = renderToStaticMarkup(
      <ToolCallItem
        toolCall={{
          toolCallId: "t1",
          toolName: "install_skill",
          status: "completed",
          result: { status: "confirmation_required", loadHandle: null, confirmation: { token: "ct-1", expiresAt: "x", operationType: "install", reason: "需要确认" } },
        }}
      />,
    );
    expect(html).toContain("skill-install-tool-card");
    expect(html).toContain("需要确认");
  });
});

describe("AgentSkillsSection（绑定列表/模式覆盖/学习策略/确认流）", () => {
  const VIEW: AgentSkillsViewData = {
    visible: [
      {
        skillRefKey: "demo-skill@C:\\opencolorful\\skills\\installed\\demo-skill@1.0.0",
        skillId: "demo-skill",
        displayName: "Demo Skill",
        version: "1.0.0",
        pinned: true,
        selection: "implicit",
        readiness: "ready",
      },
    ],
    shadowed: [],
    disabled: [],
    gated: [
      {
        skillRefKey: "gated@src@1",
        skillId: "gated-skill",
        displayName: "Gated Skill",
        version: "1.0.0",
        blockedReason: "skill_readiness_blocked",
      },
    ],
    diagnostics: [],
    learningPolicy: "ask-on-risk",
    bundleBindings: [],
    overrides: {},
  };

  it("renders bindings, learning policy and gated block", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/agents/agent-1/skills") && method === "GET") {
          return jsonResponse({ status: "ok", action: "list", agentId: "agent-1", view: VIEW });
        }
        return jsonResponse({});
      }),
    );
    render(<AgentSkillsSection agentId="agent-1" skillApi={fakeSkillApi} />);
    await waitFor(() => expect(screen.getByText("Demo Skill")).toBeTruthy());
    expect(screen.getAllByText(/ask-on-risk/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Gated Skill/)).toBeTruthy();
    expect(screen.getByText(/skill_readiness_blocked/)).toBeTruthy();
  });

  it("unbind without token returns confirmation card, approve then retries with token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/agents/agent-1/skills") && method === "GET") {
        return jsonResponse({ status: "ok", action: "list", agentId: "agent-1", view: VIEW });
      }
      if (url.endsWith("/api/agents/agent-1/skills") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { action?: string; confirmationToken?: string };
        if (body.action === "unbind" && body.confirmationToken === undefined) {
          return jsonResponse({
            status: "confirmation_required",
            action: "unbind",
            agentId: "agent-1",
            confirmation: {
              token: "ct-unbind",
              expiresAt: "2026-01-01T00:15:00.000Z",
              operationType: "unbind",
              reason: "解绑需要用户确认",
            },
          });
        }
        return jsonResponse({ status: "ok", action: "unbind", agentId: "agent-1" });
      }
      if (url.includes("/api/skills/confirmation/") && url.endsWith("/approve") && method === "POST") {
        return jsonResponse({ status: "approved" });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentSkillsSection agentId="agent-1" skillApi={fakeSkillApi} />);
    await waitFor(() => expect(screen.getByText("Demo Skill")).toBeTruthy());
    fireEvent.click(screen.getByTestId("unbind-demo-skill"));
    await waitFor(() => expect(screen.getByTestId("agent-skill-confirmation")).toBeTruthy());
    expect(screen.getByText(/解绑需要用户确认/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("agent-skill-confirm"));
    await waitFor(() => {
      const retry = fetchMock.mock.calls.find((args) => {
        if (String(args[0]).endsWith("/api/agents/agent-1/skills") && (args[1] as RequestInit)?.method === "PUT") {
          const body = JSON.parse(String((args[1] as RequestInit)?.body)) as { confirmationToken?: string };
          return body.confirmationToken === "ct-unbind";
        }
        return false;
      });
      expect(retry).toBeTruthy();
    });
  });
});

describe("DiscoverSkillsView（搜索；搜索不触发安装）", () => {
  it("renders search hits with source info", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/skills/search") && (init?.method ?? "GET") === "POST") {
          return jsonResponse({
            layers: ["bound", "managed", "workspace", "plugin", "remote"],
            hits: [
              {
                layer: "managed",
                sourceKind: "managed",
                skillId: "demo-skill",
                displayName: "Demo Skill",
                version: "1.0.0",
                sourceId: "C:\\opencolorful\\skills\\installed\\demo-skill",
                contentHash: "sha256-a",
                bindable: true,
              },
            ],
            diagnostics: [],
            remote: { available: false, note: "远程来源搜索在 T9 接入" },
          });
        }
        return jsonResponse({});
      }),
    );
    render(<DiscoverSkillsView skillApi={fakeSkillApi} />);
    await waitFor(() => expect(screen.getByText("Demo Skill")).toBeTruthy());
    expect(screen.getByText(/远程来源搜索在 T9 接入/)).toBeTruthy();
  });
});
