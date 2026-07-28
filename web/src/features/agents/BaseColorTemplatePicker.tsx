import { useEffect, useState } from "react";
import type { ApiClient } from "../../lib/api-client.js";
import type { BaseColorTemplate } from "../../lib/types.js";
import styles from "./BaseColorTemplatePicker.module.css";

/** onSelect 回调传入的 baseColor 形状（与 createAgent 入参一致） */
export interface BaseColorDraft {
  readonly persona: string;
  readonly personality: string[];
  readonly replyStyle: string;
  readonly innerSetting: string;
}

export interface BaseColorTemplatePickerProps {
  readonly api: ApiClient;
  /** 选中模板时回调，传入模板的 baseColor 副本（数组转为可变 string[]）和模板 key */
  readonly onSelect: (baseColor: BaseColorDraft, key: string) => void;
  /** 当前选中的模板 key，用于高亮；空字符串表示无选中 */
  readonly selectedKey?: string;
  /** 禁用整个选择器 */
  readonly disabled?: boolean;
}

/**
 * 底色模板选择器。渲染 5 个色卡（空白 + 蓝/橙/绿/紫），
 * 点击调 onSelect(baseColor)。模板只在创建时填充表单，Agent 不保存 templateId。
 */
export function BaseColorTemplatePicker(props: BaseColorTemplatePickerProps) {
  const [templates, setTemplates] = useState<readonly BaseColorTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await props.api.getBaseColorTemplates();
        if (!cancelled) {
          setTemplates(list);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "模板加载失败");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.api]);

  const handleSelect = (template: BaseColorTemplate) => {
    if (props.disabled) return;
    // 转为可变数组，便于后续表单编辑
    props.onSelect(
      {
        persona: template.baseColor.persona,
        personality: [...template.baseColor.personality],
        replyStyle: template.baseColor.replyStyle,
        innerSetting: template.baseColor.innerSetting,
      },
      template.key,
    );
  };

  if (loading) {
    return <p className={styles.hint}>加载模板中…</p>;
  }
  if (error !== null) {
    return <p className={styles.error} role="alert">{error}</p>;
  }
  if (templates.length === 0) {
    return <p className={styles.hint}>暂无可用模板</p>;
  }

  return (
    <ul className={styles.grid} role="radiogroup" aria-label="底色模板">
      {templates.map((tpl) => {
        const selected = props.selectedKey === tpl.key;
        const className = [
          styles.card,
          selected ? styles.selected : "",
          props.disabled ? styles.disabled : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <li key={tpl.key} className={styles.cell}>
            <button
              type="button"
              className={className}
              role="radio"
              aria-checked={selected}
              aria-label={`${tpl.label} ${tpl.description}`}
              disabled={props.disabled}
              onClick={() => handleSelect(tpl)}
            >
              <span
                className={styles.dot}
                style={{ backgroundColor: tpl.color }}
                aria-hidden="true"
              />
              <span className={styles.label}>{tpl.label}</span>
              <span className={styles.description}>{tpl.description}</span>
              {tpl.baseColor.personality.length > 0 && (
                <span className={styles.traits}>
                  {tpl.baseColor.personality.slice(0, 3).map((t) => (
                    <span key={t} className={styles.trait}>{t}</span>
                  ))}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
