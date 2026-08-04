import { describe, expect, it } from "vitest";
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
