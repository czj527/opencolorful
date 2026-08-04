// ═══════════════════════════════════════════════════════════════
// SDK Showcase — 最小 Node worker 示例（@opencolorful/plugin-runtime）
//
// 本文件是"如何把 bundle 插件升级为 node-process 代码插件"的参考示例：
// 1) 把 manifest.json 的 runtime 改为
//      { "kind": "node-process", "entry": "node-worker/index.js" }
//    并声明 trust: "full-access"（代码运行时要求）；
// 2) worker 通过 JSON-RPC/stdio 与 Host（T4 NodeRuntime）握手；
// 3) 注册的方法与 tool contribution id 一一对应；
// 4) 本示例不依赖任何付费外部服务。
//
// 说明：当前 sdk-showcase 的 manifest 是 bundle 级（纯声明式），
// 本文件只作为代码插件开发的参考骨架，不会被 bundle 运行时加载。
// ═══════════════════════════════════════════════════════════════

import { createRuntimeServer } from "@opencolorful/plugin-runtime";

const server = createRuntimeServer({});

// echo 工具 handler：参数 + 平台注入上下文（carrier/取消信号）。
server.registerMethod("echo", (params) => {
  const text =
    typeof params === "object" && params !== null && "text" in params
      ? String((params as { text: unknown }).text)
      : "";
  return { echoed: text };
});

// 高风险工具示例：真实实现必须经 Phase 9 Sandbox 的 PathGuard 后再操作。
server.registerMethod("delete-file", async (params, ctx) => {
  if (typeof params !== "object" || params === null || typeof (params as { path?: unknown }).path !== "string") {
    throw new Error("path 必须是字符串");
  }
  const path = (params as { path: string }).path;
  // 占位实现：这里不真正删除文件，只返回元数据（避免示例造成破坏）。
  // 实际实现应调用 Host Broker 白名单 API 或经 SandboxBridge 校验后操作。
  return { requestedPath: path, deleted: false, reason: "示例不执行真实删除" };
});

// 启动握手：Host 的 NodeRuntime 校验 protocolVersion 后进入 running。
server.start().catch((error) => {
  console.error("worker 启动失败", error);
  process.exit(1);
});
