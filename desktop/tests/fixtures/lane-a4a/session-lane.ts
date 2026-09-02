import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/**
 * A4a lane 本地 Page Object（L5）——仅覆盖共享 PO 未包含的会话行内动作：
 * 行内重命名（SESS-03）、归档区展开/恢复（SESS-04）、Composer 工作目录 chip（WS-04）。
 * 共享 PO（tests/fixtures/pages/*）保持只读，本文件不修改其任何导出。
 */
export interface SessionLanePO {
  /** 打开会话行的行内重命名输入框（铅笔按钮） */
  startRename(titleFragment: string): Promise<void>;
  /** 当前处于编辑态的标题输入框（aria-label=编辑会话标题） */
  renameInput(): HTMLInputElement;
  /** 归档区折叠开关（返回 null = 归档区未渲染） */
  archivedToggle(): HTMLElement | null;
  archivedCount(): string | null;
  /** 归档行内的「恢复」按钮 */
  unarchiveButton(titleFragment: string): HTMLElement;
  /** Composer 工作目录 chip：title=完整路径（无 title 时返回 null） */
  cwdChipByTitle(fullPath: string): HTMLElement | null;
  cwdChipText(): string | null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?${}()|[\]\\]/g, "\\$&");
}

export function makeSessionLanePO(user: UserEvent): SessionLanePO {
  return {
    async startRename(titleFragment) {
      const row = screen.getByRole("button", { name: new RegExp(escapeRegExp(titleFragment)) });
      await user.click(((): HTMLElement => {
        const button = row.querySelector("button[aria-label='编辑标题']");
        if (button === null) throw new Error(`会话行内未找到编辑按钮：${titleFragment}`);
        return button as HTMLElement;
      })());
    },
    renameInput() {
      return screen.getByRole("textbox", { name: "编辑会话标题" }) as HTMLInputElement;
    },
    archivedToggle() {
      // 精确名匹配：归档开关可访问名恰为「已归档」（图标 aria-hidden），
      // 不能用 /已归档/ 模糊匹配——恢复后的活跃行标题也可能含「已归档」字样
      return screen.queryByRole("button", { name: "已归档" });
    },
    archivedCount() {
      const count = document.querySelector(".archived-count");
      return count?.textContent ?? null;
    },
    unarchiveButton(titleFragment) {
      const row = screen.getByText(titleFragment).closest("div.thread-row");
      if (row === null) throw new Error(`未找到归档行：${titleFragment}`);
      const button = row.querySelector("button");
      if (button === null) throw new Error(`归档行内未找到恢复按钮：${titleFragment}`);
      return button as HTMLElement;
    },
    cwdChipByTitle(fullPath) {
      return screen.queryByTitle(fullPath);
    },
    cwdChipText() {
      const chip = document.querySelector(".composer-bar .chip");
      return chip?.textContent ?? null;
    },
  };
}
