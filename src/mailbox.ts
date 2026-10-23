import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * File mailbox for the child → parent direction of nested subagents (M6, plan 6.9 decision 1).
 *
 * A child session only ever writes a request file; the owning session's manager polls this directory, runs the
 * request through its single scheduler/registry, and writes a response file back. The parent → child direction never
 * uses the mailbox: pi's own RPC commands inject results directly. In-process SDK children bypass the mailbox too and
 * call the manager's host directly.
 */

/** A delegation request written by a child session. */
export interface MailboxRequest {
  /** Unique id of the request; it names both files (requests/<id>.json and responses/<id>.json). */
  id: string;
  /** Record id of the child session that asks. */
  parentRecordId: string;
  /** Raw tool input of the delegation tool (`action`, `agent`, `task`, `handle`, ...). */
  payload: Record<string, unknown>;
}

/** The owning session's answer to a `MailboxRequest`. */
export interface MailboxResponse {
  id: string;
  ok: boolean;
  text?: string;
  details?: unknown;
  error?: string;
  /** Record id of the child that asked; echoed so an unclaimed answer can still be attributed (REVIEW-034). */
  parentRecordId?: string;
}

/**
 * How long a child waits for its delegation before giving up, and how often each side looks for the other's file.
 * The delegation path (`mailboxHost`) never passes `timeoutMs`, so this default is also the longest a *real* client
 * can ever wait: a response file older than it can never be claimed, and is therefore safe to delete (REVIEW-034).
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLIENT_POLL_MS = 25;
/** The main process scans its mailbox at 200ms (plan 6.9 decision 1). */
const DEFAULT_SERVER_POLL_MS = 200;

/** Only ids the child itself generates (UUIDs) are accepted, so a hand-written file cannot name a path. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The two directories a mailbox is made of. */
export function mailboxPaths(dir: string): { requests: string; responses: string } {
  return { requests: join(dir, "requests"), responses: join(dir, "responses") };
}

/** Creates the mailbox directories (0700: the mailbox only ever holds this session's own delegations). */
export function ensureMailbox(dir: string): { requests: string; responses: string } {
  const paths = mailboxPaths(dir);
  mkdirSync(paths.requests, { recursive: true, mode: 0o700 });
  mkdirSync(paths.responses, { recursive: true, mode: 0o700 });
  return paths;
}

function isSafeId(id: unknown): id is string {
  return typeof id === "string" && SAFE_ID.test(id);
}

/**
 * Reads one request file. A malformed, truncated or unsafe file is dropped (undefined) rather than retried forever:
 * the mailbox must always make progress, even if a child died halfway through writing.
 */
function readRequest(file: string): MailboxRequest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MailboxRequest> | undefined;
    if (!parsed || !isSafeId(parsed.id) || typeof parsed.parentRecordId !== "string" || parsed.parentRecordId.length === 0) return undefined;
    if (typeof parsed.payload !== "object" || parsed.payload === null || Array.isArray(parsed.payload)) return undefined;
    return { id: parsed.id, parentRecordId: parsed.parentRecordId, payload: parsed.payload as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/** Reads one response file; an incomplete write simply yields undefined so the caller keeps polling. */
function readResponse(file: string): MailboxResponse | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MailboxResponse> | undefined;
    return parsed && typeof parsed.id === "string" && typeof parsed.ok === "boolean" ? (parsed as MailboxResponse) : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the requesting child's record id out of a stored response, for attributing an unclaimed one (REVIEW-034). */
function readResponseParent(file: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MailboxResponse> | undefined;
    return typeof parsed?.parentRecordId === "string" ? parsed.parentRecordId : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface MailboxClientOptions {
  /** How long to wait for the owning session's answer (default 30000ms). */
  timeoutMs?: number;
  /** How often to look for the response file (default 25ms). */
  pollMs?: number;
  /** Aborting ends the wait; the request and any response are still cleaned up. */
  signal?: AbortSignal;
}

/** Child side: writes the request, waits for the response file, then removes both files. */
export async function callViaMailbox(dir: string, req: MailboxRequest, opts: MailboxClientOptions = {}): Promise<MailboxResponse> {
  if (!isSafeId(req.id)) throw new Error(`invalid mailbox request id: ${JSON.stringify(req.id)}`);
  // Check before writing: an aborted call must not leave a request the parent would still answer.
  if (opts.signal?.aborted) throw new Error("delegation was aborted");
  const paths = ensureMailbox(dir);
  const requestFile = join(paths.requests, `${req.id}.json`);
  const responseFile = join(paths.responses, `${req.id}.json`);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_CLIENT_POLL_MS;
  writeFileSync(requestFile, JSON.stringify(req), { mode: 0o600 });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error("delegation was aborted");
      const response = readResponse(responseFile);
      if (response) return response;
      await sleep(pollMs);
    }
    throw new Error(`delegation timed out after ${timeoutMs}ms`);
  } finally {
    rmSync(requestFile, { force: true });
    rmSync(responseFile, { force: true });
  }
}

/** A path-free description of a mailbox failure, for the owning session's diagnostics (REVIEW-038). */
export interface MailboxErrorInfo {
  /** Request id the failure is tied to, when there is one. */
  id?: string;
  /** Record id of the child that wrote the request, when known. */
  parentRecordId?: string;
  /** Controlled text; never contains the mailbox directory. */
  message: string;
}

