import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { subagentPaths } from "../src/index.ts";

describe("subagentPaths", () => {
  it("keeps everything under the session directory when there is one", () => {
    expect(subagentPaths("/s/dir", "abc")).toEqual({
      childDir: join("/s/dir", "subagents"),
      outputDir: join("/s/dir", "subagents", "outputs"),
      snapshotFile: join("/s/dir", "abc.subagents.json"),
    });
  });

  it("uses a temp directory and no snapshot when the session has no directory", () => {
    const base = join(tmpdir(), "pi-subagents", "abc");
    const paths = subagentPaths("", "abc");
    expect(paths.childDir.startsWith(base)).toBe(true);
    expect(paths.outputDir.startsWith(base)).toBe(true);
    expect(paths.snapshotFile).toBeUndefined();
    expect(paths).toEqual({ childDir: join(base, "sessions"), outputDir: join(base, "outputs") });
  });
});
