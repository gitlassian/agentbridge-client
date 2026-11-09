#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { run } from "./cli.ts";
import type { Io } from "./io.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer === "" ? (defaultValue ?? "") : answer;
  } finally {
    rl.close();
  }
}

const io: Io = {
  env: process.env,
  cwd: process.cwd(),
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  readStdin,
  readLines: () => createInterface({ input: process.stdin, crlfDelay: Infinity }),
  ask,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  fetch,
};

const args = process.argv.slice(2);
const code = await run(args, io);

if (args[0] === "mcp") {
  // The MCP server may still have a long-poll request in flight when its client goes away.
  // Exit once the output is flushed instead of waiting for it.
  process.stdout.write("", () => process.exit(code));
} else {
  process.exitCode = code;
}
