import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiClient, ApiClientError } from "../../lib/api-client.js";
import { isPluginServiceUnavailable, PluginApiClient } from "../../lib/plugin-api.js";
import { AgentPluginsSection } from "../agents/AgentPluginsSection.js";
import { DiscoverView } from "./DiscoverView.js";
import { DevelopmentView } from "./DevelopmentView.js";
import { InstalledView } from "./InstalledView.js";
import { PermissionsView } from "./PermissionsView.js";
import { PluginDetailView } from "./PluginDetailView.js";
import { PluginsPage } from "./PluginsPage.js";
import { PluginsSettingsSection } from "./PluginsSettingsSection.js";
import { SourcesView } from "./SourcesView.js";

const fakeApi = new PluginApiClient("http://test.local");
const fakeServerApi = new ApiClient("http://test.local");

describe("PluginsPage shell", () => {
  it("renders page title and five view tabs", () => {
    const html = renderToStaticMarkup(<PluginsPage api={fakeServerApi} pluginApi={fakeApi} />);
    expect(html).toContain("插件中心");
    expect(html).toContain("已安装");
    expect(html).toContain("发现");
    expect(html).toContain("权限");
    expect(html).toContain("开发");
    expect(html).toContain("来源");
    expect(html).toContain("返回聊天");
  });

  it("renders the plugins page container with tab test ids", () => {
    const html = renderToStaticMarkup(<PluginsPage api={fakeServerApi} pluginApi={fakeApi} />);
    expect(html).toContain('data-page="plugins"');
    for (const id of ["installed", "discover", "permissions", "development", "sources"]) {
      expect(html).toContain(`plugins-tab-${id}`);
    }
  });
});

describe("InstalledView", () => {
  it("renders loading state before data arrives (no fetch fired)", () => {
    const html = renderToStaticMarkup(<InstalledView pluginApi={fakeApi} onOpenDetail={() => {}} />);
    expect(html).toContain("正在加载");
  });
});

describe("DiscoverView", () => {
  it("renders search box and source-aware placeholder", () => {
    const html = renderToStaticMarkup(<DiscoverView pluginApi={fakeApi} />);
    expect(html).toContain("插件搜索");
    expect(html).toContain("搜索");
  });
});

describe("PermissionsView", () => {
  it("renders loading state before data arrives", () => {
    const html = renderToStaticMarkup(<PermissionsView pluginApi={fakeApi} api={fakeServerApi} />);
    expect(html).toContain("正在加载");
  });
});

describe("DevelopmentView", () => {
  it("renders dev loop placeholder and form labels", () => {
    const html = renderToStaticMarkup(<DevelopmentView pluginApi={fakeApi} />);
    expect(html).toContain("本地开发插件（Dev Loop）");
    expect(html).toContain("开发态安装");
    expect(html).toContain("场景测试（run-scenario）");
    expect(html).toContain("占位");
  });
});

describe("SourcesView", () => {
  it("renders loading state before sources arrive", () => {
    const html = renderToStaticMarkup(<SourcesView pluginApi={fakeApi} />);
    expect(html).toContain("正在加载");
  });
});

describe("PluginDetailView", () => {
  it("renders loading state for a plugin detail deep link", () => {
    const html = renderToStaticMarkup(
      <PluginDetailView pluginApi={fakeApi} pluginId="example.sdk-showcase" onBack={() => {}} />,
    );
    expect(html).toContain("正在加载");
  });
});

describe("PluginsSettingsSection", () => {
  it("renders entry into the plugin center page", () => {
    const html = renderToStaticMarkup(<PluginsSettingsSection />);
    expect(html).toContain("打开插件中心");
    expect(html).toContain("下一 turn 生效");
  });
});

describe("AgentPluginsSection", () => {
  it("renders the binding section with next-turn hint in loading state", () => {
    const html = renderToStaticMarkup(
      <AgentPluginsSection agentId="agent-1" pluginApi={fakeApi} />,
    );
    expect(html).toContain("插件绑定");
    expect(html).toContain("下一 turn 生效");
    expect(html).toContain("正在加载");
  });
});

describe("isPluginServiceUnavailable", () => {
  it("returns true for 404/405/502/503 ApiClientError", () => {
    for (const status of [404, 405, 502, 503]) {
      expect(isPluginServiceUnavailable(new ApiClientError("NOT_FOUND", "missing", false, status))).toBe(true);
    }
  });

  it("returns false for other errors and non-ApiClientError", () => {
    expect(isPluginServiceUnavailable(new ApiClientError("BAD", "bad", false, 400))).toBe(false);
    expect(isPluginServiceUnavailable(new Error("boom"))).toBe(false);
  });
});

// ── Server 最小集回归：富字段缺失时不得崩溃，必须降级为占位/空态 ──

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 与 Server GET /api/plugins 返回的最小字段集一致（不含 name/health/enabled 等富字段） */
const MINIMAL_LIST_ITEM = {
  pluginId: "demo.minimal",
  version: "1.0.0",
  active: true,
  status: "enabled",
  sourceType: "local",
  sourceRef: "/tmp/demo",
  installedAt: "2026-08-01T00:00:00.000Z",
};

