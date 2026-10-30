import { getMarkdownTheme, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import type { PrivateEntryData } from "./delivery.ts";
import type { RunStatus } from "./registry.ts";

/** Colour of the status in the header; queued/running never reach a delivered private entry. */
function statusColor(status: RunStatus): ThemeColor {
  if (status === "failed") return "error";
  if (status === "paused") return "warning";
  if (status === "completed") return "success";
  return "muted";
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

/**
 * A private result is a TUI-only custom entry. The conclusion is what the user reads, so it stays open; the full
 * result (the process, quoted questions and paths) is revealed by expanding the entry. An entry written before
 * `summary` existed has no conclusion to separate and keeps its full text visible.
 */
export function renderPrivateEntry(data: PrivateEntryData, expanded: boolean, theme: Theme) {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(
    new Text(
      `${theme.fg("accent", "[subagent private]")} @${data.handle} (${data.agent}) · ${theme.fg(statusColor(data.status), data.status)}`,
      0,
      0,
    ),
  );
  const mdTheme = getMarkdownTheme();
  if (expanded || data.summary === undefined) {
    box.addChild(new Markdown(data.text, 0, 0, mdTheme));
    return box;
  }
  box.addChild(new Markdown(data.summary, 0, 0, mdTheme));
  box.addChild(new Text(theme.fg("dim", `… full result hidden (${lineCount(data.text)} lines) — expand to show`), 0, 0));
  return box;
}