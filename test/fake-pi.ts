import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

/** Minimal stand-in for ExtensionAPI: records registrations and mirrors appendEntry into `branch`. */
export class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, any>();
  readonly commands = new Map<string, any>();
  readonly entryRenderers = new Map<string, any>();
  /** Registered keyboard shortcuts, keyed by their key id. */
  readonly shortcuts = new Map<string, { description?: string; handler: (ctx: ExtensionContext) => unknown }>();
  readonly sent: { message: any; options: any }[] = [];
  /** Every `pi.events.emit()` call, in order. */
  readonly events: { channel: string; data: unknown }[] = [];
  readonly branch: unknown[] = [];
  /** When set, sendMessage throws this error (simulates a failing delivery port). */
  failSend?: Error;

  asApi(): ExtensionAPI {
    const api = {
      on: (event: string, handler: Handler) => {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
        return () => {};
      },
      registerTool: (tool: any) => void this.tools.set(tool.name, tool),
      registerCommand: (name: string, options: any) => void this.commands.set(name, { name, ...options }),
      registerEntryRenderer: (type: string, renderer: any) => void this.entryRenderers.set(type, renderer),
      registerShortcut: (shortcut: string, options: any) => void this.shortcuts.set(shortcut, options),
      events: {
        emit: (channel: string, data: unknown) => void this.events.push({ channel, data }),
        on: () => () => {},
      },
      appendEntry: (customType: string, data: unknown) => void this.branch.push({ type: "custom", customType, data }),
      sendMessage: (message: any, options: any) => {
        if (this.failSend) throw this.failSend;
        this.sent.push({ message, options });
      },
    };
    return api as unknown as ExtensionAPI;
  }

  /** Calls every handler for `event` in order and returns their results. */
  async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  }
}

export interface FakeCtxOptions {
  cwd: string;
  sessionDir: string;
  sessionId?: string;
  hasUI?: boolean;
  /** Model of the main session; `find` is what `modelRegistry.find` returns. */
  model?: { provider: string; id: string };
  find?: (provider: string, id: string) => unknown;
  /** Project trust reported to the extension; absent means "not asked" (`isProjectTrusted` is left off). */
  projectTrusted?: boolean;
  /** What `ctx.isIdle()` answers; default true (the main agent has its turn back). */
  idle?: boolean;
}

/** ExtensionContext stand-in whose session branch is `pi.branch`; notify calls and autocomplete factories are recorded. */
export function fakeCtx(pi: FakePi, opts: FakeCtxOptions) {
  const notes: { message: string; type?: string }[] = [];
  const providers: unknown[] = [];
  const aborts: number[] = [];
  const ui = {
    notify: (message: string, type?: string) => void notes.push({ message, type }),
    addAutocompleteProvider: (factory: unknown) => void providers.push(factory),
  };
  const ctx = {
    ui,
    hasUI: opts.hasUI ?? true,
    cwd: opts.cwd,
    model: opts.model,
    modelRegistry: { find: (provider: string, id: string) => opts.find?.(provider, id) },
    isIdle: () => opts.idle ?? true,
    abort: () => void aborts.push(1),
    sessionManager: {
      getBranch: () => pi.branch,
      getSessionDir: () => opts.sessionDir,
      getSessionId: () => opts.sessionId ?? "main-session",
    },
    ...(opts.projectTrusted === undefined ? {} : { isProjectTrusted: () => opts.projectTrusted }),
  } as unknown as ExtensionContext;
  return { ctx, notes, providers, aborts };
}
