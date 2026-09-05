import { expect } from "vitest";

/**
 * console.error 追踪（A2 验收：真实点击/输入后断言 console 无错误）。
 *
 * 用例开头 trackConsoleErrors()，结尾 expectNoErrors()（内部先恢复再断言）；
 * 失败路径由 finally restore() 兜底。只拦 error 级别——warn 不在此契约内。
 */
export interface ConsoleTracker {
  readonly errors: readonly string[];
  restore(): void;
  expectNoErrors(): void;
}

export function trackConsoleErrors(): ConsoleTracker {
  const errors: string[] = [];
  const originalError = console.error;
  const restore = () => {
    console.error = originalError;
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((item) => (typeof item === "string" ? item : String(item))).join(" "));
  };
  return {
    errors,
    restore,
    expectNoErrors() {
      const snapshot = [...errors];
      restore();
      expect(snapshot).toEqual([]);
    },
  };
}
