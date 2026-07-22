import type { ReactNode } from "react";

interface IconButtonProps {
  readonly icon: string;
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly variant?: "default" | "primary" | "danger";
  readonly title?: string;
  readonly children?: ReactNode;
}

export function IconButton({
  icon,
  label,
  onClick,
  disabled = false,
  variant = "default",
  title,
  children,
}: IconButtonProps) {
  const className = `icon-button${variant !== "default" ? ` ${variant}` : ""}`;
  return (
    <button
      className={className}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      type="button"
    >
      <span aria-hidden="true">{icon}</span>
      {children}
    </button>
  );
}
