import styles from "./Spinner.module.css";

export interface SpinnerProps {
  readonly size?: number;
  readonly label?: string;
}

export function Spinner({ size = 16, label }: SpinnerProps) {
  const customStyle: Record<string, string> = {
    width: `${size}px`,
    height: `${size}px`,
  };
  return (
    <span
      className={styles.spinner}
      style={customStyle}
      role="status"
      aria-label={label ?? "加载中"}
      aria-busy="true"
    />
  );
}
