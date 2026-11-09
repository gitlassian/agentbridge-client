/**
 * Adds and removes agentbridge's hooks in Claude Code settings files without touching anything
 * else in them.
 *
 * Every hook we add carries the marker comment below, which is how we recognise our own entries
 * later. Hooks that were there before are never modified, reordered or removed. Claude Code
 * merges hooks from all settings files, so ours sit next to the user's own.
 */

import type { Harness } from "../../hooks/harness.ts";
import { CliError } from "../../io.ts";

/** Trailing shell comment on every command we add. */
export const MARKER = "# agentbridge-managed";

/** The Claude Code events we hook into, and the `agentbridge hook` argument for each. */
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const EVENT_ARGUMENT: Record<HookEvent, string> = {
  SessionStart: "session-start",
  UserPromptSubmit: "prompt",
  PostToolUse: "tool",
  Stop: "stop",
};

/** Claude Code's own limit for a hook, in seconds. Our hooks answer much faster than this. */
export const HOOK_TIMEOUT_SECONDS = 5;

/**
 * The wake hook: a second, background handler on `Stop`. It keeps listening to the board after
 * the agent stops and wakes the agent (Claude Code's `asyncRewake`, exit code 2) when something
 * is addressed to it. It ends by itself well before this limit.
 */
export const WAKE_ARGUMENT = "wake";

/** Room for the largest batch of messages a hook adds (about 9,000 characters). */
export const CODEX_CONTEXT_TOKENS = 4000;
export const WAKE_TIMEOUT_SECONDS = 3600;

export type Settings = Record<string, unknown>;

type Handler = Record<string, unknown>;
type Group = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isManaged(handler: unknown): boolean {
  return (
    isObject(handler) && typeof handler.command === "string" && handler.command.includes(MARKER)
  );
}

/** Codex's hooks say which tool they belong to; Claude Code's keep the original form. */
const toolFlag = (harness: Harness) => (harness === "claude" ? "" : ` --tool ${harness}`);

export function hookCommand(
  command: string,
  event: HookEvent,
  harness: Harness = "claude",
): string {
  return `${command} hook ${EVENT_ARGUMENT[event]}${toolFlag(harness)} ${MARKER}`;
}

export function wakeCommand(command: string, harness: Harness = "claude"): string {
  return `${command} hook ${WAKE_ARGUMENT}${toolFlag(harness)} ${MARKER}`;
}

function isWake(handler: unknown): boolean {
  return (
    isManaged(handler) &&
    ((handler as Handler).asyncRewake === true || (handler as Handler).async === true) &&
    String((handler as Handler).command).includes(` hook ${WAKE_ARGUMENT} `)
  );
}

/** The handlers we want under one event. */
function wantedHandlers(
  event: HookEvent,
  command: string,
  events: readonly HookEvent[],
  wake: boolean,
  harness: Harness,
): Handler[] {
  const handlers: Handler[] = [];
  if (events.includes(event)) {
    handlers.push({
      type: "command",
      command: hookCommand(command, event, harness),
      timeout: HOOK_TIMEOUT_SECONDS,
      // Codex moves added context over 2,500 tokens to a file; a batch of messages can be longer.
      ...(harness === "codex" ? { additionalContextLimit: CODEX_CONTEXT_TOKENS } : {}),
    });
  }
  if (wake && event === "Stop") {
    handlers.push({
      type: "command",
      command: wakeCommand(command, harness),
      // Claude Code wakes the agent when this hook exits with code 2; Codex runs it in the
      // background and the hook itself queues the messages in the session (`codex queue`).
      ...(harness === "claude" ? { asyncRewake: true } : { async: true }),
      timeout: WAKE_TIMEOUT_SECONDS,
    });
  }
  return handlers;
}

/** The hook groups of one event. Anything that does not look like a settings file is an error. */
function groupsOf(hooks: Record<string, unknown>, event: string, file: string): unknown[] {
  const value = hooks[event];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new CliError(`"hooks.${event}" in ${file} is not a list.`, {
      hint: "Fix the file by hand; agentbridge did not change it.",
    });
  }
  return value;
}

