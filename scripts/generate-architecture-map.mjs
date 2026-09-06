import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, "..")
const mapDir = path.join(root, "docs", "architecture-map")
const manifestPath = path.join(mapDir, "architecture.manifest.json")
const localePath = path.join(mapDir, "architecture.zh-CN.json")
const projectBoardPath = path.join(mapDir, "project-board.json")
const generatedPath = path.join(mapDir, "architecture.generated.js")

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  "release",
  "build",
  ".git",
  ".vite",
  "coverage",
  "test-artifacts",
  "test-results",
])

const normalize = (value) => value.split(path.sep).join("/")
const relative = (absolutePath) => normalize(path.relative(root, absolutePath))

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"))
}

function readLocale() {
  return JSON.parse(readFileSync(localePath, "utf8"))
}

function readProjectBoard() {
  return JSON.parse(readFileSync(projectBoardPath, "utf8"))
}

function walk(directory) {
  const files = []
  if (!existsSync(directory)) return files

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(absolutePath))
      continue
    }
    if (sourceExtensions.has(path.extname(entry.name).toLowerCase())) files.push(absolutePath)
  }

  return files
}

function isSourceFile(relativePath) {
  if (!sourceExtensions.has(path.extname(relativePath).toLowerCase())) return false
  if (/(^|\/)(tests?|test-artifacts|test-results)\//.test(relativePath)) return false
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)) return false
  if (relativePath.startsWith("src/")) return true
  if (relativePath.startsWith("packages/") && relativePath.includes("/src/")) return true
  if (relativePath.startsWith("desktop/src/")) return true
  if (relativePath.startsWith("desktop/electron/")) return true
  if (relativePath.startsWith("desktop/scripts/")) return true
  if (relativePath.startsWith("web/src/")) return true
  if (relativePath.startsWith("scripts/")) return true
  return false
}

function pathMatchesRoot(filePath, rootPattern) {
  const normalized = normalize(filePath)
  if (rootPattern.endsWith("/")) return normalized.startsWith(rootPattern)
  return normalized === rootPattern || normalized.startsWith(`${rootPattern}/`)
}

function findNodeForFile(filePath, nodes) {
  const matches = nodes
    .flatMap((node) => (node.roots ?? []).filter((rootPattern) => pathMatchesRoot(filePath, rootPattern)).map((rootPattern) => ({
      node,
      specificity: rootPattern.length,
    })))
    .sort((left, right) => right.specificity - left.specificity)
  return matches[0]?.node ?? null
}

function lineCount(absolutePath) {
  return readFileSync(absolutePath, "utf8").split(/\r?\n/).length
}

function sourceFilesForNode(node, allFiles, nodes) {
  return allFiles
    .filter((file) => findNodeForFile(relative(file), nodes)?.id === node.id)
    .map((file) => ({
      path: relative(file),
      lines: lineCount(file),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function resolveRelativeImport(importer, specifier) {
  const importerDirectory = path.dirname(importer)
  const raw = path.resolve(importerDirectory, specifier)
  const candidates = [
    raw,
    raw.replace(/\.js$/, ".ts"),
    raw.replace(/\.js$/, ".tsx"),
    raw.replace(/\.mjs$/, ".ts"),
    raw.replace(/\.cjs$/, ".ts"),
    `${raw}.ts`,
    `${raw}.tsx`,
    `${raw}.js`,
    path.join(raw, "index.ts"),
    path.join(raw, "index.tsx"),
    path.join(raw, "index.js"),
  ]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
}

function extractImportSpecifiers(source) {
  const specifiers = new Set()
  const staticImportPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g
  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g

  for (const pattern of [staticImportPattern, dynamicImportPattern]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1])
    }
  }

  return [...specifiers]
}

function workspacePackageNode(specifier, nodes) {
  if (!specifier.startsWith("@opencolorful/")) return null
  return nodes.find((node) => (node.packageNames ?? [node.packageName]).includes(specifier)) ?? null
}

function collectObservedEdges(allFiles, nodes) {
  const fileToNode = new Map()
  for (const file of allFiles) {
    const node = findNodeForFile(relative(file), nodes)
    if (node) fileToNode.set(file, node)
  }

  const edgeMap = new Map()
  for (const importer of allFiles) {
    const from = fileToNode.get(importer)
    if (!from) continue
    const source = readFileSync(importer, "utf8")
    for (const specifier of extractImportSpecifiers(source)) {
      let target = null
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeImport(importer, specifier)
        target = resolved ? fileToNode.get(resolved) ?? null : null
      } else {
        target = workspacePackageNode(specifier, nodes)
      }
      if (!target || target.id === from.id) continue

      const key = `${from.id}->${target.id}`
      const current = edgeMap.get(key) ?? { from: from.id, to: target.id, count: 0, evidence: [] }
      current.count += 1
      if (current.evidence.length < 8) {
        current.evidence.push({
          importer: relative(importer),
          import: specifier,
        })
      }
      edgeMap.set(key, current)
    }
  }

  return [...edgeMap.values()].sort((left, right) => (
    left.from.localeCompare(right.from) || left.to.localeCompare(right.to)
  ))
}

