import type { ReactNode } from "react";
import styles from "./SettingsRow.module.css";

export interface SettingsRowProps {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly htmlFor?: string | undefined;
  readonly error?: string | undefined;
  readonly required?: boolean;
  /** 行尾的动作区（如保存按钮、状态徽章）；放在控件右侧 */
  readonly action?: ReactNode | undefined;
  /** 主控件区 */
  readonly children: ReactNode;
}

/**
 * 设置行的统一骨架：label + hint + control + 可选 action。
 * 用 ui/Field 的语义但提供横向布局（label 左、控件右），
 * 适配设置中心「一行一项」的密集表单。
 */
export function SettingsRow({ label, hint, htmlFor, error, required = false, action, children }: SettingsRowProps) {
  const describedBy: string[] = [];
  if (hint !== undefined && htmlFor !== undefined) describedBy.push(`${htmlFor}-hint`);
  if (error !== undefined && htmlFor !== undefined) describedBy.push(`${htmlFor}-error`);
  const ariaDescribedBy = describedBy.length > 0 ? describedBy.join(" ") : undefined;

  return (
    <div className={styles.row}>
      <div className={styles.labelCol}>
        <label className={styles.label} htmlFor={htmlFor}>
          <span>{label}</span>
          {required && <span className={styles.required} aria-hidden="true">*</span>}
        </label>
        {hint !== undefined && (
          <p id={htmlFor !== undefined ? `${htmlFor}-hint` : undefined} className={styles.hint}>
            {hint}
          </p>
        )}
      </div>
      <div className={styles.controlCol}>
        <div
          className={styles.control}
          aria-describedby={ariaDescribedBy}
          aria-required={required ? "true" : undefined}
          aria-invalid={error !== undefined ? "true" : undefined}
        >
          {children}
        </div>
        {action !== undefined && <div className={styles.action}>{action}</div>}
        {error !== undefined && (
          <p id={htmlFor !== undefined ? `${htmlFor}-error` : undefined} className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export interface SettingsInlineRowProps {
  readonly children: ReactNode;
}

/**
 * 把多个控件横向并排成一行（例如左侧宽度 + 右侧宽度）。
 */
export function SettingsInlineRow({ children }: SettingsInlineRowProps) {
  return <div className={styles.inlineRow}>{children}</div>;
}

export interface SettingsSaveFeedbackProps {
  readonly saving?: boolean;
  readonly saved?: boolean;
  readonly error?: string | null | undefined;
  readonly savedText?: string | undefined;
  readonly savingText?: string | undefined;
}

/**
 * 统一的保存反馈条：成功用 --success + 文案，失败用 --danger + role=alert。
 * 各 section 复用，保证保存反馈一致。
 */
export function SettingsSaveFeedback({
  saving = false,
  saved = false,
  error,
  savedText = "已保存",
  savingText = "保存中…",
}: SettingsSaveFeedbackProps) {
  if (error !== undefined && error !== null && error.length > 0) {
    return (
      <p className={styles.feedbackError} role="alert">
        {error}
      </p>
    );
  }
  if (saving) {
    return <p className={styles.feedbackSaving}>{savingText}</p>;
  }
  if (saved) {
    return <p className={styles.feedbackSaved}>{savedText}</p>;
  }
  return null;
}
