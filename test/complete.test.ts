import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type MentionCandidate, mentionItems, mentionProvider } from "../src/complete.ts";

const candidates: MentionCandidate[] = [
  { handle: "reviewer", agent: "reviewer", status: "completed", clash: false },
  { handle: "reviewer-2", agent: "reviewer", status: "running", clash: false },
  { handle: "test", agent: "test", status: "paused", clash: true },
];

describe("mentionItems", () => {
  it("offers bare handles for @ and namespaced ones for @sub:", () => {
    expect(mentionItems("@rev", candidates)).toEqual({
      prefix: "@rev",
      items: [
        { value: "@reviewer", label: "@reviewer", description: "reviewer · completed" },
        { value: "@reviewer-2", label: "@reviewer-2", description: "reviewer · running" },
      ],
    });
    expect(mentionItems("@sub:te", candidates)).toEqual({
      prefix: "@sub:te",
      items: [{ value: "@sub:test", label: "@sub:test", description: "test · paused" }],
    });
  });

  it("offers only the @sub: form for a handle that clashes with a file", () => {
    expect(mentionItems("@te", candidates)?.items).toEqual([{ value: "@sub:test", label: "@sub:test", description: "test · paused" }]);
  });

  it("only completes a mention at the start of the line", () => {
    expect(mentionItems("hi @rev", candidates)).toBeUndefined();
    expect(mentionItems(" @rev", candidates)).toBeUndefined();
    expect(mentionItems("@reviewer again", candidates)).toBeUndefined();
    expect(mentionItems("@nothing", candidates)).toBeUndefined();
  });

  it("shows the nesting path in the description", () => {
    const nested: MentionCandidate[] = [{ handle: "scout", agent: "scout", status: "running", clash: false, path: "reviewer/scout" }];
    expect(mentionItems("@sc", nested)).toEqual({
      prefix: "@sc",
      items: [{ value: "@scout", label: "@scout", description: "scout · running · reviewer/scout" }],
    });
  });
});

function baseProvider(items: { value: string; label: string }[] | null): AutocompleteProvider {
  return {
    triggerCharacters: ["#"],
    getSuggestions: async (lines, _line, col) => (items ? { items, prefix: (lines[0] ?? "").slice(0, col) } : null),
    applyCompletion: (lines, line, col, item, prefix) => ({ lines: [`${item.value} `], cursorLine: line, cursorCol: col - prefix.length + item.value.length + 1 }),
  };
}

const signal = new AbortController().signal;

describe("mentionProvider", () => {
  it("keeps file suggestions first and adds handles after them", async () => {
    const provider = mentionProvider(baseProvider([{ value: "@reviewer.md", label: "reviewer.md" }]), () => candidates);
    const result = await provider.getSuggestions(["@rev"], 0, 4, { signal });
    expect(result?.items.map((i) => i.value)).toEqual(["@reviewer.md", "@reviewer", "@reviewer-2"]);
    expect(result?.prefix).toBe("@rev");
  });

  it("shows only handles after @sub:", async () => {
    const provider = mentionProvider(baseProvider([{ value: "@sub:file", label: "sub:file" }]), () => candidates);
    const result = await provider.getSuggestions(["@sub:re"], 0, 7, { signal });
    expect(result?.items.map((i) => i.value)).toEqual(["@sub:reviewer", "@sub:reviewer-2"]);
  });

  it("leaves other input to the wrapped provider", async () => {
    const provider = mentionProvider(baseProvider([{ value: "/model", label: "model" }]), () => candidates);
    const result = await provider.getSuggestions(["/mo"], 0, 3, { signal });
    expect(result?.items.map((i) => i.value)).toEqual(["/model"]);
    expect(provider.triggerCharacters).toEqual(["#"]);
  });

  it("returns handles when the wrapped provider has nothing", async () => {
    const provider = mentionProvider(baseProvider(null), () => candidates);
    const result = await provider.getSuggestions(["@rev"], 0, 4, { signal });
    expect(result?.items.map((i) => i.value)).toEqual(["@reviewer", "@reviewer-2"]);
  });
});
