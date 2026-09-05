import { ChevronDown, GitBranch, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BranchStateUpdate, BranchTreeView, DesktopDataSource } from "../data/source.js";
import "./BranchSwitcher.css";

/** 分支操作错误的最小分态信息（稳定错误码来自 B0 §3.4 冻结矩阵） */
export interface BranchActionError {
  readonly message: string;
  readonly code: string | null;
}

/** 从任意异常提取稳定错误码（IpcDataSource.BranchOperationError / MockBranchError 同形） */
export function branchErrorCodeOf(cause: unknown): string | null {
  if (cause !== null && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

function formatBranchTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then) || iso === "") return "";
  const diffMin = Math.floor((Date.now() - then) / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  return `${Math.floor(diffDay / 30)} 个月前`;
}

interface BranchSwitcherProps {
  readonly source: DesktopDataSource;
  readonly sessionId: string;
  /** 流式中：分支操作预期 409（提示态；真实分态以服务端错误为准） */
  readonly running: boolean;
  /** Fork 完成后导航到新会话（App 负责切会话与刷新列表） */
  readonly onForked: (newSessionId: string) => void;
}

/**
 * 波次 B3：分支切换器（chat-head 弹出层，两视图分离——这里只列分支与切换，
 * 线性 timeline 由 ChatView 单独承载）。加载/空/错误/运行中四态齐备；
 * 409 SESSION_BUSY 错误附「停止」动作（沿用既有 abort 流，不自动中止）。
 */
export function BranchSwitcher({ source, sessionId, running, onForked }: BranchSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [tree, setTree] = useState<BranchTreeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<BranchActionError | null>(null);
  const [switching, setSwitching] = useState(false);
  const [forking, setForking] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refreshTree = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    source.getBranchTree(sessionId)
      .then((next) => {
        setTree(next);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        setLoadError(cause instanceof Error ? cause.message : "分支树加载失败");
        setLoading(false);
      });
  }, [source, sessionId]);

  // 挂载/换会话：拉取分支树 + 订阅分支状态事件（branches.changed → 树刷新）
  useEffect(() => {
    setTree(null);
    setActionError(null);
    setOpen(false);
    refreshTree();
    const unsubscribe = source.subscribeBranchState?.(sessionId, (update: BranchStateUpdate | null) => {
      if (update !== null && update.kind === "branchesChanged") refreshTree();
    });
    return unsubscribe;
  }, [source, sessionId, refreshTree]);

  // 点击弹层外部关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const currentCount = tree?.branches.length ?? 0;

  async function handleSwitch(branchId: string): Promise<void> {
    if (switching) return;
    setSwitching(true);
    setActionError(null);
    try {
      await source.switchBranch(sessionId, branchId);
      setOpen(false);
    } catch (cause) {
      setActionError({ message: cause instanceof Error ? cause.message : "分支切换失败", code: branchErrorCodeOf(cause) });
    } finally {
      setSwitching(false);
    }
  }

  async function handleFork(): Promise<void> {
    if (forking) return;
    setForking(true);
    setActionError(null);
    try {
      const newSessionId = await source.forkSession(sessionId);
      setOpen(false);
      onForked(newSessionId);
    } catch (cause) {
      setActionError({ message: cause instanceof Error ? cause.message : "Fork 失败", code: branchErrorCodeOf(cause) });
    } finally {
      setForking(false);
    }
  }

  function handleStop(): void {
    // 409 分态动作：显式停止（沿用既有 abort 流），不自动中止
    void source.abort(sessionId).then(() => setActionError(null)).catch(() => undefined);
  }

  const busy = switching || forking;
  const triggerLabel = useMemo(() => {
    if (loading && tree === null) return "分支…";
    if (loadError !== null) return "分支!";
    if (tree === null || currentCount === 0) return "分支";
    return `分支 ${currentCount}`;
  }, [loading, tree, loadError, currentCount]);

  return (
    <div className="branch-switcher" ref={rootRef}>
      <button
        type="button"
        className={`branch-switcher-trigger${loadError !== null ? " is-error" : ""}`}
        data-testid="oc-branch-switcher"
        aria-expanded={open}
        aria-label="分支切换"
        title={running ? "会话运行中：分支操作需先停止" : "查看与切换分支"}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) refreshTree();
        }}
      >
        <GitBranch size={13} aria-hidden="true" />
        <span>{triggerLabel}</span>
        <ChevronDown size={12} className={open ? "is-rotated" : ""} aria-hidden="true" />
      </button>
      {open && (
        <div className="branch-menu" data-testid="oc-branch-menu" role="menu">
          <div className="branch-menu-head">
            <span>分支历史</span>
            <button
              type="button"
              className="icon-btn branch-refresh"
              data-testid="oc-branch-refresh"
              aria-label="刷新分支"
              onClick={refreshTree}
            >
              <Loader2 size={12} className={loading ? "is-spinning" : undefined} aria-hidden="true" />
            </button>
          </div>
          {loadError !== null && (
            <div className="branch-state" data-testid="oc-branch-error">
              <span>{loadError}</span>
              <button type="button" className="inline-action" onClick={refreshTree}>刷新</button>
            </div>
          )}
          {loadError === null && loading && tree === null && (
            <div className="branch-state" data-testid="oc-branch-loading"><span>正在加载分支…</span></div>
          )}
          {loadError === null && tree !== null && currentCount === 0 && (
            <div className="branch-state" data-testid="oc-branch-empty">
              <span>暂无分支记录。编辑并重生成或重试后会形成新分支。</span>
            </div>
          )}
          {tree !== null && tree.branches.map((branch) => (
            <button
              key={branch.branchId}
              type="button"
              role="menuitem"
              className={`branch-item${branch.isCurrent ? " is-current" : ""}`}
              data-testid={`oc-branch-item-${branch.branchId}`}
              disabled={busy}
              onClick={() => void handleSwitch(branch.branchId)}
            >
              <span className="branch-item-preview">{branch.leafPreview || "（空分支）"}</span>
              <span className="branch-item-meta">
                <span>{formatBranchTime(branch.updatedAt)}</span>
                <span>{branch.entryCount} 条</span>
                {branch.isCurrent && <span className="branch-item-current">当前</span>}
              </span>
            </button>
          ))}
          {running && (
            <div className="branch-state branch-state-muted" data-testid="oc-branch-running">
              <span>会话运行中，分支操作需先停止当前轮次。</span>
            </div>
          )}
          {actionError !== null && (
            <div className="branch-state branch-state-error" data-testid="oc-branch-action-error" role="alert">
              <span>{actionError.message}</span>
              <span className="branch-state-actions">
                {actionError.code === "SESSION_BUSY" && (
                  <button type="button" className="inline-action" data-testid="oc-branch-stop" onClick={handleStop}>停止</button>
                )}
                {actionError.code === "NOT_FOUND" && (
                  <button type="button" className="inline-action" onClick={refreshTree}>刷新</button>
                )}
                <button type="button" className="inline-action" onClick={() => setActionError(null)}>知道了</button>
              </span>
            </div>
          )}
          <button
            type="button"
            className="branch-fork"
            data-testid="oc-fork-button"
            disabled={busy || currentCount === 0}
            onClick={() => void handleFork()}
          >
            {forking ? "Fork 中…" : "Fork 成独立会话"}
          </button>
        </div>
      )}
    </div>
  );
}