/** 与 Server GET /api/plugins/:id 返回的 PluginInstallation 最小集一致（不含 grants/secretStatus 等） */
const MINIMAL_DETAIL = {
  pluginId: "demo.minimal",
  version: "1.0.0",
  active: true,
  status: "enabled",
  source: {
    sourceRef: { sourceType: "local", ref: "/tmp/demo" },
    verification: { sha256: "abc123", sizeBytes: 12 },
  },
  installedAt: "2026-08-01T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InstalledView（最小集响应）", () => {
  it("name 缺失回退 pluginId、enabled 缺失由 active/status 推导、富字段缺失不崩溃", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([MINIMAL_LIST_ITEM])));
    render(<InstalledView pluginApi={fakeApi} onOpenDetail={() => {}} />);
    expect(await screen.findByTestId("installed-view")).toBeTruthy();
    // name 富字段缺失 → 标题回退 pluginId（meta 中还有一处 pluginId）
    expect(screen.getAllByText("demo.minimal").length).toBeGreaterThan(0);
    // enabled 富字段缺失 → active/status 推导为启用，显示「禁用」按钮
    expect(screen.getByText("禁用")).toBeTruthy();
    // runtimeKind 富字段缺失 → 占位「—」
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("InstalledView（更新/回滚按富字段显示）", () => {
  it("updateAvailable===true 时显示更新按钮，false/undefined 时不显示", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([
      { ...MINIMAL_LIST_ITEM, updateAvailable: true },
    ])));
    render(<InstalledView pluginApi={fakeApi} onOpenDetail={() => {}} />);
    expect(await screen.findByTestId("installed-view")).toBeTruthy();
    expect(screen.getByRole("button", { name: "更新" })).toBeTruthy();
  });

  it("updateAvailable=false 或缺失（undefined）时不显示更新按钮", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([
      { ...MINIMAL_LIST_ITEM, updateAvailable: false },
    ])));
    const first = render(<InstalledView pluginApi={fakeApi} onOpenDetail={() => {}} />);
    expect(await screen.findByTestId("installed-view")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
    first.unmount();

    // 富字段完全缺失（Server 最小集）也不显示
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([MINIMAL_LIST_ITEM])));
    render(<InstalledView pluginApi={fakeApi} onOpenDetail={() => {}} />);
    expect(await screen.findByTestId("installed-view")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "更新" }).length).toBe(0);
  });

  it("rollbackAvailable===true 时显示回滚按钮，缺失时不显示", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([
      { ...MINIMAL_LIST_ITEM, rollbackAvailable: true },
    ])));
    const first = render(<InstalledView pluginApi={fakeApi} onOpenDetail={() => {}} />);
    expect(await screen.findByTestId("installed-view")).toBeTruthy();
    expect(screen.getByRole("button", { name: "回滚" })).toBeTruthy();
    first.unmount();

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([MINIMAL_LIST_ITEM])));
    render(<InstalledView pluginApi={fakeApi} onOpenDetail={() => {}} />);
    expect(await screen.findByTestId("installed-view")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "回滚" })).toBeNull();
  });

  it("点击更新：请求体携带 sourceRef（sourceType/ref 取自列表项）", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/plugins/demo.minimal/update")) {
        return jsonResponse({ pluginId: "demo.minimal", version: "1.1.0" });
      }
      // 初始加载：updateAvailable=true → 更新按钮可见；更新后的 reload 同样返回
      return jsonResponse([{ ...MINIMAL_LIST_ITEM, updateAvailable: true }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<InstalledView pluginApi={fakeApi} onOpenDetail={() => {}} />);
    expect(await screen.findByTestId("installed-view")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((args) => String(args[0]).endsWith("/api/plugins/demo.minimal/update"));
      expect(call).toBeDefined();
      const [, init] = call!;
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        sourceRef: { sourceType: "local", ref: "/tmp/demo" },
      });
    });
  });
});

