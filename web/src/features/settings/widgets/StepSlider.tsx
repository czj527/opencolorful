import styles from "./StepSlider.module.css";

export interface StepSliderProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly onChange: (value: number) => void;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly "aria-label"?: string;
  readonly unit?: string;
}

/**
 * 带数值显示的步进滑块。
 * 用于 LayoutSection 的侧栏宽度等数值型偏好——
 * 相比纯 number input，滑块能直观呈现取值范围与当前位置。
 */
export function StepSlider({
  value,
  min,
  max,
  step,
  onChange,
  id,
  disabled = false,
  unit,
  ...rest
}: StepSliderProps) {
  const ariaLabel = rest["aria-label"];
  const inputProps: Record<string, unknown> = {
    id,
    type: "range",
    min,
    max,
    step,
    value,
    disabled,
    className: styles.slider,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(Number(e.target.value)),
  };
  if (ariaLabel !== undefined) inputProps["aria-label"] = ariaLabel;
  if (id !== undefined) inputProps["aria-describedby"] = `${id}-val`;

  return (
    <span className={styles.root}>
      <input {...inputProps} />
      <span id={id !== undefined ? `${id}-val` : undefined} className={styles.value} aria-hidden="true">
        {value}
        {unit !== undefined ? unit : ""}
      </span>
    </span>
  );
}
