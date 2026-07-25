import type { ReactNode } from "react";
import styles from "./Card.module.css";

export interface CardProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly as?: "div" | "section" | "article" | "aside" | "header" | "footer";
  readonly role?: string;
  readonly "aria-label"?: string;
}

export function Card({
  children,
  className,
  as: Tag = "div",
  role,
  ...rest
}: CardProps) {
  const classes = [styles.card, className ?? ""].filter(Boolean).join(" ");
  const ariaLabel = rest["aria-label"];

  const props: Record<string, unknown> = { className: classes };
  if (role !== undefined) props.role = role;
  if (ariaLabel !== undefined) props["aria-label"] = ariaLabel;

  return <Tag {...props}>{children}</Tag>;
}
