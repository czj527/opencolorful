import { useState } from "react";
import { ApiClient, ApiClientError } from "../../lib/api-client.js";
import { Button, TextField } from "../../components/ui/index.js";
import styles from "./DirectoryPicker.module.css";

export interface DirectoryPickerProps {
  readonly api: ApiClient;
  /** 当前路径，null 表示未设置 */
  readonly value: string | null;
  /** 路径变更回调，传 null 表示清除 */
  readonly onChange: (path: string | null) => void;
  readonly disabled?: boolean;
}

/** 检测当前是否为 Windows 平台（用于决定是否启用原生目录选择按钮） */
function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Win/i.test(navigator.userAgent);
}

/**
 * 默认工作目录选择器。
 * - Windows：原生「选择目录」按钮（调 api.pickDirectory）+ 清除按钮
 * - 其他平台（macOS/Linux）：原生 API 返回 501，直接显示手工输入
 * - 若 Windows 调用返回 501（异常情况），自动回退到手工输入
 */
export function DirectoryPicker(props: DirectoryPickerProps) {
  const isWindows = isWindowsPlatform();
  // 在非 Windows 或 501 回退后启用手工输入
  const [manualMode, setManualMode] = useState(!isWindows);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePick = async () => {
    setPicking(true);
    setError(null);
    try {
      const result = await props.api.pickDirectory();
      if (result.cancelled) {
        // 用户取消，保持原值不变
        return;
      }
      if (result.path !== null) {
        props.onChange(result.path);
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 501) {
        // 平台不支持原生选择，回退到手工输入
        setManualMode(true);
        return;
      }
      setError(err instanceof Error ? err.message : "选择目录失败");
    } finally {
      setPicking(false);
    }
  };

  const handleClear = () => {
    setError(null);
    props.onChange(null);
  };

  const handleManualChange = (value: string) => {
    const trimmed = value.trim();
    props.onChange(trimmed.length > 0 ? trimmed : null);
  };

  return (
    <div className={styles.root}>
      <div className={styles.pathRow}>
        <span className={styles.pathLabel}>当前目录：</span>
        <span className={styles.pathValue} data-testid="directory-picker-value">
          {props.value ?? "未设置"}
        </span>
      </div>

      <div className={styles.controls}>
        {!manualMode && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handlePick()}
            disabled={props.disabled || picking}
            loading={picking}
            aria-label="选择目录"
          >
            {picking ? "选择中…" : "选择目录"}
          </Button>
        )}

        {manualMode && (
          <TextField
            value={props.value ?? ""}
            onChange={handleManualChange}
            placeholder="输入绝对路径，例如 D:\\projects\\my-agent"
            disabled={props.disabled ?? false}
            aria-label="默认工作目录路径"
            className={styles.manualInput ?? ""}
          />
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={handleClear}
          disabled={props.disabled || props.value === null}
          aria-label="清除目录"
        >
          清除
        </Button>
      </div>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
