import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePi } from "./fake-pi.ts";

/**
 * REVIEW-022: when the extension is loaded inside a subagent session (`PI_SUBAGENTS_CHILD` set), `src/index.ts`
 * must switch to the proxy-only child mode: a single `subagents` tool (only when the child may delegate) and none
 * of the main-session manager surface (no `/subagents` or `/sub` commands, no `input` hook, no entry renderers).
 *
 * `CHILD_RECORD` is captured when the module first evaluates, so each case loads a fresh copy of `src/index.ts`
 * under its own environment and restores both the environment and the module registry afterwards.
 */
const ENV_KEYS = ["PI_SUBAGENTS_CHILD", "PI_SUBAGENTS_DELEGATE", "PI_SUBAGENTS_MAILBOX"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  vi.resetModules();
});

/** Loads a fresh `src/index.ts` under the given child env and applies the returned extension to a FakePi. */
async function bootChild(env: { child?: string; delegate: "1" | "0"; mailbox?: string }): Promise<FakePi> {
  if (env.child === undefined) delete process.env.PI_SUBAGENTS_CHILD;
  else process.env.PI_SUBAGENTS_CHILD = env.child;
  process.env.PI_SUBAGENTS_DELEGATE = env.delegate;
  if (env.mailbox === undefined) delete process.env.PI_SUBAGENTS_MAILBOX;
  else process.env.PI_SUBAGENTS_MAILBOX = env.mailbox;
  const mod = await import("../src/index.ts");
  const pi = new FakePi();
  mod.createExtension()(pi.asApi());
  return pi;
}

describe("index child-session mode (REVIEW-022)", () => {
  it("should_register_the_proxy_tool_but_no_manager_surface_when_the_child_may_delegate", async () => {
    const pi = await bootChild({ child: "rec-1", delegate: "1", mailbox: "/tmp/mbox" });
    expect(pi.tools.has("subagents")).toBe(true);
    // The child owns no manager: no /subagents or /sub command, no @ input hook, no tree/private renderers.
    expect(pi.commands.size).toBe(0);
    expect(pi.handlers.get("input")).toBeUndefined();
    expect(pi.entryRenderers.size).toBe(0);
  });

  it("should_register_the_child_delegation_tool_sequential_when_the_child_may_delegate", async () => {
    // REVIEW-046 hardening: pi must run the calls of one assistant message one at a time for this tool, so two
    // delegations cannot race the manager's yield/re-acquire. The manager still coordinates them on its own.
    const pi = await bootChild({ child: "rec-1", delegate: "1", mailbox: "/tmp/mbox" });
    expect(pi.tools.get("subagents")!.executionMode).toBe("sequential");
  });

  it("should_register_no_tool_when_the_child_may_not_delegate", async () => {
    const pi = await bootChild({ child: "rec-1", delegate: "0", mailbox: "/tmp/mbox" });
    expect(pi.tools.size).toBe(0);
    expect(pi.commands.size).toBe(0);
    expect(pi.handlers.get("input")).toBeUndefined();
    expect(pi.entryRenderers.size).toBe(0);
  });

  it("should_keep_the_main_session_surface_when_PI_SUBAGENTS_CHILD_is_unset", async () => {
    // Regression guard: without the env the full extension (tool + commands + input hook) must still load.
    const pi = await bootChild({ delegate: "0" });
    expect(pi.tools.has("subagents")).toBe(true);
    expect(pi.commands.has("subagents")).toBe(true);
    expect(pi.handlers.get("input")?.length).toBe(1);
  });
});