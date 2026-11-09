import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configDir, findRepoConfig } from "../../config.ts";
import type { Harness } from "../../hooks/harness.ts";
import { CliError } from "../../io.ts";
import {
  applyInstall,
  applyUninstall,
  HOOK_EVENTS,
  type HookEvent,
  installedEvents,
  type Settings,
  wakeInstalled,
} from "./settings.ts";

/**
 * Where hooks go.
 *   project: <repo>/.claude/settings.local.json   personal, not committed (the default)
 *   shared:  <repo>/.claude/settings.json         committed, so every teammate gets the hooks
 *   user:    ~/.claude/settings.json              every project of this user
 */
export type Scope = "project" | "shared" | "user";

export const SCOPES: readonly Scope[] = ["project", "shared", "user"];

export function settingsFile(scope: Scope, repoRoot: string, home: string): string {
  if (scope === "user") return join(home, ".claude", "settings.json");
  return join(repoRoot, ".claude", scope === "shared" ? "settings.json" : "settings.local.json");
}

/** The directory the repository's settings belong to: where .agentbridge.json is, or `cwd`. */
export async function repoRoot(cwd: string): Promise<{ root: string; connected: boolean }> {
  const found = await findRepoConfig(cwd);
  return found ? { root: found.dir, connected: true } : { root: cwd, connected: false };
}

const homeOf = (env: NodeJS.ProcessEnv) => env.HOME ?? homedir();

/** Codex's own directory: $CODEX_HOME, or ~/.codex. */
export function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || join(homeOf(env), ".codex");
}

/** Codex reads hooks from this file, in the same format as Claude Code's settings. */
export function codexHooksFile(env: NodeJS.ProcessEnv): string {
  return join(codexHome(env), "hooks.json");
}

/** The file a scope means, or Codex's hooks file for Codex. */
async function targetFile(
  env: NodeJS.ProcessEnv,
  cwd: string,
  scope: Scope,
  harness: Harness,
): Promise<{ file: string; root: string }> {
  if (harness === "codex") return { file: codexHooksFile(env), root: cwd };
  const { root } = await repoRoot(cwd);
  return { file: settingsFile(scope, root, homeOf(env)), root };
}

// ---------------------------------------------------------------------------- manifest

interface Manifest {
  files: Record<
    string,
    {
      /** Backup of the file as it was before agentbridge, or null if the file did not exist. */
      original: string | null;
      firstInstalledAt: string;
    }
  >;
}

const manifestPath = (env: NodeJS.ProcessEnv) => join(configDir(env), "claude-code-installs.json");

async function readManifest(env: NodeJS.ProcessEnv): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(env), "utf8")) as Manifest;
    return parsed.files ? parsed : { files: {} };
  } catch {
    return { files: {} };
  }
}

