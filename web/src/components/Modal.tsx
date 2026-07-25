import { type ReactNode, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { IconButton } from "./ui/IconButton.js";
import styles from "./Modal.module.css";

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
}

// 引用 module 以确保样式被打包；类名以 :global 暴露在 Modal.module.css。
void styles;

export function Modal({ open, onClose, title, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // 打开时聚焦对话框，Escape 关闭，Tab 在对话框内循环（焦点陷阱）
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    dialog?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || dialog === null) return;

      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <IconButton icon={<X size={14} aria-hidden="true" />} label="关闭" onClick={onClose} className="modal-close" />
        </div>
        <div className="modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}
