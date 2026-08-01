import { promises as fs } from "node:fs";
import path from "node:path";

export async function ensureMemoryDir(memoryDir: string): Promise<void> {
  await fs.mkdir(path.join(memoryDir, "daily"), { recursive: true });
  await fs.mkdir(path.join(memoryDir, "state"), { recursive: true });
}

export async function readSectionFile(memoryDir: string, name: string): Promise<string> {
  try {
    return await fs.readFile(path.join(memoryDir, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.writeFile(temporary, content, "utf8");
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function listDailyFiles(memoryDir: string): Promise<Array<{ date: string; content: string }>> {
  const directory = path.join(memoryDir, "daily");
  let names: string[];
  try { names = await fs.readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const dates = names
    .map((name) => /^([0-9]{4}-[0-9]{2}-[0-9]{2})\.md$/.exec(name)?.[1])
    .filter((date): date is string => date !== undefined)
    .sort();
  return Promise.all(dates.map(async (date) => {
    const raw = await fs.readFile(path.join(directory, `${date}.md`), "utf8");
    return { date, content: raw.replace(/^##\s+[^\n]*\n?/, "").trim() };
  }));
}

export async function writeDailyFile(memoryDir: string, date: string, body: string): Promise<void> {
  await atomicWriteFile(path.join(memoryDir, "daily", `${date}.md`), `## ${date}\n${body.trim()}\n`);
}

export async function deleteDailyFile(memoryDir: string, date: string): Promise<void> {
  try { await fs.unlink(path.join(memoryDir, "daily", `${date}.md`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function getLogicalDate(now: Date = new Date()): string {
  const local = new Date(now.getTime());
  if (local.getHours() < 4) local.setDate(local.getDate() - 1);
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
