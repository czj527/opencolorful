// ═══════════════════════════════════════════════════════════════
// Phase 12 Plugin Protocol（plans/phase-12.md §19.1）
//
// 唯一权威协议包：Server / Web / worker / 插件 SDK 全部消费这里导出的类型。
// 本包不得 import Server 内部实现（import boundary 由
// scripts/verify-plugin-imports.mjs 强制）。
// ═══════════════════════════════════════════════════════════════

export * from "./manifest.js";
export * from "./contribution.js";
export * from "./permission.js";
export * from "./compatibility.js";
export * from "./normalized.js";
export * from "./snapshot.js";
export * from "./ipc.js";
