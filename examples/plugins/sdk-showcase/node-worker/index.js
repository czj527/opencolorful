// ═══════════════════════════════════════════════════════════════
// SDK Showcase — 最小 Node worker 示例（@opencolorful/plugin-runtime）
//
// 本文件是 node-process 代码插件的最小运行示例（纯 JS，Node 直接执行）：
// 1) manifest.json 声明 runtime { "kind": "node-process", "entry": "node-worker/index.js" }
//    与 trust: "full-access"（代码运行时要求）；
// 2) worker 通过 JSON-RPC/stdio 与 Host（T4 NodeRuntime）握手；
// 3) 注册的方法与 tool contribution id 一一对应；
// 4) 本示例不依赖任何付费外部服务。
// ═══════════════════════════════════════════════════════════════

import { createRuntimeServer } from "@opencolorful/plugin-runtime";

const server = createRuntimeServer({});

// echo 工具 handler：参数 + 平台注入上下文（carrier/取消信号）。
server.registerMethod("echo", (params) => {
  const text =
    typeof params === "object" && params !== null && "text" in params
      ? String(params.text)
      : "";
  return { echoed: text };
});

// 高风险工具示例：真实实现必须经 Phase 9 Sandbox 的 PathGuard 后再操作。
server.registerMethod("delete-file", async (params) => {
  if (typeof params !== "object" || params === null || typeof params.path !== "string") {
    throw new Error("path 必须是字符串");
  }
  // 占位实现：这里不真正删除文件，只返回元数据（避免示例造成破坏）。
  // 实际实现应调用 Host Broker 白名单 API 或经 SandboxBridge 校验后操作。
  return { requestedPath: params.path, deleted: false, reason: "示例不执行真实删除" };
});

// 启动握手：Host 的 NodeRuntime 校验 protocolVersion 后进入 running。
server.start().catch((error) => {
  console.error("worker 启动失败", error);
  process.exit(1);
});
