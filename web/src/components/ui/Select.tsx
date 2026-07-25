import type { ReactNode, SelectHTMLAttributes } from "react";
import styles from "./Select.module.css";

export interface SelectProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly children: ReactNode;
  readonly id?: string;
  readonly "aria-label"?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function Select({
  value,
  onChange,
  children,
  id,
  disabled = false,
  className,
  ...rest
}: SelectProps) {
  const selectProps: SelectHTMLAttributes<HTMLSelectElement> = {
    id,
    value,
    disabled,
    className: className ? `${styles.select} ${className}` : styles.select,
    onChange: (e) => onChange(e.target.value),
  };
  const ariaLabel = rest["aria-label"];
  if (ariaLabel !== undefined) {
    selectProps["aria-label"] = ariaLabel;
  }

  return (
    <span className={styles.root}>
      <select {...selectProps}>{children}</select>
      <span className={styles.caret} aria-hidden="true" />
    </span>
  );
}
