import fs from "node:fs";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 Workspace/兼容目录根（plans/phase-13.md §8.1）
//
// 默认兼容目录（全部默认关闭，只有用户显式信任后才扫描）：
//   <cwd>/.agents/skills、<cwd>/.claude/skills、<cwd>/.codex/skills、
//   <cwd>/.openclaw/skills、~/.agents/skills、~/.claude/skills、
//   ~/.codex/skills、~/.openclaw/skills
// ═══════════════════════════════════════════════════════════════

export function workspaceCompatibilityRoots(cwd: string, home: string): readonly string[] {
  const candidates = [
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".codex", "skills"),
    path.join(cwd, ".openclaw", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".openclaw", "skills"),
  ];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    try {
      const stat = fs.lstatSync(resolved);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        roots.push(resolved);
      }
    } catch {
      // 目录不存在 → 跳过（信任决策由 trust policy 控制）
    }
  }
  return roots;
}
