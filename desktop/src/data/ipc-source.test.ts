import { expect, it } from "vitest";

import { correlationForPath } from "./ipc-source.js";

it("A5: 会话接口失败优先保留主进程 diagRef，不被 sessionId 覆盖", () => {
  const correlation = correlationForPath("/api/sessions/session-a/settings", "ipc-a5-failure");

  expect(correlation).toMatchObject({
    traceId: "ipc-a5-failure",
    origin: "local",
  });
  expect(Number.isNaN(Date.parse(correlation.at))).toBe(false);
});

it("A5: 无 diagRef 的会话失败才回退服务端 sessionId", () => {
  expect(correlationForPath("/api/sessions/session-a/settings", undefined)).toMatchObject({
    traceId: "session-a",
    origin: "server",
  });
});

it("A5: 非会话失败保留 diagRef，无 diagRef 时才生成本地 UUID", () => {
  expect(correlationForPath("/api/observability/activity?traceId=session-a", "ipc-a5-activity-failure")).toMatchObject({
    traceId: "ipc-a5-activity-failure",
    origin: "local",
  });

  const fallback = correlationForPath("/api/observability/activity", undefined);
  expect(fallback.origin).toBe("local");
  expect(fallback.traceId).toMatch(/^[0-9a-f-]{36}$/);
});
