import type { ReactElement, ReactNode } from "react";
import { render } from "@testing-library/react";

export type Theme = "dark" | "light";

interface RenderWithThemeOptions {
  /** 主题，默认 dark（与 setup.ts 注入的默认主题一致） */
  readonly theme?: Theme;
}

/**
 * 以默认主题包装渲染组件。
 *
 * 本项目主题通过 document.documentElement.dataset.theme 提供，
 * 不存在 React 层的 ThemeProvider。因此这里在渲染前同步设置
 * documentElement 的 data-theme 属性，使依赖 CSS 变量的组件
 * 在 happy-dom 下获得稳定主题上下文。
 *
 * 返回标准 @testing-library/react 的 render 结果，便于测试
 * 使用 screen / fireEvent / user-event 等交互式断言。
 */
export function renderWithTheme(
  ui: ReactElement,
  { theme = "dark" }: RenderWithThemeOptions = {},
) {
  document.documentElement.dataset.theme = theme;
  return render(ui);
}

/**
 * 一个最小包装器，便于后续测试在需要时把多个 provider（如 Context、Router）
 * 包到被测组件外层。当前没有 React 层 provider，仅原样返回 children。
 */
export function DefaultProviders({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}

export { render } from "@testing-library/react";
