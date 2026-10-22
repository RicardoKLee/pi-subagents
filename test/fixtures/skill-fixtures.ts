import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A skill in the layout pi discovers: <root>/skills/<name>/SKILL.md with a frontmatter name. */
export function writeSkill(root: string, name: string, body = "Do the thing."): void {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
}

/** A prompt template in the layout pi discovers: <root>/prompts/<name>.md. */
export function writeTemplate(root: string, name: string, content = "Template body: $ARGUMENTS"): void {
  const dir = join(root, "prompts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content);
}