function hooksOf(settings: Settings, file: string): Record<string, unknown> {
  const value = settings.hooks;
  if (value === undefined) return {};
  if (!isObject(value)) {
    throw new CliError(`"hooks" in ${file} is not an object.`, {
      hint: "Fix the file by hand; agentbridge did not change it.",
    });
  }
  return value;
}

/** Removes our handlers from a list of groups. Groups that only held ours are dropped. */
function withoutManaged(groups: unknown[]): { groups: unknown[]; removed: number } {
  let removed = 0;
  const kept: unknown[] = [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const handlers = group.hooks as Handler[];
    const remaining = handlers.filter((handler) => !isManaged(handler));
    removed += handlers.length - remaining.length;
    if (remaining.length === handlers.length) kept.push(group);
    else if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
  }
  return { groups: kept, removed };
}

export interface InstallResult {
  settings: Settings;
  /** The events whose hooks are new or were updated. */
  changedEvents: HookEvent[];
}

/**
 * Returns settings with our hooks for `events` added, plus the background wake hook on `Stop`
 * unless `wake` is false. Running it again changes nothing. Existing agentbridge entries are
 * replaced in the position they already had.
 */
export function applyInstall(
  settings: Settings,
  options: {
    command: string;
    events: readonly HookEvent[];
    file: string;
    wake?: boolean;
    harness?: Harness;
  },
): InstallResult {
  const next = structuredClone(settings);
  const hooks = hooksOf(next, options.file);
  const changedEvents: HookEvent[] = [];
  const wake = options.wake ?? true;

  for (const event of HOOK_EVENTS) {
    const wanted = wantedHandlers(
      event,
      options.command,
      options.events,
      wake,
      options.harness ?? "claude",
    );
    if (wanted.length === 0) continue;
    const before = groupsOf(hooks, event, options.file);

    // Replace our first entry in place, drop the rest of ours, or append if there were none.
    let placed = false;
    const after: unknown[] = [];
    for (const group of before) {
      if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(isManaged)) {
        after.push(group);
        continue;
      }
      const handlers: Handler[] = [];
      for (const handler of group.hooks as Handler[]) {
        if (!isManaged(handler)) handlers.push(handler);
        else if (!placed) {
          handlers.push(...wanted);
          placed = true;
        }
      }
      // A group that only held a duplicate of ours disappears instead of staying empty.
      if (handlers.length > 0) after.push({ ...group, hooks: handlers });
    }
    if (!placed) after.push({ hooks: wanted } satisfies Group);

    if (JSON.stringify(before) !== JSON.stringify(after)) changedEvents.push(event);
    hooks[event] = after;
  }

  next.hooks = hooks;
  return { settings: next, changedEvents };
}

export interface UninstallResult {
  settings: Settings;
  /** How many of our hook entries were removed. */
  removed: number;
}

/** Returns settings without any of our hooks. Everything else is left exactly as it was. */
export function applyUninstall(settings: Settings, file: string): UninstallResult {
  const next = structuredClone(settings);
  if (next.hooks === undefined) return { settings: next, removed: 0 };
  const hooks = hooksOf(next, file);

  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const result = withoutManaged(groupsOf(hooks, event, file));
    removed += result.removed;
    if (result.removed === 0) continue;
    if (result.groups.length === 0) delete hooks[event];
    else hooks[event] = result.groups;
  }
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return { settings: next, removed };
}

/** True when the background wake hook is in the settings. */
export function wakeInstalled(settings: Settings): boolean {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const groups = hooks.Stop;
  return (
    Array.isArray(groups) &&
    groups.some(
      (group) => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isWake),
    )
  );
}

/** Which of our events are present in the settings. */
export function installedEvents(settings: Settings): HookEvent[] {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  return HOOK_EVENTS.filter((event) => {
    const groups = hooks[event];
    return (
      Array.isArray(groups) &&
      groups.some(
        (group) => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isManaged),
      )
    );
  });
}
