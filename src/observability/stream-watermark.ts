import type Database from "better-sqlite3";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T6：SSE 高水位交接（plans/phase-11.md §5.7 / §十）
//
// 查询/实时交接使用数据库高水位：operator SSE 重连时客户端回传
// Last-Event-ID（表 id），服务端从该 id 之后补发（不重不漏，允许 gap——
// retention 删除的行直接跳过）；无 Last-Event-ID 时从当前水位开始
// 只发新行（不回放历史）。
// ═══════════════════════════════════════════════════════════════

export type StreamChannel = "activity" | "audit";

function keyOf(channel: StreamChannel): string {
  return `observability.high_watermark.${channel}`;
}

export function getStreamWatermark(database: Database.Database, channel: StreamChannel): number {
  const row = database
    .prepare("SELECT value FROM observability_state WHERE key = ?")
    .get(keyOf(channel)) as { value: string } | undefined;
  if (row === undefined) return 0;
  const value = Number(row.value);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function setStreamWatermark(database: Database.Database, channel: StreamChannel, id: number): void {
  if (!Number.isFinite(id) || id < 0) return;
  database
    .prepare("INSERT OR REPLACE INTO observability_state (key, value) VALUES (?, ?)")
    .run(keyOf(channel), String(Math.floor(id)));
}