describe("PluginDetailView（最小集响应）", () => {
  it("grants/secretStatus/surfaces/runtime/manifest 缺失时全部降级为空态", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/diagnostics")) {
        return jsonResponse({ pluginId: "demo.minimal", version: "1.0.0", status: "enabled", active: true });
      }
      return jsonResponse(MINIMAL_DETAIL);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PluginDetailView pluginApi={fakeApi} pluginId="demo.minimal" onBack={() => {}} />);
    expect((await screen.findAllByText("demo.minimal")).length).toBeGreaterThan(0);
    expect(screen.getByText("该插件不申请权限。")).toBeTruthy();
    expect(screen.getByText("暂无平台级授权。")).toBeTruthy();
    expect(screen.getByText("无 Secret 声明。")).toBeTruthy();
    expect(screen.getByText("无配置值。")).toBeTruthy();
    expect(screen.getByText("该插件未声明 UI Surface。")).toBeTruthy();
    expect(screen.getByText("Manifest 不可用。")).toBeTruthy();
    // 诊断最小集 {pluginId, version, status, active}：health/生成时间占位而非崩溃
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("PluginDetailView（Surface 资产 URL）", () => {
  function detailWithSurfaces(surfaces: unknown[]): typeof MINIMAL_DETAIL & { surfaces: unknown[] } {
    return { ...MINIMAL_DETAIL, surfaces };
  }

  it("surfaces 带 entry 时按约定拼接资产 URL 渲染 iframe 与链接（无占位提示）", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/diagnostics")) {
        return jsonResponse({ pluginId: "demo.minimal", version: "1.0.0", status: "enabled", active: true });
      }
      return jsonResponse(
        detailWithSurfaces([{ surfaceId: "settings-page", name: "设置页", kind: "page", entry: "ui/settings.html" }]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PluginDetailView pluginApi={fakeApi} pluginId="demo.minimal" onBack={() => {}} />);
    const frame = await screen.findByTestId("surface-frame");
    expect(frame.getAttribute("src")).toBe("/api/plugins/demo.minimal/assets/ui/settings.html");
    const link = screen.getByTestId("surface-asset-link");
    expect(link.getAttribute("href")).toBe("/api/plugins/demo.minimal/assets/ui/settings.html");
    expect(screen.queryByText(/尚未接线/)).toBeNull();
    expect(screen.queryByText(/未声明资源入口/)).toBeNull();
  });

  it("Server 富化 assetUrl 时优先使用 assetUrl 而非自行拼接", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/diagnostics")) {
        return jsonResponse({ pluginId: "demo.minimal", version: "1.0.0", status: "enabled", active: true });
      }
      return jsonResponse(
        detailWithSurfaces([
          {
            surfaceId: "settings-page",
            name: "设置页",
            entry: "ui/settings.html",
            assetUrl: "/api/plugins/demo.minimal/assets/custom/dir.html",
          },
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PluginDetailView pluginApi={fakeApi} pluginId="demo.minimal" onBack={() => {}} />);
    const frame = await screen.findByTestId("surface-frame");
    expect(frame.getAttribute("src")).toBe("/api/plugins/demo.minimal/assets/custom/dir.html");
  });

  it("surfaces 无 entry 且无 assetUrl 时降级占位且不崩溃", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/diagnostics")) {
        return jsonResponse({ pluginId: "demo.minimal", version: "1.0.0", status: "enabled", active: true });
      }
      return jsonResponse(detailWithSurfaces([{ surfaceId: "settings-page", name: "设置页" }]));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PluginDetailView pluginApi={fakeApi} pluginId="demo.minimal" onBack={() => {}} />);
    expect(await screen.findByText(/未声明资源入口/)).toBeTruthy();
    expect(screen.queryByTestId("surface-frame")).toBeNull();
    expect(screen.queryByTestId("surface-asset-link")).toBeNull();
  });
});

describe("SourcesView（最小集响应）", () => {
  it("接受 {sourceType, label, supported}，无 id/name/trust 字段时降级渲染", async () => {
    const minimal = [
      { sourceType: "local", label: "本地目录", supported: true },
      { sourceType: "mcp", label: "MCP 配置", supported: false },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(minimal)));
    render(<SourcesView pluginApi={fakeApi} />);
    // 标题「本地目录」与来源类型标签（PLUGIN_SOURCE_LABEL["local"]）各出现一次
    expect((await screen.findAllByText("本地目录")).length).toBeGreaterThan(0);
    expect(screen.getByText("支持")).toBeTruthy();
    expect(screen.getByText("未支持")).toBeTruthy();
    // 无 trusted/trustLevel 富字段：不渲染信任徽标，不崩溃
    expect(screen.queryByText("已信任")).toBeNull();
    expect(screen.queryByText("未信任")).toBeNull();
  });
});

describe("AgentPluginsSection（最小集响应）", () => {
  it("enabled 富字段缺失时按 active/status 推导筛选启用插件", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/plugins")) {
        return jsonResponse([
          MINIMAL_LIST_ITEM,
          { ...MINIMAL_LIST_ITEM, pluginId: "demo.disabled", active: false, status: "disabled" },
        ]);
      }
      if (url.includes("/api/agents/")) {
        return jsonResponse([]);
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentPluginsSection agentId="agent-1" pluginApi={fakeApi} />);
    expect((await screen.findAllByText("demo.minimal")).length).toBeGreaterThan(0);
    expect(screen.queryByText("demo.disabled")).toBeNull();
  });
});

describe("PermissionsView（最小集响应）", () => {
  it("详情未富化 grants/agentBindings 时聚合为空并展示空态", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/plugins")) return jsonResponse([MINIMAL_LIST_ITEM]);
      if (url.endsWith("/api/plugins/demo.minimal")) return jsonResponse(MINIMAL_DETAIL);
      // /api/agents 未接线：Agent 名称展示降级为 { }
      return jsonResponse([], 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PermissionsView pluginApi={fakeApi} api={fakeServerApi} />);
    expect(await screen.findByText("暂无平台级授权记录。安装插件时确认的权限会显示在这里。")).toBeTruthy();
    expect(screen.getByText("暂无 Agent 绑定。前往 Agent 编辑页绑定已启用插件。")).toBeTruthy();
  });
});
