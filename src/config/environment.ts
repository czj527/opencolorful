export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeEnvironment {
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4310;
const DEFAULT_LOG_LEVEL: LogLevel = "info";
const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OPENCOLORFUL_PORT 必须是 1 到 65535 之间的整数");
  }
  return port;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_LOG_LEVEL;
  }

  if (!LOG_LEVELS.has(value as LogLevel)) {
    throw new Error("OPENCOLORFUL_LOG_LEVEL 必须是 debug、info、warn 或 error");
  }
  return value as LogLevel;
}

export function loadEnvironment(environment: NodeJS.ProcessEnv = process.env): RuntimeEnvironment {
  return {
    host: environment.OPENCOLORFUL_HOST?.trim() || DEFAULT_HOST,
    port: parsePort(environment.OPENCOLORFUL_PORT),
    logLevel: parseLogLevel(environment.OPENCOLORFUL_LOG_LEVEL),
  };
}
