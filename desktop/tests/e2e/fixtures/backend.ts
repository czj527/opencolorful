/**
 * L6 真链冒烟 · 后端 fixture（隔离生命周期，agent-delegated 细节）。
 *
 * 每个用例独立的临时运行根（`oc-e2e-` 前缀）：
 *   <runRoot>/
 *     home/       → OPENCOLORFUL_HOME（Agent Server 全部落盘：agents/、config/、auth/、metadata.sqlite…）
 *     user-data/  → Electron --user-data-dir（shell.log 等应用侧状态）
 *     logs/       → 引导进程日志（bootstrap.log）
 *
 * 用例通过 → teardown 删除 runRoot 并自检清理干净；用例失败 → 保留 runRoot，
 * 并把 bootstrap 日志与 home/user-data 目录清单拷贝到 desktop/test-artifacts/ 留证。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// fixtures → e2e → tests → desktop → 仓库根（4 级）
export const REPO_ROOT = path.resolve(here, "..", "..", "..", "..");
export const DESKTOP_DIR = path.join(REPO_ROOT, "desktop");
export const ARTIFACTS_DIR = path.join(DESKTOP_DIR, "test-artifacts");

const HEALTH_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 20_000;

/**
 * 隔离红线（desktop-test-conventions §五.3）：剥离凭据类环境变量。
 * PI 内置目录会把 DEEPSEEK_API_KEY 等环境凭据计为 "已配置"（model-runtime.ts
 * getProviderAuthStatus source=environment），不剥离时测试会拿作者机器上的真实
 * key 调真实 Provider（2026-09-01 实测：401 invalid key 尾号 50ba）。
 */
