import type { ReactNode } from "react";
import styles from "./SettingsSection.module.css";

export interface SettingsSectionProps {
  readonly title: string;
  readonly description?: string | undefined;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}

/**
 * 设置中心的「区块」骨架：统一的标题 + 描述 + 内容区布局。
 * 各 section 顶层用它包装，替代散落的 .settings-section h2/p 结构。
 */
export function SettingsSection({ title, description, children, testId }: SettingsSectionProps) {
  return (
    <section className={styles.root} data-testid={testId}>
      <header className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        {description !== undefined && <p className={styles.description}>{description}</p>}
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}

export interface SettingsSubsectionProps {
  readonly title: string;
  readonly children: ReactNode;
}
/**
 * section 内部的小节分隔：用于把同一 section 切成若干子区域，
 * 例如 LayoutSection 的「显示偏好」。
 */
export function SettingsSubsection({ title, children }: SettingsSubsectionProps) {
  return (
    <div className={styles.subsection}>
      <h3 className={styles.subsectionTitle}>{title}</h3>
      <div className={styles.subsectionBody}>{children}</div>
    </div>
  );
}
