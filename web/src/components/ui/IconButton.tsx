import { forwardRef, type ReactNode } from "react";
import styles from "./IconButton.module.css";

export type IconButtonVariant = "default" | "primary" | "danger";
export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly variant?: IconButtonVariant;
  readonly size?: IconButtonSize;
  readonly active?: boolean;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

const sizeClass: Record<IconButtonSize, string | undefined> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

const variantClass: Record<IconButtonVariant, string | undefined> = {
  default: styles.default,
  primary: styles.primary,
  danger: styles.danger,
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      icon,
      label,
      variant = "default",
      size = "md",
      active = false,
      onClick,
      disabled = false,
      className,
    },
    ref,
  ) {
    const classes = [
      styles.button,
      variantClass[variant],
      sizeClass[size],
      active ? styles.active : "",
      className ?? "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        ref={ref}
        type="button"
        className={classes}
        onClick={disabled ? undefined : onClick}
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-pressed={active ? "true" : "false"}
      >
        {icon}
      </button>
    );
  },
);