async function writeManifest(env: NodeJS.ProcessEnv, manifest: Manifest): Promise<void> {
  const path = manifestPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

// ------------------------------------------------------------------------------- files

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseSettings(text: string | null, file: string): Settings {
  if (text === null || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(`${file} is not valid JSON, so agentbridge did not touch it.`, {
      hint: "Fix the file (comments are not allowed in JSON) and run the command again.",
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${file} does not contain a JSON object, so agentbridge did not touch it.`);
  }
  return parsed as Settings;
}

/** Keeps the file's own indentation so the diff stays small. */
function serialize(settings: Settings, previous: string | null): string {
  const indent = previous?.match(/^([ \t]+)"/m)?.[1] ?? "  ";
  return `${JSON.stringify(settings, null, indent)}\n`;
}

export async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.agentbridge-${process.pid}.tmp`;
  await writeFile(temp, content, { mode });
  await rename(temp, path);
}

const stamp = () =>
  new Date().toISOString().replace(/[-:]/g, "").replace(".", "-").replace("Z", "");

/**
 * Copies `path` into the backups folder (outside any repository) and returns the copy's path.
 * A backup is never overwritten: if the name is taken, a number is added.
 */
export async function backup(env: NodeJS.ProcessEnv, path: string): Promise<string> {
  const dir = join(configDir(env), "backups");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const base = `${stamp()}-${path.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
  for (let attempt = 0; ; attempt++) {
    const target = join(dir, attempt === 0 ? base : `${base}.${attempt}`);
    try {
      await copyFile(path, target, constants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** Makes sure a personal settings file we created by hand is not committed by accident. */
async function ignoreInGit(root: string): Promise<boolean> {
  const hasGit = await stat(join(root, ".git")).then(
    () => true,
    () => false,
  );
  if (!hasGit) return false;

  const path = join(root, ".gitignore");
  const current = (await readText(path)) ?? "";
  const covered = current
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) =>
      [
        ".claude/settings.local.json",
        "/.claude/settings.local.json",
        ".claude/*.local.json",
        "**/.claude/settings.local.json",
      ].includes(line),
    );
  if (covered) return false;

  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await writeFile(
    path,
    `${current}${separator}\n# Claude Code personal settings (agentbridge adds its hooks here)\n.claude/settings.local.json\n`,
  );
  return true;
}

// ---------------------------------------------------------------------------- install

export interface InstallReport {
  file: string;
  /** The settings file did not exist and was created. */
  created: boolean;
  /** Our hooks were already there, unchanged. */
  alreadyInstalled: boolean;
  events: HookEvent[];
  /** The background hook that wakes an idle agent when a message arrives is installed. */
  wake: boolean;
  /** Copy of the file as it was just before this change (null if it did not exist). */
  backup: string | null;
  /** Copy of the file as it was before agentbridge was ever installed in it (null if none existed). */
  originalBackup: string | null;
  gitignoreUpdated: boolean;
  dryRun: boolean;
}

export async function installHooks(options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  scope: Scope;
  command: string;
  events: readonly HookEvent[];
  /** Also add the background wake hook (default true). */
  wake?: boolean;
  dryRun: boolean;
  /** Codex: its hooks file instead of the scope's Claude Code settings. */
  harness?: Harness;
}): Promise<InstallReport> {
  const { env, scope } = options;
  const harness = options.harness ?? "claude";
  const { file, root } = await targetFile(env, options.cwd, scope, harness);

  const text = await readText(file);
  const before = parseSettings(text, file);
  const { settings: after, changedEvents } = applyInstall(before, {
    command: options.command,
    events: options.events,
    file,
    wake: options.wake ?? true,
    harness,
  });

  const report: InstallReport = {
    file,
    created: text === null,
    alreadyInstalled: changedEvents.length === 0,
    events: [...options.events],
    wake: options.wake ?? true,
    backup: null,
    originalBackup: null,
    gitignoreUpdated: false,
    dryRun: options.dryRun,
  };
  const manifest = await readManifest(env);
  report.originalBackup = manifest.files[file]?.original ?? null;
  if (report.alreadyInstalled || options.dryRun) return report;

  // 1. Save what is there now, before anything changes.
  if (text !== null) report.backup = await backup(env, file);

  // 2. Remember the very first state of this file, the one before agentbridge existed in it.
  if (!manifest.files[file]) {
    manifest.files[file] = { original: report.backup, firstInstalledAt: new Date().toISOString() };
    await writeManifest(env, manifest);
    report.originalBackup = report.backup;
  }

  // 3. Write the merged settings, keeping the file's permissions.
  const mode = text === null ? 0o644 : (await stat(file)).mode & 0o777;
  await writeAtomic(file, serialize(after, text), mode);

  if (harness === "claude" && scope === "project" && text === null) {
    report.gitignoreUpdated = await ignoreInGit(root);
  }
  return report;
}

// --------------------------------------------------------------------------- uninstall

export interface UninstallReport {
  file: string;
  /** Number of our hook entries removed. */
  removed: number;
  /** The file did not exist before agentbridge and was deleted because nothing else was in it. */
  deleted: boolean;
  /** The file was put back exactly as it was before agentbridge. */
  restored: boolean;
  /** Copy of the file as it was just before this change. */
  backup: string | null;
}

export async function uninstallHooks(options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  scope: Scope;
  restoreOriginal: boolean;
  harness?: Harness;
}): Promise<UninstallReport> {
  const { env, scope } = options;
  const { file } = await targetFile(env, options.cwd, scope, options.harness ?? "claude");
  const manifest = await readManifest(env);
  const record = manifest.files[file];

  const text = await readText(file);
  const report: UninstallReport = {
    file,
    removed: 0,
    deleted: false,
    restored: false,
    backup: null,
  };

  if (options.restoreOriginal) {
    if (!record) {
      throw new CliError(`No original of ${file} is recorded: agentbridge never changed it.`);
    }
    if (text !== null) report.backup = await backup(env, file); // never lose what is there now
    if (record.original === null) await rm(file, { force: true });
    else await copyFile(record.original, file);
    report.restored = true;
    delete manifest.files[file];
    await writeManifest(env, manifest);
    return report;
  }

  if (text === null) return report;
  const { settings, removed } = applyUninstall(parseSettings(text, file), file);
  report.removed = removed;
  if (removed === 0) return report;

  report.backup = await backup(env, file);
  if (Object.keys(settings).length === 0 && record?.original === null) {
    await rm(file, { force: true });
    report.deleted = true;
  } else {
    await writeAtomic(file, serialize(settings, text), (await stat(file)).mode & 0o777);
  }
  if (record && (report.deleted || !installedEvents(settings).length)) {
    delete manifest.files[file];
    await writeManifest(env, manifest);
  }
  return report;
}

// ------------------------------------------------------------------------------ status

export interface StatusEntry {
  scope: Scope;
  file: string;
  exists: boolean;
  events: HookEvent[];
  wake: boolean;
  /** Backup of the file from before agentbridge, if one is recorded. */
  originalBackup: string | null | undefined;
}

export async function hookStatus(env: NodeJS.ProcessEnv, cwd: string): Promise<StatusEntry[]> {
  const { root } = await repoRoot(cwd);
  const manifest = await readManifest(env);
  const entries: StatusEntry[] = [];
  for (const scope of SCOPES) {
    const file = settingsFile(scope, root, homeOf(env));
    const text = await readText(file);
    let events: HookEvent[] = [];
    let wake = false;
    try {
      const settings = parseSettings(text, file);
      events = installedEvents(settings);
      wake = wakeInstalled(settings);
    } catch {
      events = [];
    }
    entries.push({
      scope,
      file,
      exists: text !== null,
      events,
      wake,
      originalBackup: manifest.files[file]?.original,
    });
  }
  return entries;
}

/** Our hooks in Codex's hooks file. */
export async function codexHookStatus(
  env: NodeJS.ProcessEnv,
): Promise<{ file: string; events: HookEvent[]; wake: boolean }> {
  const file = codexHooksFile(env);
  try {
    const settings = parseSettings(await readText(file), file);
    return { file, events: installedEvents(settings), wake: wakeInstalled(settings) };
  } catch {
    return { file, events: [], wake: false };
  }
}

/** True when our hooks are installed for every project (`agentbridge setup`). */
export async function userHooksActive(env: NodeJS.ProcessEnv): Promise<boolean> {
  const file = settingsFile("user", "", homeOf(env));
  try {
    return installedEvents(parseSettings(await readText(file), file)).length > 0;
  } catch {
    return false;
  }
}

export { HOOK_EVENTS };
