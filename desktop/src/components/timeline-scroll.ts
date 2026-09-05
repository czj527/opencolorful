import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 波次 B3：当前分支 timeline 的锚点滚动（Desktop 原生实现）。
 * 交互语义参考 web/src/features/chat/use-chat-scroll.ts（视口锚点同步 + 点击高亮），
 * 差异：滚动容器是 App 壳的 .chat-scroll（ChatView 渲染在其内部），经惰性查询绑定；
 * 高亮用短暂 class 而非持久状态。
 */

/** 判断视口是否接近容器底部（阈值 48px；对齐 web shouldAutoScroll） */
function isAtBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  if (scrollHeight <= clientHeight) return true;
  return scrollHeight - scrollTop - clientHeight < 48;
}

export interface TimelineAnchorScroll {
  /** 当前视口顶部所在轮次（turn-<userEntryId>）；null = 无可判定锚点 */
  readonly activeTurnId: string | null;
  /** 平滑滚动到锚点并短暂高亮；锚点不存在时静默（条目可能已被重载替换） */
  readonly scrollToAnchor: (turnId: string) => void;
  /** 滚到底部（分支切换后展示新分支叶） */
  readonly scrollToBottom: () => void;
}

export function useTimelineAnchorScroll(): TimelineAnchorScroll {
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const activeTurnRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const containerOf = useCallback((): HTMLElement | null => document.querySelector(".chat-scroll"), []);

  useEffect(() => {
    const container = containerOf();
    if (container === null) return;
    const update = () => {
      const rect = container.getBoundingClientRect();
      let current: string | null = null;
      for (const anchor of container.querySelectorAll<HTMLElement>("[data-anchor]")) {
        if (anchor.getBoundingClientRect().top <= rect.top + rect.height * 0.4) {
          current = anchor.dataset["anchor"] ?? null;
        } else {
          break;
        }
      }
      if (current !== activeTurnRef.current) {
        activeTurnRef.current = current;
        setActiveTurnId(current);
      }
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    return () => container.removeEventListener("scroll", update);
  }, [containerOf]);

  useEffect(() => () => {
    if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current);
  }, []);

  const scrollToAnchor = useCallback((turnId: string) => {
    const container = containerOf();
    const target = container?.querySelector<HTMLElement>(`[data-anchor="${turnId}"]`) ?? null;
    if (container === null || target === null) return;
    if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current);
    container.querySelectorAll(".anchor-highlight").forEach((node) => node.classList.remove("anchor-highlight"));
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("anchor-highlight");
    highlightTimerRef.current = setTimeout(() => {
      target.classList.remove("anchor-highlight");
      highlightTimerRef.current = null;
    }, 1200);
  }, [containerOf]);

  const scrollToBottom = useCallback(() => {
    const container = containerOf();
    if (container === null) return;
    if (!isAtBottom(container.scrollHeight, container.scrollTop, container.clientHeight)) {
      container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    }
  }, [containerOf]);

  return { activeTurnId, scrollToAnchor, scrollToBottom };
}
