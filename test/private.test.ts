import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { PrivateEntryData } from "../src/delivery.ts";
import { renderPrivateEntry } from "../src/private.ts";

// getMarkdownTheme() reads the process-wide theme; the renderer tests only need it to be initialised.
initTheme("system");

/** Stub theme: every colour helper returns its text, so the rendered lines stay comparable. */
const theme = new Proxy(
  {},
  {
    get: () => (first: string, second?: string) => (second === undefined ? first : second),
  },
) as unknown as Theme;

const data: PrivateEntryData = {
  handle: "reviewer",
  agent: "reviewer",
  status: "completed",
  summary: "结论：LGTM",
  text: "PROCESS-ONLY-BODY\n\nSession: /s/child.jsonl",
  sessionFile: "/s/child.jsonl",
};

const render = (entry: PrivateEntryData, expanded: boolean): string => renderPrivateEntry(entry, expanded, theme).render(100).join("\n");

describe("private entry renderer", () => {
  it("shows the conclusion and hides the full result until expanded", () => {
    const collapsed = render(data, false);
    expect(collapsed).toContain("@reviewer (reviewer)");
    expect(collapsed).toContain("结论：LGTM");
    expect(collapsed).not.toContain("PROCESS-ONLY-BODY");
    expect(collapsed).toContain("expand to show");
  });

  it("shows the full result when expanded", () => {
    const expanded = render(data, true);
    expect(expanded).toContain("PROCESS-ONLY-BODY");
    expect(expanded).toContain("Session: /s/child.jsonl");
    expect(expanded).not.toContain("expand to show");
  });

  it("keeps an entry without a summary visible (written before summaries existed)", () => {
    const legacy: PrivateEntryData = { ...data };
    delete legacy.summary;
    const collapsed = render(legacy, false);
    expect(collapsed).toContain("PROCESS-ONLY-BODY");
    expect(collapsed).not.toContain("expand to show");
  });

  it("renders markdown instead of the raw source", () => {
    const md: PrivateEntryData = { ...data, summary: "## 结论\n\n- 通过" };
    const collapsed = render(md, false);
    expect(collapsed).toContain("结论");
    expect(collapsed).toContain("通过");
    expect(collapsed).not.toContain("## 结论");
  });
});