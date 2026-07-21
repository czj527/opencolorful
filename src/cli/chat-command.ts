import { loadEnvironment } from "../config/environment.js";
import { TuiApp } from "../tui/app.js";

export async function runChatCommand(_args: readonly string[]): Promise<void> {
  const environment = loadEnvironment();
  const baseUrl = `http://${environment.host}:${environment.port}`;
  const app = new TuiApp(baseUrl);
  await app.start();
}
