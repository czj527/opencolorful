import { useCallback, useEffect, useState } from "react";

import type { DesktopDataSource } from "./data/source.js";

export type FirstRunStatus = "loading" | "first-run" | "ready";

/**
 * 首启检测（T0）：无可用 Agent，或没有任何已配置凭据的 Provider，即视为首次使用。
 * 状态派生自真实后端数据，不持久化"已完成引导"标记——引导完成后该状态自然消失。
 * 探测失败时放行到 ready：宁可不显示引导，也不阻塞正常界面。
 */
export function useFirstRun(source: DesktopDataSource | null): {
  readonly status: FirstRunStatus;
  /** 引导完成（建好助理 / 配好凭据）后调用，重新评估首启状态 */
  readonly refresh: () => void;
} {
  const [status, setStatus] = useState<FirstRunStatus>("loading");
  const [round, setRound] = useState(0);
  const refresh = useCallback(() => setRound((value) => value + 1), []);

  useEffect(() => {
    if (source === null) {
      setStatus("loading");
      return;
    }
    let cancelled = false;
    Promise.all([source.listAgents(), source.listProviders()])
      .then(([agents, providers]) => {
        if (cancelled) return;
        const hasAgent = agents.length > 0;
        const hasCredential = providers.some((provider) => provider.credentialConfigured);
        setStatus(hasAgent && hasCredential ? "ready" : "first-run");
      })
      .catch(() => {
        if (!cancelled) setStatus("ready");
      });
    return () => {
      cancelled = true;
    };
  }, [source, round]);

  return { status, refresh };
}
