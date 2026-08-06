import { defineConfig } from "vitest/config";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T9 可选 live 测试配置（plans/phase-13.md §18.7）
//
// - 只被 `npm run test:skills-live` 使用；默认 `vitest run` 的 include
//   是 tests/**/*.test.ts，tests/skills-live 下是 *.live.ts，不会被加载；
// - env 注入 OPENCOLORFUL_LIVE=1：即使被直接以本配置运行，live 测试
//   才真正执行（测试文件内还有 skipIf 双保险）；
// - 网络失败只输出诊断，不污染默认质量门。
// ═══════════════════════════════════════════════════════════════

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/skills-live/**/*.live.ts"],
    env: { OPENCOLORFUL_LIVE: "1" },
    fileParallelism: false,
  },
});