export interface MailboxServerOptions {
  /** How often `start()` scans the request directory (default 200ms). */
  pollMs?: number;
  /**
   * How long a response file nobody claimed may linger before it is discarded (default: the client wait cap).
   * The default is what production uses; tests inject a small value to observe the cleanup.
   */
  responseTtlMs?: number;
  /** Called once per distinct failure; the message never contains the mailbox path. */
  onError?: (info: MailboxErrorInfo) => void;
}

/**
 * Main side: scans the request directory, runs the handler (the manager's `delegate`), and writes one response per
 * request. `tick()` is the testable unit of work: it can be awaited directly instead of waiting for the interval.
 */
export class MailboxServer {
  private timer?: NodeJS.Timeout;
  private readonly paths: { requests: string; responses: string };
  /** Serializes scans so two overlapping ticks cannot handle the same request twice. */
  private scans: Promise<unknown> = Promise.resolve();
  /** Reasons already reported, so a repeated failure (a broken mailbox every tick) does not flood the caller. */
  private readonly reported = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly handler: (req: MailboxRequest) => Promise<MailboxResponse>,
    private readonly opts: MailboxServerOptions = {},
  ) {
    this.paths = ensureMailbox(dir);
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Starts polling. The timer is unref'd so an idle mailbox never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // `tick()` never rejects: every failure is reported through `onError`, so nothing is silently swallowed here
      // and no unhandled rejection can kill the poller (REVIEW-038).
      void this.tick();
    }, this.opts.pollMs ?? DEFAULT_SERVER_POLL_MS);
    this.timer.unref?.();
  }

  /** Stops polling; no further scan is scheduled. A scan already in flight is allowed to finish. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Runs one scan pass. Requests are chained: a tick that arrives while another is in flight waits for it, so the
   * files the first pass removed are already gone when the second looks. Returns how many files this pass dealt with
   * (requests handled plus junk removed).
   */
  tick(): Promise<number> {
    const next = this.scans.then(() => this.scan());
    // Even a catastrophic scan failure must resolve: the serialization chain and every caller stay non-throwing.
    this.scans = next.then(
      () => undefined,
      () => undefined,
    );
    return next.catch(() => {
      this.report("scan", "mailbox scan failed");
      return 0;
    });
  }

  private async scan(): Promise<number> {
    // Unclaimed responses are removed first: this is what keeps a slow handler from leaving a permanent orphan
    // when its client already timed out (REVIEW-034).
    this.expireResponses();
    let handled = 0;
    for (const file of this.listRequests()) {
      handled++;
      const filePath = join(this.paths.requests, file);
      // Every entry is processed in isolation: one directory or permission error must not abort the whole scan and
      // starve the requests behind it (REVIEW-035).
      try {
        // Anything that is not a request file is junk: remove it so the mailbox never accumulates it (review point 4).
        if (!file.endsWith(".json")) {
          rmSync(filePath, { force: true, recursive: true });
          continue;
        }
        const req = readRequest(filePath);
        // Remove before handling: the request is consumed exactly once even if the handler is slow or throws.
        rmSync(filePath, { force: true, recursive: true });
        if (!req) continue;
        let response: MailboxResponse;
        try {
          response = await this.handler(req);
        } catch (error) {
          response = { id: req.id, ok: false, error: errorMessage(error) };
        }
        try {
          writeFileSync(join(this.paths.responses, `${req.id}.json`), JSON.stringify(response), { mode: 0o600 });
        } catch {
          // A response that cannot be written is dropped; the child times out instead of hanging forever. The write
          // failure is reported (path-free) so the main process can see it (REVIEW-038).
          this.report("response-write", `could not write the mailbox response for ${req.id}`, req.id, req.parentRecordId);
        }
      } catch {
        this.report("entry", `could not process mailbox entry ${file}`);
      }
    }
    return handled;
  }

  /**
   * Deletes response files no client can still be waiting for. The client removes its own response as soon as it
   * reads it, so anything older than the wait cap belongs to a client that already timed out (REVIEW-034).
   */
  private expireResponses(): void {
    const ttl = this.opts.responseTtlMs ?? DEFAULT_TIMEOUT_MS;
    let names: string[];
    try {
      names = readdirSync(this.paths.responses);
    } catch {
      this.report("responses-readdir", "could not read the mailbox response directory");
      return;
    }
    const cutoff = Date.now() - ttl;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const filePath = join(this.paths.responses, name);
      try {
        // mtime is when the response was written; a client waits at most `ttl` from writing its request.
        if (statSync(filePath).mtimeMs > cutoff) continue;
        const id = name.slice(0, -5);
        const parentRecordId = readResponseParent(filePath);
        rmSync(filePath, { force: true, recursive: true });
        // The response was never read: surface it instead of discarding it silently (REVIEW-034/038).
        this.report("orphan-response", `discarded an unclaimed mailbox response for ${id}`, id, parentRecordId);
      } catch {
        // Best effort: anything not removable now is retried on the next scan.
      }
    }
  }

  /** Reports a distinct failure once; reporting itself must never break the mailbox. */
  private report(kind: string, message: string, id?: string, parentRecordId?: string): void {
    const key = `${kind}:${id ?? parentRecordId ?? ""}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    try {
      this.opts.onError?.({ message, ...(id ? { id } : {}), ...(parentRecordId ? { parentRecordId } : {}) });
    } catch {
      // The notifier must never turn a mailbox failure into an unhandled rejection.
    }
  }

  private listRequests(): string[] {
    try {
      return readdirSync(this.paths.requests).sort();
    } catch {
      // A missing or unreadable directory must not kill the poller; report it once and try again next scan.
      this.report("readdir", "could not read the mailbox request directory");
      return [];
    }
  }
}