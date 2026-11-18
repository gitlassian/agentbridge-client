import { join } from "node:path";
import { readJson, writePrivate } from "./config.ts";

/**
 * Who decides that a file may leave this computer: the person, every time ("ask"), or their
 * agents on their own ("auto"). Kept per board in the person's config folder, next to the keys.
 */
export const FILE_POLICIES = ["ask", "auto"] as const;
export type FilePolicy = (typeof FILE_POLICIES)[number];

interface SettingsFile {
  boards?: Record<string, { files?: FilePolicy }>;
}

const settingsPath = (dir: string) => join(dir, "settings.json");

/** "ask" unless the person chose otherwise for this board. */
export async function filePolicy(
  dir: string | undefined,
  boardId: string | undefined,
): Promise<FilePolicy> {
  if (dir === undefined || boardId === undefined) return "ask";
  const file = await readJson<SettingsFile>(settingsPath(dir));
  return file?.boards?.[boardId]?.files === "auto" ? "auto" : "ask";
}

export async function setFilePolicy(
  dir: string,
  boardId: string,
  policy: FilePolicy,
): Promise<void> {
  const file = (await readJson<SettingsFile>(settingsPath(dir))) ?? {};
  file.boards ??= {};
  file.boards[boardId] = { ...file.boards[boardId], files: policy };
  await writePrivate(settingsPath(dir), `${JSON.stringify(file, null, 2)}\n`);
}
