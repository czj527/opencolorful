import { describe, expect, it } from "vitest";

import {
  extractSummarySection,
  hasRequiredSections,
  validateSummaryFormat,
} from "../../src/runtime/memory/summary-format.js";

describe("validateSummaryFormat", () => {
  it("完整格式通过校验", () => {
    const text = `### 重要事实
- 事实一
- 事实二

### 时间线
- 14:03 用户开始工作
- 14:05 助手完成响应`;

    const result = validateSummaryFormat(text);
    expect(result.ok).toBe(true);
  });

  it("缺失 重要事实 节", () => {
    const text = `### 时间线
- 14:03 用户开始工作`;

    const result = validateSummaryFormat(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["facts"]);
    }
  });

  it("缺失 时间线 节", () => {
    const text = `### 重要事实
- 事实一`;

    const result = validateSummaryFormat(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["timeline"]);
    }
  });

  it("两节都缺失", () => {
    const text = "没有任何节的内容";

    const result = validateSummaryFormat(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["facts", "timeline"]);
    }
  });

  it("容忍 ## 二级标题变体", () => {
    const text = `## 重要事实
- 事实一

## 时间线
- 14:03 用户开始工作`;

    expect(validateSummaryFormat(text).ok).toBe(true);
  });

  it("容忍全角冒号", () => {
    const text = `### 重要事实：
- 事实一

### 时间线：
- 14:03 用户开始工作`;

    expect(validateSummaryFormat(text).ok).toBe(true);
  });

  it("容忍半角冒号", () => {
    const text = `### 重要事实:
- 事实一

### 时间线:
- 14:03 用户开始工作`;

    expect(validateSummaryFormat(text).ok).toBe(true);
  });

  it("节之间可以有任意内容", () => {
    const text = `### 重要事实
- 事实一

中间有一些无关文本。

### 时间线
- 14:03 某事件`;

    expect(validateSummaryFormat(text).ok).toBe(true);
  });
});

describe("extractSummarySection", () => {
  it("提取重要事实节内容", () => {
    const text = `### 重要事实
- 用户偏好使用 TypeScript
- 项目名为 opencolorful

### 时间线
- 14:03 讨论了架构`;

    const facts = extractSummarySection(text, "facts");
    expect(facts).toContain("用户偏好使用 TypeScript");
    expect(facts).toContain("项目名为 opencolorful");
    expect(facts).not.toContain("14:03");
  });

  it("提取时间线节内容", () => {
    const text = `### 重要事实
- 事实

### 时间线
- 14:03 第一问
- 14:05 助手回答
- 14:08 完成`;

    const timeline = extractSummarySection(text, "timeline");
    expect(timeline).toContain("14:03");
    expect(timeline).toContain("14:05");
    expect(timeline).toContain("14:08");
    expect(timeline).not.toContain("事实");
  });

  it("节不存在返回空字符串", () => {
    const text = `### 重要事实
- 只有事实`;

    expect(extractSummarySection(text, "timeline")).toBe("");
    expect(extractSummarySection("无节文本", "facts")).toBe("");
  });

  it("节标题无冒号变体", () => {
    const text = `### 重要事实
- 事实内容

### 时间线
- 事件内容`;

    expect(extractSummarySection(text, "facts")).toContain("事实内容");
    expect(extractSummarySection(text, "timeline")).toContain("事件内容");
  });

  it("节标题后有冒号（全角）", () => {
    const text = `### 重要事实：
- 事实内容

### 时间线：
- 事件内容`;

    expect(extractSummarySection(text, "facts")).toContain("事实内容");
    expect(extractSummarySection(text, "timeline")).toContain("事件内容");
  });

  it("下一个标题行正确截断", () => {
    const text = `### 重要事实
- 事实A

### 时间线
- 14:03 事件B

### 其他节
这些不应出现在提取结果中`;

    const facts = extractSummarySection(text, "facts");
    expect(facts).toContain("事实A");
    expect(facts).not.toContain("14:03");
    expect(facts).not.toContain("其他节");

    const timeline = extractSummarySection(text, "timeline");
    expect(timeline).toContain("事件B");
    expect(timeline).not.toContain("事实A");
    expect(timeline).not.toContain("其他节");
  });
});

describe("hasRequiredSections", () => {
  it("完整格式返回 true", () => {
    expect(
      hasRequiredSections(`### 重要事实\n- x\n### 时间线\n- y`),
    ).toBe(true);
  });

  it("缺失节返回 false", () => {
    expect(hasRequiredSections("只有一些文本")).toBe(false);
  });
});
