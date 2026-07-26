import styles from "./UnavailableSection.module.css";

export function UnavailableSection() {
  return (
    <p className={styles.notice} role="alert">
      尚未启用。此功能将在后续阶段开放。
    </p>
  );
}
