import type { SupervisorStatusResponse } from "../../../lib/types.js";
import styles from "./RuntimeSection.module.css";

export interface RuntimeSectionProps {
  readonly supervisorStatus: SupervisorStatusResponse | null;
}

export function RuntimeSection(props: RuntimeSectionProps) {
  const s = props.supervisorStatus;
  if (s === null) {
    return (
      <p className={styles.error} role="alert">
        Supervisor 状态不可用
      </p>
    );
  }
  return (
    <dl className={styles.info}>
      <dt>Supervisor PID</dt>
      <dd>{s.supervisor.pid}</dd>
      <dt>Supervisor 端口</dt>
      <dd>{s.supervisor.port}</dd>
      <dt>Supervisor 版本</dt>
      <dd>{s.supervisor.version}</dd>
      <dt>Agent Server PID</dt>
      <dd>{s.agentServer.pid ?? "—"}</dd>
      <dt>Agent Server 端口</dt>
      <dd>{s.agentServer.port ?? "—"}</dd>
      <dt>Agent Server 版本</dt>
      <dd>{s.agentServer.version ?? "—"}</dd>
      <dt>Agent Server 状态</dt>
      <dd>{s.agentServer.status}</dd>
    </dl>
  );
}
