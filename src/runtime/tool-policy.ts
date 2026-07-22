import fs from "node:fs";
import path from "node:path";

import type { ToolMode } from "../contracts/session-settings.js";
import { READ_ONLY_TOOLS, ALL_TOOLS } from "../contracts/session-settings.js";

export class ToolPolicy {
  resolveTools(mode: ToolMode, cwd?: string, confirmed?: boolean): string[] {
    switch (mode) {
      case "off":
        return [];
      case "read-only":
        return [...READ_ONLY_TOOLS];
      case "all":
        this.validateAllMode(cwd, confirmed);
        return [...ALL_TOOLS];
      default:
        throw new Error(`未知工具模式: ${mode}`);
    }
  }

  shouldDisableAllTools(mode: ToolMode): boolean {
    return mode === "off";
  }

  private validateAllMode(cwd: string | undefined, confirmed: boolean | undefined): void {
    if (!confirmed) {
      throw new Error("all 模式必须先在工作区设置中确认");
    }
    if (!cwd || cwd.trim() === "") {
      throw new Error("all 模式需要指定工作目录");
    }

    const resolved = path.resolve(cwd);
    if (resolved.includes("..")) {
      throw new Error("工作目录不允许包含 .. 路径");
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`工作目录不存在: ${resolved}`);
    }

    try {
      fs.accessSync(resolved, fs.constants.R_OK);
    } catch {
      throw new Error(`工作目录不可读取: ${resolved}`);
    }
  }
}
