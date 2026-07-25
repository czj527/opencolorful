import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 判断用户是否接近消息列表底部（阈值 48px）。
 * 当 scrollHeight <= clientHeight 时视为已在底部。
 */
export function shouldAutoScroll(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): boolean {
  if (scrollHeight <= clientHeight) return true;
  return scrollHeight - scrollTop - clientHeight < 48;
}

export function getScrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? "instant" : "smooth";
}

export function nextUnreadState(
  isAtBottom: boolean,
  contentChanged: boolean,
  currentUnread: boolean,
): boolean {
  if (isAtBottom) return false;
  return contentChanged ? true : currentUnread;
}

export interface UseChatScrollResult {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly isAtBottom: boolean;
  readonly hasUnread: boolean;
  readonly scrollToLatest: () => void;
  readonly markRecovered: () => void;
  readonly autoScrollIfAtBottom: () => void;
  /** 平滑滚动到指定锚点元素并短暂高亮 */
  readonly scrollToAnchor: (anchorId: string) => void;
  /** 当前视口所在轮次的锚点 id（滚动监听同步） */
  readonly activeAnchor: string | null;
}

export function useChatScroll(reducedMotion: boolean): UseChatScrollResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasUnread, setHasUnread] = useState(false);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const isAtBottomRef = useRef(true);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      const atBottom = shouldAutoScroll(el.scrollHeight, el.scrollTop, el.clientHeight);
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
      setHasUnread((current) => nextUnreadState(atBottom, false, current));

      // 视口同步：找到当前视口顶部附近的轮次锚点
      const containerRect = el.getBoundingClientRect();
      const anchors = el.querySelectorAll<HTMLElement>("[data-anchor]");
      let current: string | null = null;
      for (const anchor of anchors) {
        const rect = anchor.getBoundingClientRect();
        // 锚点在视口上半部分或刚好在顶部之上
        if (rect.top <= containerRect.top + containerRect.height * 0.4) {
          current = anchor.dataset.anchor ?? null;
        } else {
          break;
        }
      }
      setActiveAnchor(current);
    };

    const onScroll = () => {
      update();
    };

    // 初始化
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 每次 messages 变化后触发一次自动滚动
  const autoScrollIfAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!isAtBottomRef.current) {
      setHasUnread((current) => nextUnreadState(false, true, current));
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: getScrollBehavior(reducedMotion) });
  }, [reducedMotion]);

  const scrollToLatest = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: getScrollBehavior(reducedMotion) });
    setHasUnread(false);
    isAtBottomRef.current = true;
    setIsAtBottom(true);
  }, [reducedMotion]);

  const markRecovered = useCallback(() => {
    // 让连接恢复状态在外部管理，这里不需要额外动作
  }, []);

  const scrollToAnchor = useCallback((anchorId: string) => {
    const el = containerRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(`[data-anchor="${anchorId}"]`);
    if (!target) return;

    // 清除上一个高亮定时器
    if (highlightTimerRef.current !== null) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    // 移除已有高亮
    el.querySelectorAll(".anchor-highlight").forEach((node) => {
      node.classList.remove("anchor-highlight");
    });

    target.scrollIntoView({ behavior: getScrollBehavior(reducedMotion), block: "start" });
    target.classList.add("anchor-highlight");

    highlightTimerRef.current = setTimeout(() => {
      target.classList.remove("anchor-highlight");
      highlightTimerRef.current = null;
    }, 1200);
  }, [reducedMotion]);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  return {
    containerRef,
    isAtBottom,
    hasUnread,
    scrollToLatest,
    markRecovered,
    autoScrollIfAtBottom,
    scrollToAnchor,
    activeAnchor,
  };
}
