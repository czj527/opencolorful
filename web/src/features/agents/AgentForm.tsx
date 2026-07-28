import { useRef, useState } from "react";
import type { ApiClient } from "../../lib/api-client.js";
import { TextField, Button } from "../../components/ui/index.js";
import {
  BaseColorTemplatePicker,
  DirectoryPicker,
  TagInput,
  type BaseColorDraft,
  type TagInputHandle,
} from "./index.js";
import styles from "./AgentForm.module.css";

export type AgentFormMode = "create" | "edit";

export interface AgentSandboxDraft {
  extraReadPaths: string[];
  protectedPaths: string[];
}

export interface AgentFormDraft {
  name: string;
  persona: string;
  personality: string[];
  replyStyle: string;
  innerSetting: string;
  defaultCwd: string | null;
  sandbox?: AgentSandboxDraft;
  selectedTemplateKey: string;
  templateAdjusted: boolean;
}

export interface AgentFormProps {
  readonly api: ApiClient;
  readonly mode: AgentFormMode;
  readonly draft: AgentFormDraft;
  readonly onChange: (patch: Partial<AgentFormDraft>) => void;
  readonly onSubmit: () => Promise<void>;
  readonly onCancel: () => void;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly dirty: boolean;
  readonly saved?: boolean;
}

