import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SUMMARY_INSTRUCTION =
  "When you finish, end your final answer with a concise summary of the outcome wrapped in <summary></summary> tags (at most 150 words).";

const SUMMARY_FALLBACK_CHARS = 1200;

const SUMMARY_OPEN = "<summary>";
const SUMMARY_CLOSE = "</summary>";

/**
 * Cheap estimate; good enough for a 30% threshold.
 * ASCII: ~4 chars per token (rounded up). Non-ASCII (e.g. CJK): 1 token per code point.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

/** Only the last <summary> tag counts, and its closing tag must be followed by whitespace only. */
export function extractSummary(text: string): { body: string; summary?: string } {
  const open = text.lastIndexOf(SUMMARY_OPEN);
  if (open === -1) return { body: text };
  const contentStart = open + SUMMARY_OPEN.length;
  const close = text.indexOf(SUMMARY_CLOSE, contentStart);
  if (close === -1) return { body: text };
  if (text.slice(close + SUMMARY_CLOSE.length).trim() !== "") return { body: text };
  return { body: text.slice(0, open).trimEnd(), summary: text.slice(contentStart, close).trim() };
}

export interface Payload {
  /** What the receiving agent gets. */
  text: string;
  /** Set when the full output was written to a file. */
  filePath?: string;
  summary: string;
}

/**
 * Line that replaces an oversized body.
 * - `detail` is for a model reading the tool result directly (keeps the token count).
 * - `path` is for a batch consumer (chain `{previous}`, group summary): summary + paths only.
 */
export type OutputStyle = "detail" | "path";

/** Writes the full output to a new file under `outputDir` and returns its path (never overwrites). */
export function writeOutput(text: string, opts: { outputDir: string; label: string }): string {
  mkdirSync(opts.outputDir, { recursive: true, mode: 0o700 });
  const safe = opts.label.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const filePath = join(opts.outputDir, `${safe}-${Date.now()}-${randomUUID()}.md`);
  // "wx" fails instead of silently overwriting an existing file.
  writeFileSync(filePath, text, { mode: 0o600, flag: "wx" });
  return filePath;
}

export function preparePayload(opts: {
  text: string;
  receiverContextWindow: number;
  ratio: number;
  outputDir: string;
  label: string;
  style?: OutputStyle;
}): Payload {
  const { body, summary } = extractSummary(opts.text);
  // An empty <summary></summary> is treated like a missing one.
  const shortSummary = summary || body.slice(0, SUMMARY_FALLBACK_CHARS);
  if (estimateTokens(body) <= opts.receiverContextWindow * opts.ratio) {
    return { text: opts.text, summary: shortSummary };
  }
  const filePath = writeOutput(body, { outputDir: opts.outputDir, label: opts.label });
  const text =
    opts.style === "path"
      ? `Summary:\n${shortSummary}\n\nFull output: ${filePath}`
      : `Summary:\n${shortSummary}\n\nFull output (${estimateTokens(body)} tokens) saved to ${filePath}. Read it if you need details.`;
  return { text, filePath, summary: shortSummary };
}
