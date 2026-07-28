import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import type { FolderPicker } from "../../platform/folder-picker.js";

/**
 * 原生目录选择路由。Windows 调 FolderBrowserDialog，
 * macOS/Linux 返回 501 NOT_IMPLEMENTED，前端回退手工输入。
 */
export function registerDirectoryRoutes(app: Hono, picker: FolderPicker): void {
  app.post("/api/directories/pick", async (context) => {
    try {
      const result = await picker.pickDirectory();
      return context.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "目录选择失败";
      // 平台不支持返回 501，前端据此回退手工输入
      if (msg.includes("暂不支持")) {
        return context.json(createApiError("NOT_IMPLEMENTED", msg, false), 501);
      }
      return context.json(createApiError("INTERNAL_ERROR", msg), 500);
    }
  });
}
