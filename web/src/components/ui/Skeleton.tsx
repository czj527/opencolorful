import styles from "./Skeleton.module.css";

export interface SkeletonProps {
  readonly width?: number | string;
  readonly height?: number | string;
  readonly radius?: number | string;
  readonly className?: string;
}

function toCss(value: number | string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "number") return `${value}px`;
  return value;
}

export function Skeleton({ width, height, radius, className }: SkeletonProps) {
  const customStyle: Record<string, string> = {
    width: toCss(width, "100%"),
    height: toCss(height, "1em"),
    borderRadius: toCss(radius, "var(--radius-input)"),
  };

  const classes = [styles.skeleton, className ?? ""].filter(Boolean).join(" ");

  return (
    <div
      className={classes}
      style={customStyle}
      role="status"
      aria-label="加载中"
      aria-busy="true"
    />
  );
}
