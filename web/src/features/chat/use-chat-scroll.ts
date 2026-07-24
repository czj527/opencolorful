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

export interface UseChatScrollResult {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly isAtBottom: boolean;
  readonly hasUnread: boolean;
  readonly scrollToLatest: () => void;
  readonly markRecovered: () => void;
  readonly autoScrollIfAtBottom: () => void;
}

export function useChatScroll(reducedMotion: boolean): UseChatScrollResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasUnread, setHasUnread] = useState(false);
  const userScrolledRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      const atBottom = shouldAutoScroll(el.scrollHeight, el.scrollTop, el.clientHeight);
      setIsAtBottom(atBottom);
      if (!atBottom && userScrolledRef.current) {
        setHasUnread(true);
      }
    };

    const onScroll = () => {
      userScrolledRef.current = true;
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
    if (!el || !isAtBottom) return;
    el.scrollTo({ top: el.scrollHeight, behavior: getScrollBehavior(reducedMotion) });
  }, [isAtBottom, reducedMotion]);

  const scrollToLatest = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: getScrollBehavior(reducedMotion) });
    setHasUnread(false);
    userScrolledRef.current = false;
    setIsAtBottom(true);
  }, [reducedMotion]);

  const markRecovered = useCallback(() => {
    // 让连接恢复状态在外部管理，这里不需要额外动作
  }, []);

  return {
    containerRef,
    isAtBottom,
    hasUnread,
    scrollToLatest,
    markRecovered,
    autoScrollIfAtBottom,
  };
}