import type { ChainRecord } from "./chain.ts";
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

function chainCells(group: { chain: ChainRecord; index: number; steps: readonly SubagentRecord[] }, view: TreeView): string[] {
  const { chain, index, steps } = group;
  const total = steps.reduce((acc, r) => sum(acc, r.usage), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const label = `chain ${index + 1}`;
  if (view === "cost") return [label, ...usageCells(total)];
  const error = steps.find((r) => r.error)?.error?.split("\n")[0]!.slice(0, 60) ?? "";
  const progress = `step ${Math.min(chain.currentStep + 1, chain.steps.length)}/${chain.steps.length}`;
  return [label, `${chain.steps.length} steps`, progress, money(total.cost), error, `[${chain.status}]`];
}

/** pstree-style tree of subagents under the main session; chain steps are grouped under their chain header. */
export function renderTree(records: readonly SubagentRecord[], view: TreeView, chains: readonly ChainRecord[] = []): string {
  if (!records.length && !chains.length) return "No subagents yet.";
  const rows: { prefix: string; cells: string[] }[] = [];

  function pushNode(node: Node, indent: string, last: boolean): void {
    rows.push({ prefix: `${indent}${last ? "└─ " : "├─ "}`, cells: cells(node, view) });
    walkForest(node.children, `${indent}${last ? "   " : "│  "}`);
  }

  function walkForest(nodes: readonly Node[], indent: string): void {
    nodes.forEach((node, i) => pushNode(node, indent, i === nodes.length - 1));
  }

  // Steps of chains on this branch sit under their chain header; everything else keeps the parent/child forest.
  const groups = chains.map((chain, index) => ({
    chain,
    index,
    steps: records.filter((r) => r.chainId === chain.id).sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0)),
  }));
  const grouped = new Set(groups.flatMap((g) => g.steps.map((r) => r.id)));
  // A step whose chain is not on this branch (e.g. after /tree) stays visible as an ordinary root.
  const loose = records.filter((r) => !grouped.has(r.id) && !(r.chainId && chains.some((c) => c.id === r.chainId)));

  const entries = [
    ...forest(loose).map((node) => ({ at: node.record.createdAt, push: (last: boolean) => pushNode(node, "", last) })),
    ...groups.map((group) => ({
      at: group.chain.createdAt,
      push: (last: boolean) => {
        rows.push({ prefix: `${last ? "└─ " : "├─ "}`, cells: chainCells(group, view) });
        const inner = last ? "   " : "│  ";
        group.steps.forEach((step, i) => pushNode({ record: step, children: [] }, inner, i === group.steps.length - 1));
      },
    })),
  ].sort((a, b) => a.at - b.at);
  entries.forEach((entry, i) => entry.push(i === entries.length - 1));

  if (view === "cost") {
    const total = records.reduce((acc, r) => sum(acc, r.usage), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    rows.push({ prefix: "", cells: ["total", ...usageCells(total)] });
  }
  // Chain headers carry more columns (progress) than plain rows; pad to the widest row.
  const columns = Math.max(...rows.map((row) => row.cells.length));
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
