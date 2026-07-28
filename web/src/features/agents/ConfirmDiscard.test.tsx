import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDiscard } from "./ConfirmDiscard.js";

describe("ConfirmDiscard", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <ConfirmDiscard open={false} mode="create" onStay={() => {}} onDiscard={() => {}} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders create mode text", () => {
    render(
      <ConfirmDiscard open={true} mode="create" onStay={() => {}} onDiscard={() => {}} />
    );
    expect(screen.getByText("放弃创建？")).toBeDefined();
    expect(screen.getByText("已填写的内容将不会保留。")).toBeDefined();
    expect(screen.getByRole("button", { name: "放弃" })).toBeDefined();
    expect(screen.getByRole("button", { name: "继续编辑" })).toBeDefined();
  });

  it("renders edit mode text", () => {
    render(
      <ConfirmDiscard open={true} mode="edit" onStay={() => {}} onDiscard={() => {}} />
    );
    expect(screen.getByText("放弃更改？")).toBeDefined();
    expect(screen.getByText("你有未保存的修改，离开后将丢失。")).toBeDefined();
    expect(screen.getByRole("button", { name: "放弃更改" })).toBeDefined();
    expect(screen.getByRole("button", { name: "继续编辑" })).toBeDefined();
  });

  it("calls onDiscard when confirm button clicked", () => {
    const onDiscard = vi.fn();
    render(
      <ConfirmDiscard open={true} mode="create" onStay={() => {}} onDiscard={onDiscard} />
    );
    const btn = screen.getByRole("button", { name: "放弃" });
    fireEvent.click(btn);
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it("calls onStay when cancel button clicked", () => {
    const onStay = vi.fn();
    render(
      <ConfirmDiscard open={true} mode="create" onStay={onStay} onDiscard={() => {}} />
    );
    const btn = screen.getByRole("button", { name: "继续编辑" });
    fireEvent.click(btn);
    expect(onStay).toHaveBeenCalledOnce();
  });
});
