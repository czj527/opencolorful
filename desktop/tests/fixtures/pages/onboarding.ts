import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export interface OnboardingPO {
  heading(): HTMLElement;
  typeName(name: string): Promise<void>;
  next(): Promise<void>;
  finish(): Promise<void>;
  exit(): Promise<void>;
  errorText(): string;
  fillApiKey(value: string): Promise<void>;
  fillBaseUrl(value: string): Promise<void>;
  templateGroup(): HTMLElement;
  /** 左侧步骤轨：label 是否为当前步 */
  stepIsCurrent(label: string): boolean;
}

/** 四步首启引导 */
export function makeOnboardingPO(user: UserEvent): OnboardingPO {
  return {
    heading() {
      return screen.getByRole("heading", { level: 1 });
    },
    async typeName(name) {
      await user.type(screen.getByLabelText("名字"), name);
    },
    async next() {
      await user.click(screen.getByRole("button", { name: "下一步" }));
    },
    async finish() {
      await user.click(screen.getByRole("button", { name: "完成，开始对话" }));
    },
    async exit() {
      await user.click(screen.getByRole("button", { name: "稍后再说" }));
    },
    errorText() {
      return screen.getByRole("alert").textContent ?? "";
    },
    async fillApiKey(value) {
      const field = screen.getByLabelText("API Key");
      await user.clear(field);
      await user.type(field, value);
    },
    async fillBaseUrl(value) {
      const field = screen.getByLabelText("Base URL");
      await user.clear(field);
      await user.type(field, value);
    },
    templateGroup() {
      return screen.getByRole("radiogroup", { name: "底色模板" });
    },
    stepIsCurrent(label) {
      const item = screen.getByText(label).closest("li");
      return item?.classList.contains("is-current") ?? false;
    },
  };
}
