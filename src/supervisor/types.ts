export type SupervisorStatus =
  | "stopped"
  | "starting"
  | "online"
  | "degraded"
  | "stopping"
  | "error";

export type AgentServerStatus =
  | "stopped"
  | "starting"
  | "online"
  | "degraded"
  | "stopping"
  | "error";

export interface SupervisorState {
  readonly supervisorPid: number;
  readonly supervisorPort: number;
  readonly supervisorStartedAt: string;
  readonly agentServerPid: number | null;
  readonly agentServerPort: number | null;
  readonly agentServerStatus: AgentServerStatus;
  readonly agentServerStartedAt: string | null;
  readonly updatedAt: string;
}

export interface SupervisorStatusResponse {
  readonly status: SupervisorStatus;
  readonly supervisor: {
    readonly pid: number;
    readonly port: number;
    readonly version: string;
    readonly uptimeSeconds: number;
  };
  readonly agentServer: {
    readonly status: AgentServerStatus;
    readonly pid: number | null;
    readonly port: number | null;
    readonly version: string | null;
  };
}

export interface SupervisorLogResponse {
  readonly logs: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export const SUPERVISOR_DEFAULT_PORT = 4311;

export const MAX_LOG_TAIL_BYTES = 64 * 1024;
