import type { SupervisorStatusResponse } from "../../../lib/types.js";

export interface RuntimeSectionProps {
  readonly supervisorStatus: SupervisorStatusResponse | null;
}

export function RuntimeSection(props: RuntimeSectionProps) {
  const s = props.supervisorStatus;
  return (
    <section className="settings-section" data-testid="settings-section-runtime">
      <h2>运行时与关于</h2>
      <p className="settings-desc">当前进程状态与版本信息。</p>

      {s === null ? (
        <p className="save-error">Supervisor 状态不可用</p>
      ) : (
        <dl className="runtime-info">
          <dt>Supervisor PID</dt><dd>{s.supervisor.pid}</dd>
          <dt>Supervisor 端口</dt><dd>{s.supervisor.port}</dd>
          <dt>Supervisor 版本</dt><dd>{s.supervisor.version}</dd>
          <dt>Agent Server PID</dt><dd>{s.agentServer.pid ?? "—"}</dd>
          <dt>Agent Server 端口</dt><dd>{s.agentServer.port ?? "—"}</dd>
          <dt>Agent Server 版本</dt><dd>{s.agentServer.version ?? "—"}</dd>
          <dt>Agent Server 状态</dt><dd>{s.agentServer.status}</dd>
        </dl>
      )}
    </section>
  );
}