import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "ghost" | "icon" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly disabled?: boolean;
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly type?: "button" | "submit" | "reset";
  readonly "aria-label"?: string;
  readonly title?: string;
  readonly className?: string;
  /** 测试/自动化定位钩子（透传到 <button> 节点） */
  readonly "data-testid"?: string;
}

const sizeClass: Record<ButtonSize, string | undefined> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

const variantClass: Record<ButtonVariant, string | undefined> = {
  primary: styles.primary,
  ghost: styles.ghost,
  icon: styles.icon,
  danger: styles.danger,
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    disabled = false,
    children,
    onClick,
    type = "button",
    className,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;
  const classes = [
    styles.button,
    variantClass[variant],
    sizeClass[size],
    loading ? styles.loading : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const ariaLabel = rest["aria-label"];
  const title = rest.title;
  const testId = rest["data-testid"];

  const buttonProps: ButtonHTMLAttributes<HTMLButtonElement> = {
    type,
    disabled: isDisabled,
    className: classes,
    onClick: isDisabled ? undefined : onClick,
  };
  if (ariaLabel !== undefined) {
    buttonProps["aria-label"] = ariaLabel;
  }
  if (title !== undefined) {
    buttonProps.title = title;
  }
  if (testId !== undefined) {
    (buttonProps as Record<string, string>)["data-testid"] = testId;
  }

  return (
    <button ref={ref} {...buttonProps}>
      {loading ? (
        <span className={styles.spinner} aria-hidden="true" role="status" />
      ) : null}
      {variant !== "icon" && children ? (
        <span className={styles.label}>{children}</span>
      ) : (
        children
      )}
    </button>
  );
});
