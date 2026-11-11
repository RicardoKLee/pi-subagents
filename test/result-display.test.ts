import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { PRIVATE_ENTRY_TYPE, type PrivateEntryData } from "../src/delivery.ts";
import { boot } from "./boot.ts";
import { cleanupTempDirs } from "./tmp.ts";

// getMarkdownTheme() reads the process-wide theme; the renderer tests only need it to be initialised.
initTheme("system");

afterAll(cleanupTempDirs);

/** Stub theme: every colour helper returns its text, so the rendered lines stay comparable. */
const theme = new Proxy(
  {},
  {
    get: () => (first: string, second?: string) => (second === undefined ? first : second),
  },
) as unknown as Theme;

/** More lines than the tool card shows while collapsed. */
const LONG_RESULT = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

const privateData: PrivateEntryData = {
  handle: "reviewer",
  agent: "reviewer",
  status: "completed",
  summary: "结论：LGTM",
  text: "PROCESS-ONLY-BODY\n\nSession: /s/child.jsonl",
  sessionFile: "/s/child.jsonl",
};

const renderPrivate = async (settings: Record<string, unknown>, expanded: boolean): Promise<string> => {
  const { pi } = await boot({ settings });
  const renderer = pi.entryRenderers.get(PRIVATE_ENTRY_TYPE)!;
  const entry = { type: "custom", customType: PRIVATE_ENTRY_TYPE, id: "e1", data: privateData };
  return renderer(entry, { expanded, outputPad: 1, keyText: () => "", keyHint: () => "" }, theme).render(100).join("\n");
};

const renderToolResult = async (settings: Record<string, unknown>, expanded: boolean): Promise<string> => {
  const { pi } = await boot({ settings });
  const renderer = pi.tools.get("subagents").renderResult;
  const result = { content: [{ type: "text", text: LONG_RESULT }], details: {} };
  const context = { keyHint: (_id: string, description: string) => `ctrl+o ${description}` };
  return renderer(result, { expanded, isPartial: false }, theme, context).render(100).join("\n");
};

describe("expandResults", () => {
  it("shows the full private result without expanding when on", async () => {
    const view = await renderPrivate({ expandResults: true }, false);
    expect(view).toContain("PROCESS-ONLY-BODY");
    expect(view).not.toContain("expand to show");
  });

  it("shows the full tool result without expanding when on", async () => {
    const view = await renderToolResult({ expandResults: true }, false);
    expect(view).toContain("line 20");
    expect(view).not.toContain("more lines");
  });

  it("keeps the conclusion-only private entry and the 10-line preview when off", async () => {
    const entry = await renderPrivate({}, false);
    expect(entry).toContain("结论：LGTM");
    expect(entry).not.toContain("PROCESS-ONLY-BODY");
    const tool = await renderToolResult({}, false);
    expect(tool).toContain("line 10");
    expect(tool).not.toContain("line 11");
    expect(tool).toContain("10 more lines");
  });

  it("still expands on request when off", async () => {
    expect(await renderPrivate({}, true)).toContain("PROCESS-ONLY-BODY");
    expect(await renderToolResult({}, true)).toContain("line 20");
  });
});