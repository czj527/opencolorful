import styles from "./Toggle.module.css";

export interface ToggleProps {
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly id?: string;
}

export function Toggle({ checked, onChange, label, disabled = false, id }: ToggleProps) {
  const inputId = id;
  const labelId = label !== undefined && inputId !== undefined ? `${inputId}-label` : undefined;

  const handleToggle = () => {
    if (disabled) return;
    onChange(!checked);
  };

  return (
    <span className={styles.root}>
      <button
        type="button"
        id={inputId}
        role="switch"
        aria-checked={checked ? "true" : "false"}
        aria-label={label}
        aria-labelledby={labelId}
        disabled={disabled}
        className={`${styles.track} ${checked ? styles.on : styles.off}`}
        onClick={handleToggle}
      >
        <span className={styles.thumb} aria-hidden="true" />
      </button>
      {label !== undefined && (
        <span id={labelId} className={styles.label}>
          {label}
        </span>
      )}
    </span>
  );
}