function gitValue(args, fallback = "") {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  } catch {
    return fallback
  }
}

function manifestReferences(manifest) {
  const references = []
  for (const node of manifest.nodes) {
    for (const file of node.keyFiles ?? []) references.push({ path: file.path, owner: node.id })
    for (const doc of node.docs ?? []) references.push({ path: doc.path, owner: node.id })
  }
  for (const edge of manifest.edges ?? []) {
    for (const evidence of edge.evidence ?? []) references.push({ path: evidence, owner: `${edge.from}->${edge.to}` })
  }
  for (const flow of manifest.flows ?? []) {
    for (const step of flow.steps ?? []) {
      for (const file of step.files ?? []) references.push({ path: file, owner: `${flow.id}/${step.label}` })
    }
  }
  for (const gap of manifest.knownGaps ?? []) {
    if (gap.path) references.push({ path: gap.path, owner: gap.title })
  }
  return references
}

function boardReferences(board) {
  const references = []
  for (const signal of board.signals ?? []) {
    if (signal.source) references.push({ path: signal.source, owner: `signal/${signal.label}` })
  }
  if (board.health?.source) references.push({ path: board.health.source, owner: "health" })
  for (const column of board.columns ?? []) {
    for (const card of column.cards ?? []) {
      if (card.source) references.push({ path: card.source, owner: `card/${card.id}` })
      for (const reference of card.references ?? []) {
        references.push({ path: reference.path, owner: `card/${card.id}/${reference.label}` })
      }
    }
  }
  return references
}

function validateProjectBoard(manifest, board) {
  const errors = []
  const nodeIds = new Set(manifest.nodes.map((node) => node.id))
  const columnIds = new Set()
  const cardIds = new Set()
  const required = (value, owner) => {
    if (value === undefined || value === null || value === "") errors.push(owner)
  }

  required(board.title, "title")
  required(board.updatedAt, "updatedAt")
  required(board.baseline?.branch, "baseline.branch")
  required(board.baseline?.commit, "baseline.commit")
  required(board.health?.label, "health.label")
  required(board.health?.summary, "health.summary")
  if (!Array.isArray(board.signals) || board.signals.length === 0) errors.push("signals")
  if (!Array.isArray(board.focus) || board.focus.length === 0) errors.push("focus")
  if (!Array.isArray(board.columns) || board.columns.length === 0) errors.push("columns")

  for (const column of board.columns ?? []) {
    required(column.id, "columns[].id")
    required(column.label, `columns.${column.id}.label`)
    if (columnIds.has(column.id)) errors.push(`columns.${column.id} duplicated`)
    columnIds.add(column.id)
    for (const card of column.cards ?? []) {
      required(card.id, `cards.${column.id}[].id`)
      required(card.title, `cards.${card.id}.title`)
      required(card.summary, `cards.${card.id}.summary`)
      if (cardIds.has(card.id)) errors.push(`cards.${card.id} duplicated`)
      cardIds.add(card.id)
      for (const moduleId of card.modules ?? []) {
        if (!nodeIds.has(moduleId)) errors.push(`cards.${card.id}.modules.${moduleId}`)
      }
      for (const item of card.checklist ?? []) {
        required(item.label, `cards.${card.id}.checklist[].label`)
        if (typeof item.done !== "boolean") errors.push(`cards.${card.id}.checklist.${item.label}.done`)
      }
    }
  }
  for (const focus of board.focus ?? []) {
    required(focus.cardId, "focus[].cardId")
    if (!cardIds.has(focus.cardId)) errors.push(`focus.${focus.cardId}`)
  }
  return errors
}

