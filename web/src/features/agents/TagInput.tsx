import { forwardRef, useImperativeHandle, useRef, useState, useCallback, type KeyboardEvent, type MouseEvent } from "react";
import styles from "./TagInput.module.css";

export interface TagInputProps {
  readonly tags: readonly string[];
  readonly onChange: (tags: string[]) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly id?: string;
}

export interface TagInputHandle {
  commitPendingInput(): void;
}

/**
 * 标签输入复合组件。
 * - 标签以药丸样式展示，带 × 移除按钮
 * - 内联输入框支持 Enter / 逗号创建标签
 * - 空输入框按 Backspace 移除最后一个标签
 * - 自动去重（区分大小写，trim 比较）
 */
export const TagInput = forwardRef<TagInputHandle, TagInputProps>(function TagInput({ tags, onChange, placeholder, disabled = false, id }, ref) {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const handleRemoveTag = useCallback(
    (index: number, e: MouseEvent) => {
      e.stopPropagation();
      const next = tags.slice(0, index).concat(tags.slice(index + 1));
      onChange(next);
    },
    [tags, onChange],
  );

  const commitTag = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (trimmed.length === 0) return;
      if (tags.includes(trimmed)) return; // 去重：区分大小写
      onChange([...tags, trimmed]);
    },
    [tags, onChange],
  );

  useImperativeHandle(ref, () => ({
    commitPendingInput() {
      commitTag(inputValue);
      setInputValue("");
    },
  }), [commitTag, inputValue]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        commitTag(inputValue);
        setInputValue("");
        return;
      }
      if (e.key === "Backspace" && inputValue === "" && tags.length > 0) {
        onChange(tags.slice(0, -1));
        return;
      }
    },
    [inputValue, commitTag, tags, onChange],
  );

  const containerClassName = [styles.container, disabled ? styles.disabled : ""]
    .filter(Boolean)
    .join(" ");

  const inputAriaLabel = id ?? placeholder;

  return (
    <div
      className={containerClassName}
      role="none"
      onClick={focusInput}
      onKeyDown={undefined}
    >
      {tags.map((tag, idx) => (
        <span key={`${tag}-${idx}`} className={styles.tag}>
          {tag}
          <button
            type="button"
            className={styles.tagRemove}
            aria-label={`删除 ${tag}`}
            disabled={disabled}
            onClick={(e) => handleRemoveTag(idx, e)}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        className={styles.input}
        type="text"
        value={inputValue}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={inputAriaLabel}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
});
