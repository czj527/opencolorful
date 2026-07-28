import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TagInput } from "./TagInput.js";

describe("TagInput", () => {
  it("renders existing tags", () => {
    const tags = ["理性", "客观"];
    render(<TagInput tags={tags} onChange={() => {}} />);
    expect(screen.getByText("理性")).toBeDefined();
    expect(screen.getByText("客观")).toBeDefined();
  });

  it("adds tag on Enter", async () => {
    const onChange = vi.fn();
    render(<TagInput tags={[]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "严谨{Enter}");
    expect(onChange).toHaveBeenCalledWith(["严谨"]);
  });

  it("adds tag on comma", async () => {
    const onChange = vi.fn();
    render(<TagInput tags={[]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "严谨,");
    expect(onChange).toHaveBeenCalledWith(["严谨"]);
  });

  it("removes tag on backspace when input is empty", async () => {
    const onChange = vi.fn();
    render(<TagInput tags={["理性", "客观"]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "{Backspace}");
    expect(onChange).toHaveBeenCalledWith(["理性"]);
  });

  it("removes tag on × click", async () => {
    const onChange = vi.fn();
    render(<TagInput tags={["理性", "客观", "严谨"]} onChange={onChange} />);
    // Click × on "客观" (second tag)
    const removeButtons = screen.getAllByRole("button");
    fireEvent.click(removeButtons[1]!);
    expect(onChange).toHaveBeenCalledWith(["理性", "严谨"]);
  });

  it("deduplicates tags (case-sensitive)", async () => {
    const onChange = vi.fn();
    render(<TagInput tags={["理性"]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "理性{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores empty/whitespace-only input", async () => {
    const onChange = vi.fn();
    render(<TagInput tags={[]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "   {Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("trims whitespace from tag text", async () => {
    const onChange = vi.fn();
    render(<TagInput tags={[]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "  严谨  {Enter}");
    expect(onChange).toHaveBeenCalledWith(["严谨"]);
  });

  it("shows placeholder text", () => {
    render(<TagInput tags={[]} onChange={() => {}} placeholder="输入后按回车添加" />);
    expect(screen.getByPlaceholderText("输入后按回车添加")).toBeDefined();
  });

  it("disables input and tag removal when disabled", () => {
    render(<TagInput tags={["理性"]} onChange={() => {}} disabled />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});
