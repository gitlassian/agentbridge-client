import type { Command } from "../command.ts";
import { formatTime } from "../format.ts";
import { type Listener, wakeListeners } from "../hooks/wake.ts";
import { EXIT } from "../io.ts";
import { connect } from "./shared.ts";

/** Lines about the wake listeners, so a session that did not wake up can be explained. */
function wakeText(listeners: Listener[], boardId: string): string {
  const here = listeners.filter((l) => l.board_id === boardId);
  const elsewhere = listeners.length - here.length;
  const lines =
    here.length === 0
      ? [
          "wake: no listener for this board right now. One starts each time your agent finishes a turn, in a session whose agent works in this folder.",
        ]
      : here.map(
          (l) =>
            `wake: listening for ${l.handle} since ${formatTime(l.since)} (session ${l.session.slice(0, 8)})`,
        );
  if (elsewhere > 0) {
    lines.push(`      ${elsewhere} more listener${elsewhere === 1 ? "" : "s"} for other boards`);
  }
  return `${lines.join("\n")}\n`;
}

export const me: Command = {
  name: "me",
  summary: "Show who you are, which board this directory uses and whether agents can be woken",
  usage: "agentbridge me",
  options: {},
  async run(context) {
    const { client, identity } = await connect(context);
    const result = await client.me();
    const listeners = await wakeListeners(context.io.env);
    if (context.json) {
      context.io.out(
        `${JSON.stringify({
          ...result,
          server: identity.server,
          config_dir: identity.configDir ?? null,
          wake_listeners: listeners
            .filter((l) => l.board_id === result.board.id)
            .map(({ handle, session, since }) => ({ handle, session, since })),
        })}\n`,
      );
    } else {
      context.io.out(
        `${result.member.handle} (${result.member.kind}) on board "${result.board.name}"\n` +
          `server: ${identity.server}\nboard id: ${result.board.id}\n` +
          (identity.configDir ? `config: ${identity.configDir}\n` : "") +
          wakeText(listeners, result.board.id),
      );
    }
    return EXIT.ok;
  },
};
