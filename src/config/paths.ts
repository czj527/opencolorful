import os from "node:os";
import path from "node:path";

export interface RuntimePaths {
  readonly home: string;
  readonly config: string;
  readonly auth: string;
  readonly sessions: string;
  readonly logs: string;
  readonly runtime: string;
  readonly cache: string;
  readonly database: string;
  readonly providerSettings: string;
  readonly preferences: string;
  readonly authFile: string;
  readonly serverState: string;
  readonly serverLock: string;
  readonly serverLog: string;
}

export function getRuntimePaths(environment: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const override = environment.PERSON_AGENT_HOME?.trim();
  const home = override ? path.resolve(override) : path.join(os.homedir(), ".person-agent");
  const config = path.join(home, "config");
  const auth = path.join(home, "auth");
  const logs = path.join(home, "logs");
  const runtime = path.join(home, "runtime");

  return {
    home,
    config,
    auth,
    sessions: path.join(home, "sessions"),
    logs,
    runtime,
    cache: path.join(home, "cache"),
    database: path.join(home, "metadata.sqlite"),
    providerSettings: path.join(config, "providers.json"),
    preferences: path.join(config, "preferences.json"),
    authFile: path.join(auth, "auth.json"),
    serverState: path.join(runtime, "server.json"),
    serverLock: path.join(runtime, "server.lock"),
    serverLog: path.join(logs, "server.log"),
  };
}
