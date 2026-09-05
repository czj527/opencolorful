import { render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";

import { App } from "../../src/App.js";
import { trackConsoleErrors, type ConsoleTracker } from "./console.js";

export interface AppSession {
  readonly user: UserEvent;
  readonly consoleTracker: ConsoleTracker;
  unmount(): void;
}

/**
 * 渲染完整 App 壳并等待装配完成（createDataSource → Mock 数据源就绪）。
 * MockBanner（mode==="mock" 时无条件渲染）是启动完成的稳定标记——
 * 无论首启引导是否自动弹出，它都在 DOM 上。
 */
export async function renderApp(): Promise<AppSession> {
  const consoleTracker = trackConsoleErrors();
  const user = userEvent.setup();
  const utils = render(<App />);
  await screen.findByText("当前为演示数据（后端未连接），功能仅供预览");
  return {
    user,
    consoleTracker,
    unmount: () => {
      utils.unmount();
    },
  };
}
