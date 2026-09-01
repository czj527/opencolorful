import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export interface MemoryPagePO {
  /** 数据到达的稳定标记：健康状态区渲染 */
  ready(): Promise<HTMLElement>;
  search(keyword: string): Promise<void>;
  sectionHeading(pattern: RegExp): HTMLElement;
  /** 按标题取 section 容器（供 within 限定断言范围） */
  section(pattern: RegExp): HTMLElement;
  /** 置顶行数 = 删除按钮数 */
  pinnedItems(): HTMLElement[];
  addPinned(content: string): Promise<void>;
  deletePinned(content: string): Promise<void>;
  /** 事实行数（每行 small 都带 confidence 标注） */
  factCount(): number;
  /** 事件行数（每行 small 都带 Session 标注） */
  eventCount(): number;
}

/** 记忆页：搜索 / 置顶增删 / 可见断言 */
export function makeMemoryPagePO(user: UserEvent): MemoryPagePO {
  const sectionByHeading = (pattern: RegExp): HTMLElement => {
    const heading = screen.getByRole("heading", { name: pattern });
    const section = heading.closest("section");
    if (section === null) throw new Error(`未找到标题为 ${pattern} 的 section`);
    return section;
  };
  return {
    async ready() {
      return screen.findByLabelText("记忆健康状态");
    },
    async search(keyword) {
      await user.type(screen.getByPlaceholderText("搜索事实与事件…"), keyword);
    },
    sectionHeading(pattern) {
      return screen.getByRole("heading", { name: pattern });
    },
    section(pattern) {
      return sectionByHeading(pattern);
    },
    pinnedItems() {
      return within(sectionByHeading(/^置顶记忆/)).getAllByRole("button", { name: "删除置顶" });
    },
    async addPinned(content) {
      await user.type(screen.getByPlaceholderText("添加一条置顶记忆…"), content);
      await user.click(screen.getByRole("button", { name: "添加" }));
    },
    async deletePinned(content) {
      const row = screen.getByText(content).closest("div");
      const item = row?.parentElement ?? null;
      if (item === null) throw new Error(`未找到置顶条目容器：${content}`);
      await user.click(within(item).getByRole("button", { name: "删除置顶" }));
    },
    factCount() {
      // queryAllByText：过滤后 0 条是合法状态（getAllByText 在零匹配时会抛错）
      return within(sectionByHeading(/^已审批事实/)).queryAllByText(/confidence \d/).length;
    },
    eventCount() {
      return within(sectionByHeading(/^事件时间线/)).queryAllByText(/· Session /).length;
    },
  };
}