export function AgentForm(props: AgentFormProps) {
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<{ baseColor: BaseColorDraft; key: string } | null>(null);
  const [nameError, setNameError] = useState(false);
  const personalityTagRef = useRef<TagInputHandle>(null);
  const extraReadPathsTagRef = useRef<TagInputHandle>(null);
  const protectedPathsTagRef = useRef<TagInputHandle>(null);

  const handleTemplateSelect = (baseColor: BaseColorDraft, key: string) => {
    if (props.draft.templateAdjusted) {
      setPendingTemplate({ baseColor, key });
      setShowOverwriteConfirm(true);
    } else {
      applyTemplate(baseColor, key);
    }
  };

  const applyTemplate = (baseColor: BaseColorDraft, key: string) => {
    props.onChange({
      persona: baseColor.persona,
      personality: [...baseColor.personality],
      replyStyle: baseColor.replyStyle,
      innerSetting: baseColor.innerSetting,
      selectedTemplateKey: key,
      templateAdjusted: false,
    });
  };

  const handleConfirmOverwrite = () => {
    if (!pendingTemplate) return;
    applyTemplate(pendingTemplate.baseColor, pendingTemplate.key);
    setShowOverwriteConfirm(false);
    setPendingTemplate(null);
  };

  const handleCancelOverwrite = () => {
    setShowOverwriteConfirm(false);
    setPendingTemplate(null);
  };

  const handleFieldChange = (patch: Partial<AgentFormDraft>) => {
    // Clear name error when name changes
    if ("name" in patch) setNameError(false);
    // Only mark templateAdjusted when editing template-related fields
    const isTemplateField = "selectedTemplateKey" in patch || "templateAdjusted" in patch;
    const templateFields: (keyof AgentFormDraft)[] = ["persona", "personality", "replyStyle", "innerSetting"];
    const editingTemplate = Object.keys(patch).some((k) => templateFields.includes(k as keyof AgentFormDraft));
    const adjustedPatch = isTemplateField
      ? patch
      : editingTemplate
        ? { ...patch, templateAdjusted: true }
        : patch;
    props.onChange(adjustedPatch);
  };

  const handleSubmit = () => {
    personalityTagRef.current?.commitPendingInput();
    extraReadPathsTagRef.current?.commitPendingInput();
    protectedPathsTagRef.current?.commitPendingInput();
    if (!props.draft.name.trim()) {
      setNameError(true);
      return;
    }
    // Allow React to process the tag commit before submitting
    setTimeout(() => {
      void props.onSubmit();
    }, 0);
  };

  const isCreate = props.mode === "create";
  const hasTemplateSection = isCreate;

  return (
    <div className={styles.page}>
      {/* Section 1: 名称 */}
      <section className={styles.section}>
        <div className={styles.sectionLabel}>名称（必填）</div>
        {nameError && (
          <div className={styles.error} role="alert">请输入 Agent 名称</div>
        )}
        <TextField
          value={props.draft.name}
          onChange={(v) => handleFieldChange({ name: v })}
          placeholder="例如：小蓝"
          disabled={props.submitting}
          aria-label="Agent 名称"
        />
      </section>

      {/* Section 2: 选择底色起点 (create only) */}
      {hasTemplateSection && (
        <section className={styles.section}>
          <div className={styles.sectionLabel}>
            选择底色起点
            {props.draft.selectedTemplateKey && props.draft.templateAdjusted && (
              <span className={styles.adjustedTag}>已调整</span>
            )}
          </div>
          <BaseColorTemplatePicker
            api={props.api}
            onSelect={handleTemplateSelect}
            selectedKey={props.draft.selectedTemplateKey}
            disabled={props.submitting}
          />

          {showOverwriteConfirm && (
            <div className={styles.overwriteBanner}>
              <p className={styles.overwriteText}>选择模板将覆盖当前已编辑的底色内容</p>
              <div className={styles.overwriteActions}>
                <Button variant="ghost" size="sm" onClick={handleCancelOverwrite} disabled={props.submitting}>
                  取消
                </Button>
                <Button variant="primary" size="sm" onClick={handleConfirmOverwrite} disabled={props.submitting}>
                  确认覆盖
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Section 3: 角色描述 */}
      <section className={styles.section}>
        <div className={styles.sectionLabel}>角色描述</div>
        <div className={styles.field}>
          <TextField
            value={props.draft.persona}
            onChange={(v) => handleFieldChange({ persona: v })}
            multiline
            rows={4}
            placeholder="描述这个 Agent 是谁、扮演什么角色"
            disabled={props.submitting}
          />
        </div>
      </section>

      {/* Section 4: 性格特质 */}
      <section className={styles.section}>
        <div className={styles.sectionLabel}>性格特质</div>
        <div className={styles.field}>
          <TagInput
            ref={personalityTagRef}
            tags={props.draft.personality}
            onChange={(tags) => handleFieldChange({ personality: tags })}
            placeholder="输入后按回车添加"
            disabled={props.submitting}
          />
        </div>
      </section>

      {/* Section 5: 回复风格 */}
      <section className={styles.section}>
        <div className={styles.sectionLabel}>回复风格</div>
        <div className={styles.field}>
          <TextField
            value={props.draft.replyStyle}
            onChange={(v) => handleFieldChange({ replyStyle: v })}
            placeholder="例如：简洁直接"
            disabled={props.submitting}
          />
        </div>
      </section>

      {/* Section 6: 内在设定 */}
      <section className={styles.section}>
        <div className={styles.sectionLabel}>内在设定</div>
        <div className={styles.field}>
          <TextField
            value={props.draft.innerSetting}
            onChange={(v) => handleFieldChange({ innerSetting: v })}
            multiline
            rows={4}
            placeholder="描述这个 Agent 的内在原则与边界"
            disabled={props.submitting}
          />
        </div>
      </section>

      {/* Section 7: 默认工作目录 */}
      <section className={styles.section}>
        <div className={styles.sectionLabel}>默认工作目录</div>
        <DirectoryPicker
          api={props.api}
          value={props.draft.defaultCwd}
          onChange={(path) => handleFieldChange({ defaultCwd: path })}
          disabled={props.submitting}
        />
      </section>

      {/* Section 8: 沙箱配置 */}
      <section className={styles.section}>
        <div className={styles.sectionLabel}>沙箱配置</div>
        <div className={styles.field}>
          <label className={styles.sandboxLabel}>额外可读路径</label>
          <TagInput
            ref={extraReadPathsTagRef}
            tags={props.draft.sandbox?.extraReadPaths ?? []}
            onChange={(paths) =>
              handleFieldChange({
                sandbox: {
                  extraReadPaths: paths,
                  protectedPaths: props.draft.sandbox?.protectedPaths ?? [],
                },
              })
            }
            placeholder="输入后按回车添加，例如：/mnt/shared"
            disabled={props.submitting}
          />
          <p className={styles.sandboxHint}>
            Agent 可以访问这些路径下的文件（仅限读取权限）
          </p>
        </div>
        <div className={styles.field}>
          <label className={styles.sandboxLabel}>受保护路径</label>
          <TagInput
            ref={protectedPathsTagRef}
            tags={props.draft.sandbox?.protectedPaths ?? []}
            onChange={(paths) =>
              handleFieldChange({
                sandbox: {
                  extraReadPaths: props.draft.sandbox?.extraReadPaths ?? [],
                  protectedPaths: paths,
                },
              })
            }
            placeholder="输入后按回车添加，例如：.env"
            disabled={props.submitting}
          />
          <p className={styles.sandboxHint}>
            Agent 无法访问工作区内这些路径下的文件（黑名单保护）
          </p>
        </div>
      </section>

      {/* Error display */}
      {props.error !== null && (
        <div className={styles.error} role="alert">
          {props.error}
        </div>
      )}

      {/* Sticky action bar */}
      <div className={styles.bar}>
        <div className={styles.barLeft}>
          <Button variant="ghost" onClick={props.onCancel} disabled={props.submitting}>
            {isCreate ? "取消" : "返回"}
          </Button>
        </div>
        <div className={styles.barRight}>
          {props.saved === true && (
            <span className={styles.savedHint}>已保存</span>
          )}
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={props.submitting}
            loading={props.submitting}
          >
            {props.submitting
              ? (isCreate ? "创建中…" : "保存中…")
              : (isCreate ? "创建 Agent" : "保存更改")}
          </Button>
        </div>
      </div>
    </div>
  );
}
