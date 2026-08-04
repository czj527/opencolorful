// ═══════════════════════════════════════════════════════════════
// OpenColorful Phase 12 iframe UI SDK 入口（plans/phase-12.md §8.5 / §19.1）
//
// - Surface 类型/接口 + Host request 契约声明；
// - 本阶段只交付类型与文档，真实 iframe 桥（postMessage 宿主/CSP/Session）
//   由后续阶段实现；类型可先用于插件作者与 Web 端集成；
// - 类型依赖 @opencolorful/plugin-sdk（协议贡献类型），不 import Server。
// ═══════════════════════════════════════════════════════════════

export * from "./host.js";
export * from "./ui.js";
