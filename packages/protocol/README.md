# @agentbridge/protocol

The TypeScript side of the agentbridge API contract, bundled into the command line tool (it is not published on its own).

- `src/api.ts` is generated from the server's OpenAPI description. Do not edit it by hand.
- `src/index.ts` exports friendly names for the generated types (`Message`, `InboxResult`, ...).
- `src/handle.ts` validates handles (`alice`, `alice/claude`) the same way the server does.
- `src/constants.ts` holds the limits enforced by the server, the default server and the package name.
