import { readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ChildSession, ChildSpec } from "../src/runner/types.ts";
import { harness } from "./harness.ts";
import { cleanupTempDirs } from "./tmp.ts";

afterAll(cleanupTempDirs);

describe.each(["sdk", "rpc"] as const)("runner contract: %s", (kind) => {
  const sessions: ChildSession[] = [];
  const open = async (h: Awaited<ReturnType<typeof harness>>, extra: Partial<ChildSpec> = {}) => {
    const s = await h.runner.open({ ...h.spec, ...extra });
    sessions.push(s);
    return s;
  };
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.dispose().catch(() => {})));
  });

  it("runs a prompt and persists the child session", async () => {
    const h = await harness(kind);
    h.script([{ text: "first answer" }]);
    const s = await open(h);
    const result = await s.prompt("hello");
    expect(result).toMatchObject({ text: "first answer", stopReason: "stop" });
    expect(s.sessionFile).toMatch(/\.jsonl$/);
    expect(readFileSync(s.sessionFile, "utf8")).toContain("first answer");
    expect(s.leafId).toBeTruthy();
  });

  it("a resident session answers several turns with the earlier context", async () => {
    const h = await harness(kind);
    h.script([{ text: "noted" }, { text: "kiwi" }]);
    const s = await open(h);
    await s.prompt("remember kiwi");
    const firstLeaf = s.leafId;
    expect((await s.prompt("which word?")).text).toBe("kiwi");
    expect(h.seen()[1]).toContain("remember kiwi");
    expect(s.leafId).not.toBe(firstLeaf);
  });

  it("resumes from the session file with the prior context", async () => {
    const h = await harness(kind);
    h.script([{ text: "noted" }, { text: "kiwi" }]);
    const first = await open(h);
    await first.prompt("remember kiwi");
    const file = first.sessionFile;
    await first.dispose();
    const resumed = await open(h, { resumeFile: file });
    expect((await resumed.prompt("which word?")).text).toBe("kiwi");
    expect(resumed.sessionFile).toBe(file);
    expect(h.seen()[1]).toContain("remember kiwi");
  });

  it("steer reaches a running turn", async () => {
    const h = await harness(kind);
    h.script([{ text: "working", delayMs: 500 }, { text: "steered" }]);
    const s = await open(h);
    const pending = s.prompt("start");
    await vi.waitFor(() => expect(h.seen()).toHaveLength(1));
    await s.steer("focus on tests", "steer");
    expect((await pending).text).toBe("steered");
    expect(h.seen()[1]).toContain("focus on tests");
  });

  it("abort ends the turn as aborted without reusing an earlier answer", async () => {
    const h = await harness(kind);
    h.script([{ text: "first" }, { waitForAbort: true }]);
    const s = await open(h);
    await s.prompt("one");
    const pending = s.prompt("two");
    await vi.waitFor(() => expect(h.seen()).toHaveLength(2));
    await s.abort();
    const result = await pending;
    expect(result.stopReason).toBe("aborted");
    expect(result.text).toBe("");
  });

  it("reports an error stop reason with its message", async () => {
    const h = await harness(kind);
    h.script([{ text: "", stopReason: "error", errorMessage: "boom" }]);
    const s = await open(h);
    const result = await s.prompt("x");
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("boom");
  });

  it("reports usage per turn", async () => {
    const h = await harness(kind);
    h.script([{ text: "a" }, { text: "b" }]);
    const s = await open(h);
    for (const turn of ["one", "two"]) {
      const { usage } = await s.prompt(turn);
      for (const v of Object.values(usage)) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("resumes from a pinned leaf without the later branch", async () => {
    const h = await harness(kind);
    h.script([{ text: "noted kiwi" }, { text: "noted mango" }, { text: "kiwi" }]);
    const first = await open(h);
    await first.prompt("remember the word kiwi");
    const file = first.sessionFile;
    const kiwiLeaf = first.leafId!;
    await first.dispose();
    const other = await open(h, { resumeFile: file });
    await other.prompt("remember the word mango");
    await other.dispose();
    const pinned = await open(h, { resumeFile: file, resumeLeafId: kiwiLeaf });
    await pinned.prompt("which word?");
    expect(h.seen()[2]).toContain("kiwi");
    expect(h.seen()[2]).not.toContain("mango");
    expect(readFileSync(file, "utf8")).toContain("mango");
  });

  it("rejects an unknown pinned leaf", async () => {
    const h = await harness(kind);
    h.script([{ text: "first" }]);
    const first = await open(h);
    await first.prompt("hello");
    const file = first.sessionFile;
    await first.dispose();
    await expect(h.runner.open({ ...h.spec, resumeFile: file, resumeLeafId: "no-such-entry" })).rejects.toThrow(/not found/);
  });

  it("dispose stops the child", async () => {
    const h = await harness(kind);
    h.script([{ text: "a" }]);
    const s = await open(h);
    await s.prompt("x");
    expect(s.alive).toBe(true);
    await s.dispose();
    expect(s.alive).toBe(false);
  });
});
