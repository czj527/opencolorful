import { Modal } from "../../components/Modal.js";
import { Button } from "../../components/ui/Button.js";
import styles from "./ConfirmDiscard.module.css";

export interface ConfirmDiscardProps {
  readonly open: boolean;
  readonly mode: "create" | "edit";
  readonly onStay: () => void;
  readonly onDiscard: () => void;
}

const content = {
  create: {
    title: "放弃创建？",
    body: "已填写的内容将不会保留。",
    confirm: "放弃",
  },
  edit: {
    title: "放弃更改？",
    body: "你有未保存的修改，离开后将丢失。",
    confirm: "放弃更改",
  },
} as const;

export function ConfirmDiscard({ open, mode, onStay, onDiscard }: ConfirmDiscardProps) {
  const { title, body, confirm } = content[mode];

  return (
    <Modal open={open} onClose={onStay} title={title}>
      <div className={styles.content}>
        <p className={styles.body}>{body}</p>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={onDiscard}>
            {confirm}
          </Button>
          <Button variant="primary" onClick={onStay}>
            继续编辑
          </Button>
        </div>
      </div>
    </Modal>
  );
}
