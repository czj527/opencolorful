/**
 * A4b lane · 后端 fixture（隔离生命周期，lane 本地实现）。
 *
 * 结构与共享冒烟 fixtures/backend.ts 同构（runRoot/home/user-data/logs + ready 行解析 +
 * dispose retain/清理自检），差异：
 * - 引导的是 lane-a4b/server-bootstrap.ts（stub 行为可切换 + circuit proxy）；
 * - app 经 `appUrl`（代理端口）访问后端；真值断言经 `serverUrl`（直连 Agent Server，只读）；
 * - stub Provider 行为经 `setStub()` 配置；断路器经 `circuit()` 开合。
 *
 * 复用共享 backend.ts 的导出（只读 import）：REPO_ROOT / ARTIFACTS_DIR / stripCredentialEnv。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ARTIFACTS_DIR, REPO_ROOT, stripCredentialEnv } from "../backend.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_PATH = path.join(here, "server-bootstrap.ts");

const HEALTH_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 20_000;

export interface StubOptions {
  readonly mode: "fast" | "slow" | "error-401" | "error-429" | "timeout-reset";
  readonly chunks?: number;
  readonly intervalMs?: number;
  readonly text?: string;
  readonly delayMs?: number;
}

export class LaneBackendHarness {
  readonly homeDir: string;
  readonly userDataDir: string;
  readonly runRoot: string;
  readonly fakeApiKey: string;
  readonly bootstrapLogPath: string;

  private process: ReturnType<typeof spawn> | null = null;
  private serverPort = 0;
  private stubPort = 0;
  private proxyPort = 0;
  private disposed = false;

  constructor(readonly label: string) {
    this.runRoot = fs.mkdtempSync(path.join(this.tmpRoot(), "oc-e2e-"));
    this.homeDir = path.join(this.runRoot, "home");
    this.userDataDir = path.join(this.runRoot, "user-data");
    this.bootstrapLogPath = path.join(this.runRoot, "logs", "bootstrap.log");
    fs.mkdirSync(this.homeDir, { recursive: true });
    fs.mkdirSync(this.userDataDir, { recursive: true });
    fs.mkdirSync(path.dirname(this.bootstrapLogPath), { recursive: true });
    // 测试数据一律 oc-e2e- 前缀；假凭据（红线：禁止真实 Key，desktop-test-conventions §七）
    this.fakeApiKey = "oc-e2e-fake-key";
  }

  private tmpRoot(): string {
    return process.env.TMPDIR ?? process.env.TEMP ?? "/tmp";
  }

  private log(message: string): void {
    try {
      fs.appendFileSync(this.bootstrapLogPath, `${new Date().toISOString()} [lane-fixture] ${message}\n`);
    } catch {
      // 日志失败不影响主流程
    }
  }

  /** Agent Server 直连地址（真值断言 / 控制面之外只读使用） */
  get serverUrl(): string {
    return `http://127.0.0.1:${this.serverPort}`;
  }

  /** app 应当使用的地址（circuit proxy）——launchApp 的 OPENCOLORFUL_SERVER_URL */
  get appUrl(): string {
    return `http://127.0.0.1:${this.proxyPort}`;
  }

  /** stub Provider 的 OpenAI 兼容 base（onboarding 第 2 步 Base URL 填这里） */
  get stubUrl(): string {
    return `http://127.0.0.1:${this.stubPort}/v1`;
  }

  private get stubBase(): string {
    return `http://127.0.0.1:${this.stubPort}`;
  }

  get started(): boolean {
    return this.serverPort !== 0 && this.proxyPort !== 0;
  }

  async start(): Promise<void> {
    // Windows 下 ESM loader 偶发瞬时 `UNKNOWN: unknown error, read`（文件锁/Defender 竞态）：
    // 最多重试 3 次（与共享 backend.ts 同一策略）
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.spawnOnce();
        return;
      } catch (error) {
        lastError = error;
        this.process = null;
        this.log(`引导尝试 #${attempt} 失败：${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async spawnOnce(): Promise<void> {
    const child = spawn(process.execPath, ["--import", "tsx", BOOTSTRAP_PATH], {
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
      const timer = setTimeout(() => reject(new Error(`lane 后端引导超时（${HEALTH_TIMEOUT_MS}ms）`)), HEALTH_TIMEOUT_MS);
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
              const payload = JSON.parse(line) as { type?: string; serverPort?: number; stubPort?: number; proxyPort?: number };
              if (payload.type === "ready") {
                this.serverPort = payload.serverPort ?? 0;
                this.stubPort = payload.stubPort ?? 0;
                this.proxyPort = payload.proxyPort ?? 0;
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
        if (!readySeen) reject(new Error(`lane 后端引导进程提前退出（code=${code}），日志：${this.bootstrapLogPath}`));
      });
    });

    await readyPromise;
    await this.waitUntilHealthy(`${this.serverUrl}/api/health`);
    await this.waitUntilHealthy(`${this.appUrl}/api/health`);
  }

  private async waitUntilHealthy(url: string): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
      } catch (cause) {
        lastError = cause instanceof Error ? cause.message : String(cause);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`后端未就绪（${url}）：${lastError}`);
  }

  /** Node 侧真值读取（只读）：GET JSON（直连 Agent Server，不经代理） */
  async apiGet<T>(apiPath: string): Promise<T> {
    const response = await fetch(`${this.serverUrl}${apiPath}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`GET ${apiPath} → HTTP ${response.status}`);
    return await response.json() as T;
  }

  /** 切换 stub Provider 行为（lane 控制面） */
  async setStub(options: StubOptions): Promise<void> {
    const response = await fetch(`${this.stubBase}/__a4b__/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`setStub → HTTP ${response.status}`);
  }

  /** 开合断路器：open=true 时 app → server 的转发被断开（等效断线，不 kill 服务进程） */
  async circuit(open: boolean): Promise<void> {
    const response = await fetch(`${this.appUrl}/__a4b__/circuit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ open }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`circuit(${open}) → HTTP ${response.status}`);
  }

  /**
   * 停止后端并清理临时目录（与共享 backend.ts 同语义）：
   * - retain=true（用例失败）：保留 runRoot 现场，拷贝证据到 desktop/test-artifacts/
   * - retain=false（用例通过）：删除 runRoot 并自检
   */
  async dispose(retain: boolean): Promise<{ cleaned: boolean; artifactsDir: string | null }> {
    if (this.disposed) return { cleaned: !fs.existsSync(this.runRoot), artifactsDir: null };
    this.disposed = true;

    const child = this.process;
    if (child !== null && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
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
      const artifactsDir = path.join(ARTIFACTS_DIR, `oc-e2e-lane-a4b-retain-${this.label}-${Date.now()}`);
      fs.mkdirSync(artifactsDir, { recursive: true });
      this.log(`retain 留证开始 → ${artifactsDir}`);
      try {
        // 不用 fs.cpSync（Windows 锁文件竞态）；手动逐文件读写只碰小日志
        const bootstrapLog = path.join(this.runRoot, "bootstrap.log");
        if (fs.existsSync(bootstrapLog)) fs.copyFileSync(bootstrapLog, path.join(artifactsDir, "bootstrap.log"));
        for (const [name, dir] of [["home-tree.txt", this.homeDir], ["user-data-tree.txt", this.userDataDir]] as const) {
          fs.writeFileSync(path.join(artifactsDir, name), this.treeListing(dir));
        }
        fs.writeFileSync(path.join(artifactsDir, "RETAINED_RUN_ROOT.txt"), this.runRoot);
      } catch (error) {
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
