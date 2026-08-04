// ═══════════════════════════════════════════════════════════════
// OpenColorful Phase 12 插件开发者 SDK（plans/phase-12.md §15 / §19.1）
//
// - 协议类型全部从 @opencolorful/plugin-protocol 原样 re-export，不复制；
// - 本包提供 Server/Tool/Route 开发辅助（definePlugin 等）与脚手架
//   （createPlugin）；独立 import boundary，不 import Server 内部实现；
// - 插件作者通常只 import 本包入口即可获得完整 Manifest/Contribution 类型。
// ═══════════════════════════════════════════════════════════════

export * from "@opencolorful/plugin-protocol";
export * from "./errors.js";
export * from "./define.js";
export * from "./scaffold.js";
