// scripts/verify-plugin-imports.mjs 的类型声明（NodeNext 下供 tests/ 直接 import）。
// 实现见同目录 verify-plugin-imports.mjs。

/**
 * 扫描插件包源码的违规 import。
 * @param projectRoot 仓库根目录
 * @returns 违规描述列表（空 = 通过）
 */
export declare function findPluginImportViolations(projectRoot: string): string[];
