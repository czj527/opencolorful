import type { ReactNode } from "react";
import styles from "./Field.module.css";

export interface FieldProps {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly required?: boolean;
  readonly children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, required = false, children }: FieldProps) {
  const hasError = error !== undefined;
  const describedBy = [];

  if (hint !== undefined && htmlFor !== undefined) {
    describedBy.push(`${htmlFor}-hint`);
  }
  if (hasError && htmlFor !== undefined) {
    describedBy.push(`${htmlFor}-error`);
  }
  const ariaDescribedBy = describedBy.length > 0 ? describedBy.join(" ") : undefined;

  return (
    <div className={styles.root}>
      <label className={styles.label} htmlFor={htmlFor}>
        <span>{label}</span>
        {required && (
          <span className={styles.required} aria-hidden="true">
            *
          </span>
        )}
      </label>
      <div className={styles.control} aria-describedby={ariaDescribedBy} aria-required={required ? "true" : undefined} aria-invalid={hasError ? "true" : undefined}>
        {children}
      </div>
      {hint !== undefined && (
        <p id={htmlFor !== undefined ? `${htmlFor}-hint` : undefined} className={styles.hint}>
          {hint}
        </p>
      )}
      {hasError && (
        <p
          id={htmlFor !== undefined ? `${htmlFor}-error` : undefined}
          className={styles.error}
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}
