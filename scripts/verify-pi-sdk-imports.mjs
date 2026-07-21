import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IMPORT_PATTERN = /(?:from\s+|import\s*(?:\(\s*)?)["'](@earendil-works\/pi-[^"']+)["']/g;

function collectTypeScriptFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectTypeScriptFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

export function findPiSdkImportViolations(projectRoot) {
  const sourceRoot = path.join(projectRoot, "src");
  const adapterRoot = path.join(sourceRoot, "pi-sdk") + path.sep;
  const violations = [];

  for (const filePath of collectTypeScriptFiles(sourceRoot)) {
    if (filePath.startsWith(adapterRoot)) {
      continue;
    }
    const source = fs.readFileSync(filePath, "utf8");
    if (IMPORT_PATTERN.test(source)) {
      violations.push(path.relative(projectRoot, filePath).replaceAll(path.sep, "/"));
    }
    IMPORT_PATTERN.lastIndex = 0;
  }
  return violations;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
  const violations = findPiSdkImportViolations(projectRoot);
  if (violations.length > 0) {
    console.error(`PI SDK 只能从 src/pi-sdk 导入:\n${violations.join("\n")}`);
    process.exitCode = 1;
  }
}
