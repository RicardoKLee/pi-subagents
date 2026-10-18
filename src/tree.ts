import type { SubagentRecord, Usage } from "./registry.ts";

export type TreeView = "list" | "cost";
export const TREE_ENTRY_TYPE = "pi-subagents/tree";

/** Data of a `pi-subagents/tree` custom entry (display only, never part of the LLM context). */
export interface TreeEntryData {
  view: TreeView;
  text: string;
}

interface Node {
  record: SubagentRecord;
  children: Node[];
}

const money = (cost: number) => `$${cost.toFixed(4)}`;

function sum(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost + b.cost };
}

function subtree(node: Node): Usage {
  return node.children.reduce((acc, child) => sum(acc, subtree(child)), node.record.usage);
}

/** True when following parentId from `id` leads back to `id` (a corrupt registry); such records are shown as roots. */
function inCycle(id: string, parentOf: Map<string, string | undefined>): boolean {
  const seen = new Set<string>();
  for (let cur = parentOf.get(id); cur !== undefined && parentOf.has(cur); cur = parentOf.get(cur)) {
    if (cur === id) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
  }
  return false;
}

function forest(records: readonly SubagentRecord[]): Node[] {
  const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt);
  const nodes = new Map(sorted.map((r) => [r.id, { record: r, children: [] as Node[] }]));
  const roots: Node[] = [];
  const parentOf = new Map(sorted.map((r) => [r.id, r.parentId]));
  for (const node of nodes.values()) {
    const parent = node.record.parentId && !inCycle(node.record.id, parentOf) ? nodes.get(node.record.parentId) : undefined;
    // Records whose parent is not on this branch are shown as roots rather than dropped.
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

function usageCells(u: Usage): string[] {
  return [`in ${u.input}`, `out ${u.output}`, `cache r${u.cacheRead} w${u.cacheWrite}`, money(u.cost)];
}

function cells(node: Node, view: TreeView): string[] {
  const r = node.record;
  if (view === "cost") return [`@${r.handle}`, ...usageCells(r.usage)];
  const cost = node.children.length ? `${money(r.usage.cost)} (subtree ${money(subtree(node).cost)})` : money(r.usage.cost);
  const error = r.error ? r.error.split("\n")[0]!.slice(0, 60) : "";
  return [`@${r.handle}`, r.agent, `run ${r.runId}`, cost, error, `[${r.status}]`];
}

/** pstree-style tree of subagents under the main session; columns are padded so statuses line up. */
export function renderTree(records: readonly SubagentRecord[], view: TreeView): string {
  if (!records.length) return "No subagents yet.";
  const rows: { prefix: string; cells: string[] }[] = [];
  const walk = (nodes: Node[], indent: string) => {
    nodes.forEach((node, i) => {
      const last = i === nodes.length - 1;
      rows.push({ prefix: `${indent}${last ? "└─ " : "├─ "}`, cells: cells(node, view) });
      walk(node.children, `${indent}${last ? "   " : "│  "}`);
    });
  };
  const roots = forest(records);
  walk(roots, "");
  if (view === "cost") {
    const total = roots.reduce((acc, n) => sum(acc, subtree(n)), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    rows.push({ prefix: "", cells: ["total", ...usageCells(total)] });
  }
  const columns = rows[0]!.cells.length;
  // Drop columns that are empty on every row (e.g. no record has an error).
  const used = [...Array(columns).keys()].filter((c) => rows.some((row) => row.cells[c]));
  // widths[k] belongs to column used[k]; the first column's width includes the tree prefix.
  const widths = used.map((c) => Math.max(...rows.map((row) => (c === 0 ? row.prefix.length : 0) + (row.cells[c] ?? "").length)));
  const lines = rows.map((row) =>
    used
      .map((c, k) => {
        const text = c === 0 ? `${row.prefix}${row.cells[c]}` : (row.cells[c] ?? "");
        return k === used.length - 1 ? text : text.padEnd(widths[k]!);
      })
      .join("  "),
  );
  return ["main", ...lines].join("\n");
}
