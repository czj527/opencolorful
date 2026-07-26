import { useState, type ReactNode } from "react";
import { Select } from "../../../components/ui/index.js";
import styles from "./ComboInput.module.css";

export interface ComboInputOption {
  readonly value: string;
  readonly label: string;
}

export interface ComboInputProps {
  /** 预设选项；value 为空字符串表示「自定义」入口 */
  readonly options: readonly ComboInputOption[];
  /** 当前值。若不在 options 中则视为自定义 */
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly "aria-label"?: string;
  readonly placeholder?: string;
  /** 自定义输入框的 type，默认 text */
  readonly inputType?: "text" | "password" | "url" | "email" | "tel";
  readonly children?: ReactNode;
}

const CUSTOM_VALUE = "__custom__";

/**
 * 组合输入：select 预设 + 自由文本输入。
 * 用于 DefaultsSection 默认模型（provider:model 形式）等场景——
 * 既能从已配置模型里选，也允许直接输入。
 *
 * 当 value 命中某个 option 时显示 select；否则切到自定义文本输入。
 */
export function ComboInput({
  options,
  value,
  onChange,
  id,
  disabled = false,
  placeholder,
  inputType = "text",
  ...rest
}: ComboInputProps) {
  const ariaLabel = rest["aria-label"];
  const matched = options.find((o) => o.value === value);
  const [mode, setMode] = useState<"select" | "custom">(matched !== undefined ? "select" : "custom");

  const selectValue = mode === "custom" ? CUSTOM_VALUE : matched !== undefined ? value : "";
  const selectOptions: ComboInputOption[] = [
    ...options,
    { value: CUSTOM_VALUE, label: "自定义…" },
  ];

  const handleSelectChange = (next: string) => {
    if (next === CUSTOM_VALUE) {
      setMode("custom");
      // 进入自定义模式时清空当前值，让用户重新输入
      onChange("");
    } else {
      setMode("select");
      onChange(next);
    }
  };

  const inputProps: Record<string, unknown> = {
    id,
    type: inputType,
    value,
    disabled,
    placeholder,
    className: styles.input,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
  };
  if (ariaLabel !== undefined) inputProps["aria-label"] = ariaLabel;

  const selectExtra: { id?: string; "aria-label"?: string } = {};
  if (id !== undefined) selectExtra.id = `${id}-combo`;
  if (ariaLabel !== undefined) selectExtra["aria-label"] = `${ariaLabel}（选择）`;

  return (
    <span className={styles.root}>
      <Select value={selectValue} onChange={handleSelectChange} disabled={disabled} {...selectExtra}>
        {selectOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      {mode === "custom" && <input {...inputProps} />}
    </span>
  );
}
