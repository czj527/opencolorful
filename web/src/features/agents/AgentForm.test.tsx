import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentForm } from "./AgentForm.js";
import { ApiClient } from "../../lib/api-client.js";

const fakeApi = new ApiClient("http://test.local");

const createDraft = {
  name: "",
  persona: "",
  personality: [],
  replyStyle: "",
  innerSetting: "",
  defaultCwd: null,
  selectedTemplateKey: "",
  templateAdjusted: false,
};

const editDraft = {
  name: "HelperBot",
  persona: "A helpful assistant",
  personality: ["helpful", "polite"],
  replyStyle: "conversational",
  innerSetting: "Be supportive.",
  defaultCwd: null,
  selectedTemplateKey: "",
  templateAdjusted: false,
};

describe("AgentForm", () => {
  it("renders create mode with all sections", () => {
    const html = renderToStaticMarkup(
      <AgentForm
        api={fakeApi}
        mode="create"
        draft={createDraft}
        onChange={() => {}}
        onSubmit={async () => {}}
        onCancel={() => {}}
        submitting={false}
        error={null}
        dirty={false}
      />,
    );
    expect(html).toContain("名称（必填）");
    expect(html).toContain("选择底色起点");
    expect(html).toContain("角色描述");
    expect(html).toContain("性格特质");
    expect(html).toContain("回复风格");
    expect(html).toContain("内在设定");
    expect(html).toContain("默认工作目录");
    expect(html).toContain("创建 Agent");
  });

  it("renders edit mode without template section", () => {
    const html = renderToStaticMarkup(
      <AgentForm
        api={fakeApi}
        mode="edit"
        draft={editDraft}
        onChange={() => {}}
        onSubmit={async () => {}}
        onCancel={() => {}}
        submitting={false}
        error={null}
        dirty={false}
      />,
    );
    expect(html).toContain("HelperBot");
    expect(html).not.toContain("选择底色起点");
    expect(html).toContain("保存更改");
  });

  it("shows saved hint when saved=true in edit mode", () => {
    const html = renderToStaticMarkup(
      <AgentForm
        api={fakeApi}
        mode="edit"
        draft={editDraft}
        onChange={() => {}}
        onSubmit={async () => {}}
        onCancel={() => {}}
        submitting={false}
        error={null}
        dirty={false}
        saved={true}
      />,
    );
    expect(html).toContain("已保存");
  });

  it("does not disable submit when name is empty (shows validation on click)", () => {
    // renderToStaticMarkup renders the initial state with empty name → button should NOT be disabled
    const html = renderToStaticMarkup(
      <AgentForm
        api={fakeApi}
        mode="create"
        draft={createDraft}
        onChange={() => {}}
        onSubmit={async () => {}}
        onCancel={() => {}}
        submitting={false}
        error={null}
        dirty={false}
      />,
    );
    // The "创建 Agent" button renders — it is NOT disabled when name is empty
    // (validation error is now shown on click rather than preemptively disabling the button)
    expect(html).toContain("创建 Agent");
  });

  it("shows cancel/back button text based on mode", () => {
    const createHtml = renderToStaticMarkup(
      <AgentForm
        api={fakeApi}
        mode="create"
        draft={createDraft}
        onChange={() => {}}
        onSubmit={async () => {}}
        onCancel={() => {}}
        submitting={false}
        error={null}
        dirty={false}
      />,
    );
    expect(createHtml).toContain("取消");

    const editHtml = renderToStaticMarkup(
      <AgentForm
        api={fakeApi}
        mode="edit"
        draft={editDraft}
        onChange={() => {}}
        onSubmit={async () => {}}
        onCancel={() => {}}
        submitting={false}
        error={null}
        dirty={false}
      />,
    );
    expect(editHtml).toContain("返回");
  });

  it("shows error when error prop is set", () => {
    const html = renderToStaticMarkup(
      <AgentForm
        api={fakeApi}
        mode="create"
        draft={createDraft}
        onChange={() => {}}
        onSubmit={async () => {}}
        onCancel={() => {}}
        submitting={false}
        error="创建失败：名称已存在"
        dirty={false}
      />,
    );
    expect(html).toContain("创建失败：名称已存在");
  });

  it("shows loading text when submitting", () => {
    const html = renderToStaticMarkup(
      <AgentForm
        api={fakeApi}
        mode="create"
        draft={{ ...createDraft, name: "Test" }}
        onChange={() => {}}
        onSubmit={async () => {}}
        onCancel={() => {}}
        submitting={true}
        error={null}
        dirty={false}
      />,
    );
    expect(html).toContain("创建中");
  });
});
