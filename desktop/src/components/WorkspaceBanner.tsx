import { ShieldCheck } from "lucide-react";

/**
 * 工作区确认横幅：会话 toolMode=all 且未确认工作目录时显示。
 * 确认后 Agent 才能写入文件/执行命令；也可降为只读模式跳过确认。
 */
interface WorkspaceBannerProps {
  readonly cwd: string | null;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onReadOnly: () => void;
}

export function WorkspaceBanner({ cwd, busy, onConfirm, onReadOnly }: WorkspaceBannerProps) {
  return (
    <div className="workspace-banner" role="region" aria-label="工作区确认">
      <ShieldCheck size={14} />
      <span className="workspace-banner-copy">
        当前会话可写入工作区，但目录尚未确认：<code>{cwd ?? "（未设置）"}</code>
      </span>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={onConfirm}>确认工作区</button>
      <button type="button" className="btn" disabled={busy} onClick={onReadOnly}>切换为只读</button>
    </div>
  );
}
