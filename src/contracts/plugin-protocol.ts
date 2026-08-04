// Phase 12：协议类型唯一出口（消费 @opencolorful/plugin-protocol 包）。
// Server 内部实现一律 import 本文件，不直接散落 import 协议包路径。
export * from "@opencolorful/plugin-protocol";
