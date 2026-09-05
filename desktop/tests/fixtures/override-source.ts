import type { DesktopDataSource } from "../../src/data/source.js";

/**
 * Mock 状态注入表的基础设施（desktop-test-conventions.md §四）。
 *
 * 以 Proxy 在 DesktopDataSource 接口形状内覆写指定方法，其余调用原样委托给
 * production MockDataSource——测试不得改变接口形状，也不得为注入状态修改生产代码。
 * 覆写表只描述"该数据域在目标状态下的响应"（loading / empty / error / retry /
 * malformed 等），由各测试文件按矩阵行取用。
 *
 * 注意：覆写方法必须是测试侧闭包（自行处理 Promise 语义）；对 base 实例做
 * vi.spyX 也在代理下可见（Reflect.get 返回实例自身的 spy 属性）。
 */
export function overrideSource(
  base: DesktopDataSource,
  overrides: Partial<DesktopDataSource>,
): DesktopDataSource {
  return new Proxy(base, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        return Reflect.get(overrides, property, overrides);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as DesktopDataSource;
}