export function stripCredentialEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (/(_API_KEY|_API_TOKEN|_ACCESS_TOKEN|_SECRET_KEY|AUTH_TOKEN)$/i.test(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export interface BackendOptions {
  /** 失败时保留现场（由 fixture teardown 依据用例结果决定） */
  readonly label: string;
}

export class BackendHarness {
  readonly homeDir: string;
  readonly userDataDir: string;
  readonly runRoot: string;
  readonly fakeApiKey: string;
  readonly bootstrapLogPath: string;

  private process: ReturnType<typeof spawn> | null = null;
  private stubPort = 0;
  private serverPort = 0;
  private disposed = false;

  constructor(readonly label: string) {
    this.runRoot = fs.mkdtempSync(path.join(this.tmpRoot(), "oc-e2e-"));
    this.homeDir = path.join(this.runRoot, "home");
    this.userDataDir = path.join(this.runRoot, "user-data");
    this.bootstrapLogPath = path.join(this.runRoot, "logs", "bootstrap.log");
    fs.mkdirSync(this.homeDir, { recursive: true });
    fs.mkdirSync(this.userDataDir, { recursive: true });
    fs.mkdirSync(path.dirname(this.bootstrapLogPath), { recursive: true });
    // 测试数据一律 oc-e2e- 前缀；这是假凭据（禁止真实 Key，红线见 desktop-test-conventions §七）
    this.fakeApiKey = "oc-e2e-fake-key";
  }

  private tmpRoot(): string {
    return process.env.TMPDIR ?? process.env.TEMP ?? "/tmp";
  }

  private log(message: string): void {
    try {
      fs.appendFileSync(this.bootstrapLogPath, `${new Date().toISOString()} [fixture] ${message}\n`);
    } catch {
      // 日志失败不影响主流程
    }
  }

  get serverUrl(): string {
    return `http://127.0.0.1:${this.serverPort}`;
  }

  /** 引导是否成功就绪（供 fixture 决定 retain/清理路径） */
  get started(): boolean {
    return this.serverPort !== 0;
  }

  get stubUrl(): string {
    return `http://127.0.0.1:${this.stubPort}/v1`;
  }

  async start(): Promise<void> {
    const bootstrapPath = path.join(here, "server-bootstrap.ts");
    // Windows 下 ESM loader 偶发瞬时 `UNKNOWN: unknown error, read`（文件锁/Defender 竞态）：
    // 最多重试 3 次，重试间隔留出文件锁释放时间
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.spawnOnce(bootstrapPath);
        return;
      } catch (error) {
        lastError = error;
        this.process = null;
        log(`引导尝试 #${attempt} 失败：${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async spawnOnce(bootstrapPath: string): Promise<void> {
    const child = spawn(process.execPath, ["--import", "tsx", bootstrapPath], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...stripCredentialEnv(process.env),
        OPENCOLORFUL_HOME: this.homeDir,
        OC_E2E_LOG: this.bootstrapLogPath,
      },
    });
    this.process = child;

    let stdoutBuffer = "";
    let readySeen = false;
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`后端引导超时（${HEALTH_TIMEOUT_MS}ms）`)), HEALTH_TIMEOUT_MS);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (data: string) => {
        stdoutBuffer += data;
        let boundary = stdoutBuffer.indexOf("\n");
        while (boundary !== -1 && !readySeen) {
          const line = stdoutBuffer.slice(0, boundary).trim();
          stdoutBuffer = stdoutBuffer.slice(boundary + 1);
          boundary = stdoutBuffer.indexOf("\n");
          if (line.startsWith("{")) {
            try {
              const payload = JSON.parse(line) as { type?: string; serverPort?: number; stubPort?: number };
              if (payload.type === "ready") {
                this.serverPort = payload.serverPort ?? 0;
                this.stubPort = payload.stubPort ?? 0;
                readySeen = true;
                clearTimeout(timer);
                resolve();
                return;
              }
            } catch {
              // 非 ready 行忽略（tsx 可能输出提示）
            }
          }
        }
      });
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (data: string) => {
        fs.appendFile(this.bootstrapLogPath, data, () => undefined);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (!readySeen) reject(new Error(`后端引导进程提前退出（code=${code}），日志：${this.bootstrapLogPath}`));
      });
    });

    await readyPromise;
    await this.waitUntilHealthy();
  }

  private async waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.serverUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
      } catch (cause) {
        lastError = cause instanceof Error ? cause.message : String(cause);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Agent Server 未就绪：${lastError}`);
  }

  /** Node 侧真值读取（只读）：GET JSON */
  async apiGet<T>(apiPath: string): Promise<T> {
    const response = await fetch(`${this.serverUrl}${apiPath}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`GET ${apiPath} → HTTP ${response.status}`);
    return await response.json() as T;
  }

  /**
   * 停止后端并清理临时目录。
   * - retain=true（用例失败）：保留 runRoot 现场，拷贝证据到 desktop/test-artifacts/
   * - retain=false（用例通过）：删除 runRoot，并用 existsSync 自检清理干净
   */
  async dispose(retain: boolean): Promise<{ cleaned: boolean; artifactsDir: string | null }> {
    if (this.disposed) return { cleaned: !fs.existsSync(this.runRoot), artifactsDir: null };
    this.disposed = true;

    const child = this.process;
    if (child !== null && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          // 优雅退出失败兜底：强杀进程组
          try {
            child.kill("SIGKILL");
          } catch {
            // 已退出
          }
          resolve();
        }, EXIT_TIMEOUT_MS);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.stdin!.write("shutdown\n");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {
            // 已退出
          }
        }
      });
    }

    if (retain) {
      const artifactsDir = path.join(ARTIFACTS_DIR, `oc-e2e-retain-${this.label}-${Date.now()}`);
      fs.mkdirSync(artifactsDir, { recursive: true });
      this.log(`retain 留证开始 → ${artifactsDir}`);
      try {
        // 不用 fs.cpSync：Windows 上对被占用文件存在 0xC0000409 原生崩溃案例
        // （Node libuv copyfile 竞态），手动逐文件读写只碰小日志，足够且可控。
        for (const name of ["bootstrap.log", "logs"]) {
          const source = path.join(this.runRoot, name);
          if (fs.existsSync(source)) {
            copyPlain(source, path.join(artifactsDir, name));
          }
        }
        for (const [name, dir] of [["home-tree.txt", this.homeDir], ["user-data-tree.txt", this.userDataDir]] as const) {
          fs.writeFileSync(path.join(artifactsDir, name), this.treeListing(dir));
        }
        // 失败现场整体保留在临时目录中，artifact 记录路径与清单（Windows 锁文件可能导致拷贝不全）
        fs.writeFileSync(path.join(artifactsDir, "RETAINED_RUN_ROOT.txt"), this.runRoot);
      } catch (error) {
        // 证据拷贝失败不影响清理流程
        this.log(`retain 留证失败：${error instanceof Error ? error.message : String(error)}`);
      }
      this.log("retain 留证完成");
      return { cleaned: false, artifactsDir };
    }

    fs.rmSync(this.runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { cleaned: !fs.existsSync(this.runRoot), artifactsDir: null };
  }

  private treeListing(root: string, depth = 0): string {
    if (!fs.existsSync(root)) return `${root}（不存在）`;
    if (depth > 4) return `${root}（…更深省略）`;
    let output = "";
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      return `${root}（读取失败：${error instanceof Error ? error.message : String(error)}）`;
    }
    for (const entry of entries) {
      output += `${"  ".repeat(depth)}${entry.name}${entry.isDirectory() ? "/" : ""}\n`;
      if (entry.isDirectory()) {
        output += this.treeListing(path.join(root, entry.name), depth + 1);
      }
    }
    return output;
  }
}

/** 手动递归拷贝（仅小日志文件；规避 fs.cpSync 在 Windows 上的原生崩溃案例） */
function copyPlain(source: string, target: string): void {
  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyPlain(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  fs.copyFileSync(source, target);
}
