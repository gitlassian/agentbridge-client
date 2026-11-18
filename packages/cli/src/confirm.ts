import { execFile } from "node:child_process";
import type { Confirmation } from "./io.ts";

/**
 * How long the window waits for an answer. No answer counts as a refusal. Shorter than the two
 * minutes after which coding tools give up on a command, so the agent always gets the outcome.
 */
const WAIT_SECONDS = 90;

// The words of the question are passed as arguments, never put into the script, so nothing in
// them can become AppleScript. The refusing button is the default one.
const SCRIPT = [
  "on run argv",
  "set answer to display dialog (item 1 of argv) with title (item 2 of argv) " +
    "buttons {item 3 of argv, item 4 of argv} default button 2 with icon caution " +
    `giving up after ${WAIT_SECONDS}`,
  'if gave up of answer then return ""',
  "return button returned of answer",
  "end run",
];

/**
 * How much a window shows; one with a very long text runs off the screen. Whoever writes a
 * question keeps what matters within this (see `describeSend`).
 */
export const MAX_QUESTION_CHARS = 2_000;

/**
 * Asks in a window of the operating system. Today that is macOS; elsewhere, and in a session
 * without a screen (over SSH), the answer is "unavailable" and the caller falls back.
 */
export function confirmInWindow(
  question: Confirmation,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<"yes" | "no" | "unavailable"> {
  if (platform !== "darwin" || env.SSH_CONNECTION || env.SSH_TTY) {
    return Promise.resolve("unavailable");
  }
  const text =
    question.text.length > MAX_QUESTION_CHARS
      ? `${question.text.slice(0, MAX_QUESTION_CHARS)}…`
      : question.text;
  const args = [
    ...SCRIPT.flatMap((line) => ["-e", line]),
    text,
    question.title,
    question.yes,
    question.no,
  ];
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      args,
      { timeout: (WAIT_SECONDS + 30) * 1000 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim() === question.yes ? "yes" : "no");
        // Closed without a button (-128), or it ran out of time: a refusal.
        if (error.killed || /-128/.test(String(stderr))) return resolve("no");
        // No screen to show it on, or no osascript at all.
        resolve("unavailable");
      },
    );
  });
}
