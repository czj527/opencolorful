// ═══════════════════════════════════════════════════════════════
// OpenColorful Phase 12 worker 侧 Runtime SDK 入口（plans/phase-12.md §9.2 / §19.1）
//
// - 协议类型从 @opencolorful/plugin-protocol re-export；
// - 提供与 T4 node-runtime 配对的 worker 侧 JSON-RPC 服务端骨架
//   （PluginRuntimeServer / createRuntimeServer）；
// - 独立 import boundary，不 import Server 内部实现。
// ═══════════════════════════════════════════════════════════════

export * from "@opencolorful/plugin-protocol";
export * from "./server.js";
