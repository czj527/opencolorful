import { usePageRoute } from "./page-router.js";
import { WorkspaceApp } from "./WorkspaceApp.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";
import { ApiClient } from "../lib/api-client.js";

const API_BASE = "";
const api = new ApiClient(API_BASE);

export function App() {
  const route = usePageRoute();
  return route === "settings" ? <SettingsPage api={api} /> : <WorkspaceApp />;
}