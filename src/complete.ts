import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";

export interface MentionCandidate {
  handle: string;
  agent: string;
  status: string;
  /** A file or directory with this name exists in the cwd, so only `@sub:<handle>` reaches the subagent. */
  clash: boolean;
}

/** `@` or `@sub:` plus a partial handle, at the start of the line, right before the cursor. */
const TOKEN = /^@(sub:)?([a-z0-9-]*)$/i;

/** Handle suggestions for the token before the cursor; undefined when there is no mention token or nothing matches. */
export function mentionItems(textBeforeCursor: string, candidates: readonly MentionCandidate[]): AutocompleteSuggestions | undefined {
  const match = TOKEN.exec(textBeforeCursor);
  if (!match) return undefined;
  const ns = Boolean(match[1]);
  const query = (match[2] ?? "").toLowerCase();
  const items: AutocompleteItem[] = candidates
    .filter((c) => c.handle.startsWith(query))
    .map((c) => {
      const value = ns || c.clash ? `@sub:${c.handle}` : `@${c.handle}`;
      return { value, label: value, description: `${c.agent} · ${c.status}` };
    });
  return items.length ? { items, prefix: textBeforeCursor } : undefined;
}

/** Wraps pi's provider: file suggestions stay first (files win), handle suggestions follow; `@sub:` shows handles only. */
export function mentionProvider(current: AutocompleteProvider, candidates: () => MentionCandidate[]): AutocompleteProvider {
  return {
    ...(current.triggerCharacters ? { triggerCharacters: current.triggerCharacters } : {}),
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const mine = cursorLine === 0 ? mentionItems((lines[0] ?? "").slice(0, cursorCol), candidates()) : undefined;
      if (mine && mine.prefix.startsWith("@sub:")) return mine;
      const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!mine) return base;
      if (!base) return mine;
      if (base.prefix !== mine.prefix) return base;
      return { prefix: base.prefix, items: [...base.items, ...mine.items] };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
