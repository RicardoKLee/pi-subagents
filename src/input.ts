import type { InputEventResult } from "@earendil-works/pi-coding-agent";
import type { SubagentManager } from "./manager.ts";
import type { Route } from "./mention.ts";

export interface RouteDeps {
  manager: SubagentManager;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** True when the input carried images; subagents only receive text. */
  images: boolean;
}

/** Applies a mention route: steer or resume the subagent (without waiting for its result) and tell the user. */
export async function handleRoute(route: Route, deps: RouteDeps): Promise<InputEventResult> {
  const { manager, notify } = deps;
  switch (route.action) {
    case "pass":
      return { action: "continue" };
    case "main":
      return { action: "transform", text: route.text };
    case "error":
      notify(route.message, "error");
      return { action: "handled" };
    case "steer":
      try {
        await manager.steer(route.handle, route.message, "steer", { mention: true, ...(route.delivery ? { delivery: route.delivery } : {}) });
        notify(`added to @${route.handle} while it runs${route.delivery ? ` (${route.delivery})` : ""}`, "info");
      } catch (error) {
        notify((error as Error).message, "error");
      }
      if (deps.images) notify("images are not forwarded to subagents", "warning");
      return { action: "handled" };
    case "resume": {
      const problem = manager.checkResumable(route.handle);
      if (problem) {
        notify(problem.message, "error");
        return { action: "handled" };
      }
      // Do not wait: the input hook runs inside the main session's prompt(); the result is delivered later.
      void manager
        .resume(route.handle, route.message, { background: true, delivery: route.delivery, mention: true })
        .catch((error: Error) => notify(`@${route.handle}: ${error.message}`, "error"));
      notify(`sent to @${route.handle} (${route.delivery})`, "info");
      if (deps.images) notify("images are not forwarded to subagents", "warning");
      return { action: "handled" };
    }
  }
}
