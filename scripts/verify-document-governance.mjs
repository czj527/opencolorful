import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

const root = fileURLToPath(new URL("..", import.meta.url))
const impactPath = resolve(root, "docs/change-impact.json")
const impact = JSON.parse(readFileSync(impactPath, "utf8"))

function git(args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
}

function matches(path, patterns) {
  return patterns.some((pattern) => new RegExp(pattern).test(path))
}

function changedFiles() {
  const base = process.env.BASE_SHA ?? process.env.GITHUB_BASE_SHA
  if (base && !/^0+$/.test(base)) {
    return git(["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`])
      .split(/\r?\n/)
      .filter(Boolean)
  }

  const working = git(["diff", "--name-only", "--diff-filter=ACMR"])
  const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
  const untracked = git(["ls-files", "--others", "--exclude-standard"])
  const local = [...new Set(`${working}\n${staged}\n${untracked}`.split(/\r?\n/).filter(Boolean))]
  if (local.length > 0) return local

  try {
    return git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD^", "HEAD"])
      .split(/\r?\n/)
      .filter(Boolean)
  } catch {
    return []
  }
}

function exemptionReason() {
  if (process.env.DOCS_EXEMPT_REASON?.trim()) return process.env.DOCS_EXEMPT_REASON.trim()

  const eventPath = process.env.GITHUB_EVENT_PATH
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8"))
      const text = `${event.pull_request?.title ?? ""}\n${event.pull_request?.body ?? ""}`
      const match = text.match(/docs-exempt\s*:\s*(.+)/i)
      if (match?.[1]?.trim()) return match[1].trim()

      // A push to main no longer carries the merged PR body. Reuse an explicit
      // head-commit marker only for non-PR events so the post-merge gate remains
      // deterministic without making commit messages a general PR exemption.
      if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
        const headMessage = event.head_commit?.message ?? ""
        const headMatch = headMessage.match(/docs-exempt\s*:\s*(.+)/i)
        if (headMatch?.[1]?.trim()) return headMatch[1].trim()
      }
    } catch {
      // A malformed event payload should not make local checks fail.
    }
  }

  return ""
}

const files = changedFiles()
const documentationFiles = files.filter((file) => matches(file, impact.documentationPaths))
const productionFiles = files.filter((file) => matches(file, impact.productionPaths))
const testOnlyFiles = files.filter((file) => matches(file, impact.testOnlyPaths))
const exemption = exemptionReason()
const exemptionForbiddenFiles = exemption.length > 0
  ? files.filter((file) => matches(file, impact.exemptionForbiddenPaths ?? []))
  : []
const exemptionAllowed = exemption.length > 0 && exemptionForbiddenFiles.length === 0
const errors = []
const warnings = []

for (const path of ["AGENTS.md", "CLAUDE.md", "docs/project-status.md", "docs/document-governance.md", "docs/change-impact.json", "plans/README.md"]) {
  if (!existsSync(resolve(root, path))) errors.push(`缺少治理必需文件：${path}`)
}

if (productionFiles.length > 0 && documentationFiles.length === 0) {
  if (exemptionAllowed) {
    warnings.push(`生产代码变更使用 docs-exempt：${exemption}`)
  } else {
    errors.push([
      "检测到生产代码或构建配置变更，但 diff 没有文档/计划收口。",
      `生产变更：${productionFiles.join(", ")}`,
      "请更新 plans/、docs/、AGENTS.md、README.md、SECURITY.md 或 CHANGELOG.md；",
      "如果确认是纯重构或机械变更，请在 PR 描述中写 docs-exempt: <具体原因>。",
    ].join("\n"))
  }
}

if (exemptionForbiddenFiles.length > 0) {
  errors.push([
    "docs-exempt 不能用于源码、工作区 UI、包配置或其他行为表面变更。",
    `匹配文件：${exemptionForbiddenFiles.join(", ")}`,
    "请补充对应 docs/、plans/、AGENTS.md 或 SECURITY.md 收口；",
    "只有纯测试、文档、脚本或不改变行为的机械变更才可以使用 docs-exempt。",
  ].join("\n"))
}

for (const rule of impact.rules) {
  const affected = files.filter((file) => matches(file, rule.patterns))
  if (affected.length === 0) continue

  const matchedDocs = documentationFiles.filter((file) => matches(file, rule.requiredDocPatterns))
  if (matchedDocs.length === 0) {
    if (exemptionAllowed) {
      warnings.push(`${rule.label}使用 docs-exempt：${exemption}`)
    } else {
      errors.push([
        `变更表面：${rule.label}`,
        `匹配文件：${affected.join(", ")}`,
        `必须同步：${rule.requiredDocPatterns.join(" / ")}`,
        `建议验证：${rule.requiredChecks.join("、")}`,
      ].join("\n"))
    }
  }
}

if (files.length === 0) {
  console.log("Document governance: no changed files detected.")
} else {
  console.log(`Document governance: inspected ${files.length} changed file(s).`)
  if (testOnlyFiles.length > 0 && productionFiles.length === 0) {
    console.log("Test-only changes do not require a documentation update by default.")
  }
}

for (const warning of warnings) console.warn(`WARNING: ${warning}`)
if (errors.length > 0) {
  console.error("\nDocument governance failed:")
  for (const error of errors) console.error(`\n- ${error}`)
  process.exitCode = 1
} else {
  console.log("Document governance passed.")
}
