import { readdirSync, readFileSync } from "node:fs";

/** Pids of live processes whose argv satisfies `match` (Linux /proc; zombies excluded). */
export function livePids(match: (args: string[]) => boolean): number[] {
  const pids: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (!args.length || !match(args)) continue;
      const state = readFileSync(`/proc/${name}/stat`, "utf8").split(") ").at(-1)?.[0];
      if (state !== "Z") pids.push(Number(name));
    } catch {
      // the process went away while we looked
    }
  }
  return pids;
}

/**
 * Pids of live direct children of this process whose argv is exactly `argv` (Linux /proc; zombies excluded).
 * Needed for real `pi` children: pi rewrites its cmdline, so the argv-based lookup cannot see them.
 */
export function childPids(argv: string[]): number[] {
  const wanted = argv.join("\0");
  const pids: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (args.join("\0") !== wanted) continue;
      // `pid (comm) state ppid ...` — parse after the last `) ` so a comm containing `) ` cannot shift the fields.
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      if (fields[0] === "Z" || Number(fields[1]) !== process.pid) continue;
      pids.push(Number(name));
    } catch {
      // the process went away while we looked
    }
  }
  return pids;
}

/** A unique argv tag for one fake child, plus a finder for live processes carrying it. */
export function procTag(): { args: string[]; live: () => number[] } {
  const tag = `gap-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return { args: ["--gap-tag", tag], live: () => livePids((a) => a.includes(tag)) };
}
