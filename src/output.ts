import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SUMMARY_INSTRUCTION =
  "When you finish, end your final answer with a concise summary of the outcome wrapped in <summary></summary> tags (at most 150 words).";

const SUMMARY_FALLBACK_CHARS = 1200;

/** Cheap estimate; good enough for a 30% threshold. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function extractSummary(text: string): { body: string; summary?: string } {
  const match = text.match(/<summary>([\s\S]*?)<\/summary>\s*$/);
  if (!match) return { body: text };
  return { body: text.slice(0, match.index).trimEnd(), summary: match[1]!.trim() };
}

export interface Payload {
  /** What the receiving agent gets. */
  text: string;
  /** Set when the full output was written to a file. */
  filePath?: string;
  summary: string;
}

export function preparePayload(opts: {
  text: string;
  receiverContextWindow: number;
  ratio: number;
  outputDir: string;
  label: string;
}): Payload {
  const { body, summary } = extractSummary(opts.text);
  const shortSummary = summary ?? body.slice(0, SUMMARY_FALLBACK_CHARS);
  if (estimateTokens(body) <= opts.receiverContextWindow * opts.ratio) {
    return { text: opts.text, summary: shortSummary };
  }
  mkdirSync(opts.outputDir, { recursive: true, mode: 0o700 });
  const safe = opts.label.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const filePath = join(opts.outputDir, `${safe}-${Date.now()}.md`);
  writeFileSync(filePath, body, { mode: 0o600 });
  return {
    text: `Summary:\n${shortSummary}\n\nFull output (${estimateTokens(body)} tokens) saved to ${filePath}. Read it if you need details.`,
    filePath,
    summary: shortSummary,
  };
}