function validateLocale(manifest, locale) {
  const missing = []
  const requireValue = (value, owner) => {
    if (value === undefined || value === null || value === "") missing.push(owner)
  }
  const projectBoardCopyKeys = [
    "eyebrow",
    "title",
    "intro",
    "updated",
    "baseline",
    "health",
    "signals",
    "focus",
    "columns",
    "filters",
    "all",
    "filterActive",
    "filterBlocked",
    "filterDone",
    "filterP1",
    "filterG",
    "cards",
    "checklist",
    "progress",
    "modules",
    "source",
    "references",
    "openModule",
    "openSource",
    "sourceTruth",
    "empty",
    "state",
    "priority",
    "boardCards",
    "allModules",
  ]

  requireValue(locale.meta?.title, "meta.title")
  requireValue(locale.meta?.subtitle, "meta.subtitle")
  for (const key of projectBoardCopyKeys) {
    requireValue(locale.meta?.projectBoard?.[key], `meta.projectBoard.${key}`)
  }
  for (const layer of manifest.layers) {
    requireValue(locale.layers?.[layer.id]?.label, `layers.${layer.id}.label`)
    requireValue(locale.layers?.[layer.id]?.description, `layers.${layer.id}.description`)
  }
  for (const node of manifest.nodes) {
    const translation = locale.nodes?.[node.id]
    requireValue(translation?.label, `nodes.${node.id}.label`)
    requireValue(translation?.shortLabel, `nodes.${node.id}.shortLabel`)
    requireValue(translation?.purpose, `nodes.${node.id}.purpose`)
    if (!Array.isArray(translation?.owns) || translation.owns.length !== node.owns.length) {
      missing.push(`nodes.${node.id}.owns[${node.owns.length}]`)
    }
    if (!Array.isArray(translation?.invariants) || translation.invariants.length !== node.invariants.length) {
      missing.push(`nodes.${node.id}.invariants[${node.invariants.length}]`)
    }
  }
  for (const edge of manifest.edges) {
    requireValue(locale.edges?.[`${edge.from}->${edge.to}`], `edges.${edge.from}->${edge.to}`)
  }
  for (const flow of manifest.flows) {
    const translation = locale.flows?.[flow.id]
    requireValue(translation?.label, `flows.${flow.id}.label`)
    requireValue(translation?.summary, `flows.${flow.id}.summary`)
    if (!Array.isArray(translation?.steps) || translation.steps.length !== flow.steps.length) {
      missing.push(`flows.${flow.id}.steps[${flow.steps.length}]`)
    }
  }
  if (!Array.isArray(locale.rules) || locale.rules.length !== manifest.rules.length) {
    missing.push(`rules[${manifest.rules.length}]`)
  }
  if (!Array.isArray(locale.knownGaps) || locale.knownGaps.length !== manifest.knownGaps.length) {
    missing.push(`knownGaps[${manifest.knownGaps.length}]`)
  }
  return missing
}

