const RESERVED = new Set(["main"]);

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Returns a lowercase handle not in `taken` and never a reserved name. */
export function allocateHandle(preferred: string, taken: ReadonlySet<string>): string {
  const slug = slugify(preferred) || "agent";
  if (!taken.has(slug) && !RESERVED.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
