import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Select,
  Skeleton,
  Spinner,
  TextField,
  Toggle,
  Tooltip,
} from "./index.js";

describe("UI primitives smoke", () => {
  it("Button renders label and handles click", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>保存</Button>);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Button disabled suppresses click", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>禁用</Button>);
    fireEvent.click(screen.getByRole("button", { name: "禁用" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("IconButton exposes aria-label", () => {
    render(<IconButton icon={<span>x</span>} label="关闭" />);
    expect(screen.getByRole("button", { name: "关闭" })).toBeDefined();
  });

  it("Toggle toggles on click", () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="夜间模式" id="t1" />);
    fireEvent.click(screen.getByRole("switch", { name: "夜间模式" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("Select fires change with option value", () => {
    const onChange = vi.fn();
    render(
      <Select value="a" onChange={onChange} aria-label="模型">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("TextField binds value and shows error", () => {
    const onChange = vi.fn();
    render(
      <TextField value="hi" onChange={onChange} aria-label="名称" error="太短" />,
    );
    expect(screen.getByLabelText("名称")).toBeDefined();
    expect(screen.getByText("太短")).toBeDefined();
  });

  it("Tooltip renders content on focus", () => {
    render(<Tooltip content="提示文字">悬停我</Tooltip>);
    const trigger = screen.getByText("悬停我");
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip")).toBeDefined();
  });

  it("Badge renders children", () => {
    render(<Badge variant="success">完成</Badge>);
    expect(screen.getByText("完成")).toBeDefined();
  });

  it("Card renders children", () => {
    render(<Card>卡片内容</Card>);
    expect(screen.getByText("卡片内容")).toBeDefined();
  });

  it("Field renders label and hint", () => {
    render(
      <Field label="显示名" hint="用于侧栏">
        <input />
      </Field>,
    );
    expect(screen.getByText("显示名")).toBeDefined();
    expect(screen.getByText("用于侧栏")).toBeDefined();
  });

  it("EmptyState renders title and action", () => {
    render(<EmptyState title="还没有会话" description="点击新建" action={<button>新建</button>} />);
    expect(screen.getByText("还没有会话")).toBeDefined();
    expect(screen.getByRole("button", { name: "新建" })).toBeDefined();
  });

  it("Skeleton and Spinner render without error", () => {
    render(
      <>
        <Skeleton width={100} height={12} />
        <Spinner size={16} label="加载中" />
      </>,
    );
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(2);
    expect(statuses[1]?.getAttribute("aria-label")).toBe("加载中");
  });
});
