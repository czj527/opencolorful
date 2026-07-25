import type { ReactNode } from "react";
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
  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
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
