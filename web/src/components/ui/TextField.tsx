import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from "react";
import styles from "./TextField.module.css";

export interface TextFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly id?: string;
  readonly label?: string;
  readonly type?: "text" | "password" | "email" | "search" | "url" | "tel";
  readonly multiline?: boolean;
  readonly rows?: number;
  readonly disabled?: boolean;
  readonly error?: string;
  readonly "aria-label"?: string;
  readonly className?: string;
}

export const TextField = forwardRef<
  HTMLInputElement | HTMLTextAreaElement,
  TextFieldProps
>(function TextField(
  {
    value,
    onChange,
    placeholder,
    id,
    label,
    type = "text",
    multiline = false,
    rows = 3,
    disabled = false,
    error,
    className,
    ...rest
  },
  ref,
) {
  const controlClass = [
    styles.control,
    error ? styles.errorState : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const ariaLabel = rest["aria-label"];
  const describedBy = error !== undefined && id !== undefined ? `${id}-error` : undefined;

  if (multiline) {
    const textareaProps: TextareaHTMLAttributes<HTMLTextAreaElement> = {
      id,
      value,
      placeholder,
      disabled,
      rows,
      className: controlClass,
      onChange: (e) => onChange(e.target.value),
    };
    if (ariaLabel !== undefined) {
      textareaProps["aria-label"] = ariaLabel;
    }
    if (describedBy !== undefined) {
      textareaProps["aria-describedby"] = describedBy;
    }
    if (error !== undefined) {
      textareaProps["aria-invalid"] = "true";
    }
    return (
      <FieldShell label={label} htmlFor={id} error={error} errorId={describedBy}>
        <textarea ref={ref as React.Ref<HTMLTextAreaElement>} {...textareaProps} />
      </FieldShell>
    );
  }

  const inputProps: InputHTMLAttributes<HTMLInputElement> = {
    id,
    type,
    value,
    placeholder,
    disabled,
    className: controlClass,
    onChange: (e) => onChange(e.target.value),
  };
  if (ariaLabel !== undefined) {
    inputProps["aria-label"] = ariaLabel;
  }
  if (describedBy !== undefined) {
    inputProps["aria-describedby"] = describedBy;
  }
  if (error !== undefined) {
    inputProps["aria-invalid"] = "true";
  }

  return (
    <FieldShell label={label} htmlFor={id} error={error} errorId={describedBy}>
      <input ref={ref as React.Ref<HTMLInputElement>} {...inputProps} />
    </FieldShell>
  );
});

interface FieldShellProps {
  readonly label: string | undefined;
  readonly htmlFor: string | undefined;
  readonly error: string | undefined;
  readonly errorId: string | undefined;
  readonly children: ReactNode;
}

function FieldShell({ label, htmlFor, error, errorId, children }: FieldShellProps) {
  if (label === undefined && error === undefined) {
    return <>{children}</>;
  }
  return (
    <span className={styles.wrapper}>
      {label !== undefined && htmlFor !== undefined && (
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {label !== undefined && htmlFor === undefined && (
        <span className={styles.label}>{label}</span>
      )}
      {children}
      {error !== undefined && (
        <span id={errorId} className={styles.error} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
