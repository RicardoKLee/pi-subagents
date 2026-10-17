import type { AgentDef } from "../agents.ts";
import type { Usage } from "../registry.ts";
import type { RunnerKind } from "../settings.ts";

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface ChildSpec {
  agent: AgentDef;
  cwd: string;
  /** Directory for child session files. */
  sessionDir: string;
  /** Existing child session file to continue (resume). */
  resumeFile?: string;
  appendSystemPrompt: string[];
}

export interface ChildResult {
  text: string;
  stopReason: StopReason;
  errorMessage?: string;
  /** Usage of this prompt only (delta), not the whole session. */
  usage: Usage;
}

export interface ChildSession {
  readonly sessionFile: string;
  /** Resolves when the child is idle after handling `text`. */
  prompt(text: string): Promise<ChildResult>;
  steer(text: string, mode: "steer" | "followUp"): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export interface Runner {
  readonly kind: RunnerKind;
  open(spec: ChildSpec): Promise<ChildSession>;
}
