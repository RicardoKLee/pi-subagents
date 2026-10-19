import { readFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { LEAF_PIN_ENTRY_TYPE } from "../src/runner/rpc.ts";
import type { ChildSession, ChildSpec } from "../src/runner/types.ts";
import { harness } from "./harness.ts";
import { childPids } from "./proc.ts";
import { cleanupTempDirs } from "./tmp.ts";

afterAll(cleanupTempDirs);

/** Real `pi --mode rpc` children (scripted faux provider, isolated agent dir), beyond the shared contract. */
describe("RpcRunner with a real pi child", () => {
  const sessions: ChildSession[] = [];
  const open = async (h: Awaited<ReturnType<typeof harness>>, extra: Partial<ChildSpec> = {}) => {
    const s = await h.runner.open({ ...h.spec, ...extra });
    sessions.push(s);
    return s;
  };
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.dispose().catch(() => {})));
  });
  /** Live pi rpc children spawned by this harness's worker (pi rewrites its cmdline to exactly `["pi"]`). */
  const children = (_h: Awaited<ReturnType<typeof harness>>) => childPids(["pi"]);
  const pinCount = (file: string) => readFileSync(file, "utf8").split("\n").filter((l) => l.includes(LEAF_PIN_ENTRY_TYPE)).length;

  it("should_end_the_process_when_disposed", async () => {
    const h = await harness("rpc");
    h.script([{ text: "a" }]);
    const s = await open(h);
    await s.prompt("x");
    expect(children(h)).toHaveLength(1);
    await s.dispose();
    expect(children(h)).toEqual([]);
  });

  it("should_report_an_idle_crash_and_resume_in_a_new_child_with_the_prior_context", async () => {
    const h = await harness("rpc");
    h.script([{ text: "noted" }, { text: "kiwi" }]);
    const s = await open(h);
    await s.prompt("remember kiwi");
    const [pid] = children(h);
    const exited = new Promise<string>((resolve) => s.onExit(resolve));
    process.kill(pid!, "SIGKILL");
    expect(await exited).toMatch(/signal SIGKILL/);
    expect(s.alive).toBe(false);
    await expect(s.dispose()).resolves.toBeUndefined();

    const resumed = await open(h, { resumeFile: s.sessionFile, ...(s.leafId ? { resumeLeafId: s.leafId } : {}) });
    expect(children(h)).toHaveLength(1);
    expect(children(h)).not.toContain(pid);
    expect((await resumed.prompt("which word?")).text).toBe("kiwi");
    expect(h.seen()[1]).toContain("remember kiwi");
  });

  it("should_not_write_a_pin_marker_when_the_recorded_leaf_is_already_last", async () => {
    const h = await harness("rpc");
    h.script([{ text: "a" }, { text: "b" }]);
    const first = await open(h);
    await first.prompt("one");
    await first.dispose();
    const file = first.sessionFile;
    const resumed = await open(h, { resumeFile: file, resumeLeafId: first.leafId! });
    await resumed.prompt("two");
    expect(pinCount(file)).toBe(0);
  });

  it("should_stay_on_the_pinned_branch_for_later_turns_and_record_the_new_leaf_under_it", async () => {
    const h = await harness("rpc");
    h.script([{ text: "noted kiwi" }, { text: "noted mango" }, { text: "kiwi" }, { text: "still kiwi" }]);
    const first = await open(h);
    await first.prompt("remember the word kiwi");
    const file = first.sessionFile;
    const kiwiLeaf = first.leafId!;
    await first.dispose();
    const other = await open(h, { resumeFile: file });
    await other.prompt("remember the word mango");
    await other.dispose();

    const pinned = await open(h, { resumeFile: file, resumeLeafId: kiwiLeaf });
    expect(pinned.leafId).toBe(kiwiLeaf);
    await pinned.prompt("which word?");
    await pinned.prompt("and now?");
    expect(h.seen()[3]).toContain("which word?");
    expect(h.seen()[3]).not.toContain("mango");
    expect(pinCount(file)).toBe(1);
    // The leaf the runner reports lies on the pinned branch.
    await pinned.dispose();
    const branchIds = SessionManager.open(file).getBranch(pinned.leafId!).map((e) => e.id);
    expect(branchIds).toContain(kiwiLeaf);
    expect(JSON.stringify(SessionManager.open(file).getBranch(pinned.leafId!))).not.toContain("mango");
  });
});
