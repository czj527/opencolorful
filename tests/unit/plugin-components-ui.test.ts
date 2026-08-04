import { describe, expect, it } from "vitest";

import {
  defineSurfaceComponent,
  PluginComponentsNotImplementedError,
  resolveSurfaceAssetUrl,
  useHostApi,
} from "../../packages/plugin-components/src/index.js";

// ═══════════════════════════════════════════════════════════════
// plugin-components UI SDK 单测（plans/phase-12.md §8.5 / §19.1）
// - resolveSurfaceAssetUrl：受控资产路由 URL 约定
//   GET /api/plugins/:id/assets/<相对路径> 的拼接与编码；
// - defineSurfaceComponent：返回注册描述（含 assetUrl），调用不抛错；
// - useHostApi：返回降级句柄，调用不抛同步异常，句柄方法以拒绝的
//   Promise 携带 PluginComponentsNotImplementedError。
// ═══════════════════════════════════════════════════════════════

describe("resolveSurfaceAssetUrl", () => {
  it("按约定拼接 apiUrl + /api/plugins/:id/assets/:entry", () => {
    expect(resolveSurfaceAssetUrl("http://host:3000", "example.sdk-showcase", "ui/settings.html")).toBe(
      "http://host:3000/api/plugins/example.sdk-showcase/assets/ui/settings.html",
    );
  });

  it("归一化 apiUrl 尾部斜杠", () => {
    expect(resolveSurfaceAssetUrl("http://host:3000/", "demo.minimal", "ui/settings.html")).toBe(
      "http://host:3000/api/plugins/demo.minimal/assets/ui/settings.html",
    );
  });

  it("apiUrl 为空串时返回站内相对路径（可直接作 iframe src）", () => {
    expect(resolveSurfaceAssetUrl("", "demo.minimal", "ui/settings.html")).toBe(
      "/api/plugins/demo.minimal/assets/ui/settings.html",
    );
  });

  it("entry 逐段 encodeURIComponent、pluginId 整体 encodeURIComponent", () => {
    const url = resolveSurfaceAssetUrl("http://host", "plugin with space", "ui/a b/设置.html");
    expect(url).toBe(
      `http://host/api/plugins/${encodeURIComponent("plugin with space")}/assets/ui/a%20b/%E8%AE%BE%E7%BD%AE.html`,
    );
  });

  it("深层 entry 保持目录层级", () => {
    expect(resolveSurfaceAssetUrl("http://host", "p", "widgets/clock/index.html")).toBe(
      "http://host/api/plugins/p/assets/widgets/clock/index.html",
    );
  });
});

describe("defineSurfaceComponent", () => {
  const component = () => null;

  it("提供 apiUrl 时返回含 assetUrl 的注册描述且不抛错", () => {
    const registration = defineSurfaceComponent({
      pluginId: "example.sdk-showcase",
      surfaceId: "settings-page",
      kind: "page",
      entry: "ui/settings.html",
      apiUrl: "http://host:3000",
      hostCapabilities: ["theme", "toast"],
      component,
    });
    expect(registration).not.toBeNull();
    expect(registration.pluginId).toBe("example.sdk-showcase");
    expect(registration.surfaceId).toBe("settings-page");
    expect(registration.kind).toBe("page");
    expect(registration.entry).toBe("ui/settings.html");
    expect(registration.hostCapabilities).toEqual(["theme", "toast"]);
    expect(registration.component).toBe(component);
    expect(registration.assetUrl).toBe("http://host:3000/api/plugins/example.sdk-showcase/assets/ui/settings.html");
    expect(registration.bridge).toBe("unimplemented");
  });

  it("未提供 apiUrl 时 assetUrl 为 null（宿主自行拼接）", () => {
    const registration = defineSurfaceComponent({
      pluginId: "example.sdk-showcase",
      surfaceId: "settings-page",
      kind: "widget",
      entry: "ui/widget.html",
      component,
    });
    expect(registration.assetUrl).toBeNull();
  });

  it("hostCapabilities 缺省为空数组", () => {
    const registration = defineSurfaceComponent({
      pluginId: "p",
      surfaceId: "s",
      kind: "chat-surface",
      entry: "ui/chat.html",
      component,
    });
    expect(registration.hostCapabilities).toEqual([]);
  });
});

describe("useHostApi", () => {
  it("调用本身不抛异常，返回完整降级句柄", () => {
    let host: ReturnType<typeof useHostApi> | undefined;
    expect(() => {
      host = useHostApi();
    }).not.toThrow();
    for (const method of [
      "getTheme",
      "showToast",
      "readClipboard",
      "writeClipboard",
      "openResource",
      "pickResource",
      "openExternal",
      "navigate",
    ] as const) {
      expect(typeof host![method]).toBe("function");
    }
  });

  it("句柄方法以拒绝的 Promise 携带 PluginComponentsNotImplementedError（含资产路由约定说明）", async () => {
    const host = useHostApi();
    await expect(host.getTheme()).rejects.toBeInstanceOf(PluginComponentsNotImplementedError);
    await expect(host.showToast({ message: "hi" })).rejects.toThrow(/iframe 桥/);
    await expect(host.getTheme()).rejects.toThrow(/\/api\/plugins\/:id\/assets\//);
    // 同步调用不得抛异常（拒绝由 catch 消费，避免未处理拒绝）
    expect(() => {
      void host.getTheme().catch(() => {});
      void host.navigate({ path: "/" }).catch(() => {});
    }).not.toThrow();
  });
});
