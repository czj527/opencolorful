import { useCallback, useState } from "react";
import { FlaskConical, RefreshCw, TerminalSquare } from "lucide-react";
import { Button } from "../../components/ui/index.js";
import { isPluginServiceUnavailable, PluginApiClient } from "../../lib/plugin-api.js";
import { ErrorBlock, StatusPill } from "./plugin-ui.js";
import styles from "./plugins.module.css";

export interface DevelopmentViewProps {
  readonly pluginApi: PluginApiClient;
}

type DevAction = "install" | "reload" | "enable" | "disable" | "reset" | "diagnostics" | "invoke" | "scenario";

export function DevelopmentView(props: DevelopmentViewProps) {
  const [sourceDir, setSourceDir] = useState("");
  const [pluginId, setPluginId] = useState("");
  const [toolName, setToolName] = useState("");
  const [toolArgs, setToolArgs] = useState("");
  const [scenarioName, setScenarioName] = useState("");
  const [busyAction, setBusyAction] = useState<DevAction | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: DevAction, fn: () => Promise<unknown>) => {
    setBusyAction(action);
    setError(null);
    setResult(null);
    try {
      const value = await fn();
      setResult(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "操作失败";
      setError(
        isPluginServiceUnavailable(cause)
          ? "开发态 API（/api/plugins/dev/*）尚未接入，当前只能查看占位界面。"
          : message,
      );
    } finally {
      setBusyAction(null);
    }
  }, []);

  return (
    <div data-testid="development-view">
      <section className={styles.sectionCard}>
        <h3 className={styles.sectionTitle}>
          <FlaskConical size={14} aria-hidden="true" />
          本地开发插件（Dev Loop）
        </h3>
        <p className={styles.hint}>
          从本地目录开发态安装：Runtime copy 位于独立 dev 安装目录，不写正式插件目录；每次 install/reload 生成新的
          devRunId，旧运行上下文不能操作新实例。Agent 可见的插件开发工具默认关闭，需要用户显式启用。
        </p>

        <div className={styles.devForm}>
          <input
            className={styles.searchInput}
            placeholder="/absolute/path/to/plugin-source"
            value={sourceDir}
            onChange={(event) => setSourceDir(event.currentTarget.value)}
            aria-label="开发插件源码目录"
          />
          <Button
            size="sm"
            loading={busyAction === "install"}
            onClick={() => void run("install", () => props.pluginApi.devInstall({ sourceDir }))}
          >
            开发态安装
          </Button>
        </div>

        <div className={styles.devForm}>
          <input
            className={styles.searchInput}
            placeholder="pluginId"
            value={pluginId}
            onChange={(event) => setPluginId(event.currentTarget.value)}
            aria-label="开发插件 ID"
          />
          <Button
            size="sm"
            variant="ghost"
            loading={busyAction === "reload"}
            onClick={() => void run("reload", () => props.pluginApi.devReload(pluginId))}
          >
            <RefreshCw size={14} aria-hidden="true" />
            重载
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busyAction === "enable"}
            onClick={() => void run("enable", () => props.pluginApi.devEnable(pluginId))}
          >
            启用
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busyAction === "disable"}
            onClick={() => void run("disable", () => props.pluginApi.devDisable(pluginId))}
          >
            禁用
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={busyAction === "reset"}
            onClick={() => {
              if (!window.confirm("确认重置开发态插件？旧 devRunId 将失效。")) return;
              void run("reset", () => props.pluginApi.devReset(pluginId));
            }}
          >
            重置
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busyAction === "diagnostics"}
            onClick={() => void run("diagnostics", () => props.pluginApi.devDiagnostics(pluginId))}
          >
            诊断
          </Button>
        </div>
      </section>

      <section className={styles.sectionCard} style={{ marginTop: "var(--space-16)" }}>
        <h3 className={styles.sectionTitle}>
          <TerminalSquare size={14} aria-hidden="true" />
          场景测试（run-scenario）
        </h3>
        <div className={styles.devForm}>
          <input
            className={styles.searchInput}
            placeholder="pluginId"
            value={pluginId}
            onChange={(event) => setPluginId(event.currentTarget.value)}
            aria-label="场景测试插件 ID"
          />
          <input
            className={styles.searchInput}
            placeholder="toolName"
            value={toolName}
            onChange={(event) => setToolName(event.currentTarget.value)}
            aria-label="工具名"
          />
          <Button
            size="sm"
            variant="ghost"
            loading={busyAction === "invoke"}
            onClick={() => {
              const input: { toolName: string; args?: Readonly<Record<string, unknown>> } = { toolName };
              const parsed = parseJsonArgs(toolArgs);
              if (parsed !== undefined) input.args = parsed;
              void run("invoke", () => props.pluginApi.devInvokeTool(pluginId, input));
            }}
          >
            调用工具
          </Button>
        </div>
        <div className={styles.devForm}>
          <input
            className={styles.searchInput}
            placeholder="JSON 参数（可选）"
            value={toolArgs}
            onChange={(event) => setToolArgs(event.currentTarget.value)}
            aria-label="工具参数 JSON"
          />
          <input
            className={styles.searchInput}
            placeholder="scenarioName"
            value={scenarioName}
            onChange={(event) => setScenarioName(event.currentTarget.value)}
            aria-label="场景名"
          />
          <Button
            size="sm"
            variant="ghost"
            loading={busyAction === "scenario"}
            onClick={() => void run("scenario", () => props.pluginApi.devRunScenario(pluginId, { scenarioName }))}
          >
            运行场景
          </Button>
        </div>
        <p className={styles.hint}>
          run-scenario 支持 tool invocation、结果断言、Surface 打开和 destructive 标记；destructive 场景需要显式审批。
        </p>
      </section>

      {error !== null && <div style={{ marginTop: "var(--space-12)" }}><ErrorBlock message={error} /></div>}
      {result !== null && (
        <pre className={styles.devLog} data-testid="dev-result" role="status">
          {result}
        </pre>
      )}
      <div className={styles.cardMeta} style={{ marginTop: "var(--space-12)" }}>
        <StatusPill tone="muted">占位</StatusPill>
        <span>开发 API client 已按 /api/plugins/dev/* 契约就绪；真实执行依赖 Server dev 路由接线。</span>
      </div>
    </div>
  );
}

function parseJsonArgs(raw: string): Readonly<Record<string, unknown>> | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