function createGeneratedModel(manifest, locale, projectBoard) {
  const allFiles = walk(root).filter((file) => isSourceFile(relative(file)))
  const mappedFiles = new Set()
  const nodes = manifest.nodes.map((node) => {
    const files = sourceFilesForNode(node, allFiles, manifest.nodes)
    for (const file of files) mappedFiles.add(file.path)
    return {
      ...node,
      files,
      fileCount: files.length,
      totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    }
  })

  const unmappedFiles = allFiles
    .map(relative)
    .filter((filePath) => !mappedFiles.has(filePath))
    .sort()
  const observedEdges = collectObservedEdges(allFiles, manifest.nodes)
  const explicitEdges = manifest.edges.map((edge) => {
    const observed = observedEdges.find((item) => item.from === edge.from && item.to === edge.to)
    return {
      ...edge,
      observedImports: observed?.count ?? 0,
      observedEvidence: observed?.evidence ?? [],
    }
  })

  const missingReferences = [...manifestReferences(manifest), ...boardReferences(projectBoard)]
    .filter((reference) => !existsSync(path.join(root, reference.path)))
    .sort((left, right) => left.path.localeCompare(right.path))

  const totalLines = nodes.reduce((sum, node) => sum + node.totalLines, 0)
  const model = {
    ...manifest,
    locale,
    projectBoard,
    generated: {
      repository: "OpenColorful",
      generatedFrom: "docs/architecture-map/architecture.manifest.json",
      generatedBy: "scripts/generate-architecture-map.mjs",
      nodeCount: nodes.length,
      sourceFileCount: allFiles.length,
      mappedFileCount: mappedFiles.size,
      unmappedFileCount: unmappedFiles.length,
      totalSourceLines: totalLines,
      missingReferenceCount: missingReferences.length,
      projectBoardCardCount: projectBoard.columns.reduce((sum, column) => sum + column.cards.length, 0),
    },
    nodes,
    edges: explicitEdges,
    observedEdges,
    unmappedFiles,
    missingReferences,
  }
  return model
}

function generatedModule(model) {
  return `/* This file is generated. Edit architecture.manifest.json and run npm run architecture:map. */\nwindow.__OPENCOLORFUL_ARCHITECTURE__ = ${JSON.stringify(model, null, 2)};\n`
}

const checkOnly = process.argv.includes("--check")
const manifest = readManifest()
const locale = readLocale()
const projectBoard = readProjectBoard()
const localeErrors = validateLocale(manifest, locale)
const boardErrors = validateProjectBoard(manifest, projectBoard)
const model = createGeneratedModel(manifest, locale, projectBoard)

if (localeErrors.length > 0) {
  console.error("Architecture map has incomplete zh-CN presentation copy:")
  for (const error of localeErrors) console.error(`- ${error}`)
  process.exitCode = 1
}

if (boardErrors.length > 0) {
  console.error("Architecture map has incomplete project board data:")
  for (const error of boardErrors) console.error(`- ${error}`)
  process.exitCode = 1
}

if (model.unmappedFiles.length > 0) {
  console.error("Architecture map has unmapped production source files:")
  for (const file of model.unmappedFiles) console.error(`- ${file}`)
  process.exitCode = 1
}

if (model.missingReferences.length > 0) {
  console.error("Architecture map has missing manifest references:")
  for (const reference of model.missingReferences) {
    console.error(`- ${reference.path} (${reference.owner})`)
  }
  process.exitCode = 1
}

const output = generatedModule(model)
if (checkOnly) {
  const current = existsSync(generatedPath) ? readFileSync(generatedPath, "utf8") : ""
  if (current !== output) {
    console.error("Architecture map is stale. Run: npm run architecture:map")
    process.exitCode = 1
  } else {
    console.log(`Architecture map is current (${model.generated.nodeCount} nodes, ${model.generated.sourceFileCount} source files).`)
  }
} else {
  mkdirSync(mapDir, { recursive: true })
  writeFileSync(generatedPath, output, "utf8")
  console.log(`Generated ${relative(generatedPath)} (${model.generated.nodeCount} nodes, ${model.generated.sourceFileCount} source files).`)
  if (model.unmappedFiles.length === 0) console.log("All production source files are covered by the architecture manifest.")
}
