import {
  agentSelectPage,
  autoswitchPage,
  liveMatchPage,
  timeoutPage,
  type Page,
} from "./pages.js";

export const routes: Record<string, Page> = {
  "/live": liveMatchPage,
  "/agent-select": agentSelectPage,
  "/autoswitch": autoswitchPage,
  "/timeout": timeoutPage,
};

export function resolveRoute(pathname: string): Page {
  return routes[pathname.replace(/\/+$/, "")] ?? autoswitchPage;
}
