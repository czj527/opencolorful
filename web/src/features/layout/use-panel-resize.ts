import { useCallback, useEffect, useRef } from "react";

export interface PanelResizeOptions {
  readonly side: "left" | "right";
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly currentWidth: number;
  readonly onResize: (width: number) => void;
  readonly onResizeEnd?: (width: number) => void;
  readonly disabled?: boolean;
}

/**
 * 使用 Pointer Events 实现可拖拽调整面板宽度。
 * 拖拽期间添加全屏透明 shield 防止选中文本和跨 iframe 事件。
 * 宽度 clamp 在 min/max 之间，拖拽结束后触发一次性的 onResizeEnd 回调（用于防抖持久化）。
 */
export function usePanelResize(ref: React.RefObject<HTMLElement | null>, options: PanelResizeOptions) {
  const draggingRef = useRef(false);
  const startWidthRef = useRef(0);
  const startXRef = useRef(0);
  const shieldRef = useRef<HTMLDivElement | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const removeGlobalShield = useCallback(() => {
    if (shieldRef.current) {
      document.body.removeChild(shieldRef.current);
      shieldRef.current = null;
    }
  }, []);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!draggingRef.current) return;
    const delta = e.clientX - startXRef.current;
    const next = Math.round(startWidthRef.current + delta);
    const opts = optionsRef.current;
    const clamped = Math.min(opts.maxWidth, Math.max(opts.minWidth, next));
    opts.onResize(clamped);
  }, []);

  const onPointerUp = useCallback((e: PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    removeGlobalShield();
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    const delta = e.clientX - startXRef.current;
    const next = Math.round(startWidthRef.current + delta);
    const opts = optionsRef.current;
    const clamped = Math.min(opts.maxWidth, Math.max(opts.minWidth, next));
    opts.onResizeEnd?.(clamped);
  }, [onPointerMove, removeGlobalShield]);

  const onPointerDown = useCallback((e: React.MouseEvent) => {
    if (optionsRef.current.disabled) return;
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = optionsRef.current.currentWidth;

    // 全屏透明 shield 防止文本选中和跨 iframe 事件
    const shield = document.createElement("div");
    shield.style.position = "fixed";
    shield.style.inset = "0";
    shield.style.zIndex = "99999";
    shield.style.cursor = "col-resize";
    shield.style.userSelect = "none";
    shield.setAttribute("aria-hidden", "true");
    document.body.appendChild(shield);
    (shield as HTMLElement).setPointerCapture((e.nativeEvent as PointerEvent).pointerId);
    shieldRef.current = shield;

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }, [onPointerMove, onPointerUp]);

  useEffect(() => {
    return () => {
      draggingRef.current = false;
      removeGlobalShield();
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, [onPointerMove, onPointerUp, removeGlobalShield]);

  return {
    resizeHandleProps: {
      onPointerDown,
      role: "separator" as const,
      "aria-orientation": "vertical" as const,
      "aria-valuemin": options.minWidth,
      "aria-valuemax": options.maxWidth,
      "aria-valuenow": options.currentWidth,
      tabIndex: 0,
    },
  };
}