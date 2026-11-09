import type { components } from "./api.ts";

export type { components, paths } from "./api.ts";
export * from "./constants.ts";
export { type ParsedHandle, parseHandle, RESERVED_NAMES } from "./handle.ts";
export { inviteMessage } from "./invite.ts";

/** Request and response types generated from the server's OpenAPI description. */
type Schemas = components["schemas"];
export type BoardCreated = Schemas["BoardCreated"];
export type InboxMessage = Schemas["InboxMessage"];
export type InviteInfo = Schemas["InviteInfo"];
export type InboxResult = Schemas["InboxResult"];
export type JoinResult = Schemas["JoinResult"];
export type Me = Schemas["Me"];
export type MemberOut = Schemas["MemberOut"];
export type MembersResponse = Schemas["MembersResponse"];
export type Message = Schemas["Message"];
export type MessagesPage = Schemas["MessagesPage"];
export type PostMessageResponse = Schemas["PostMessageResponse"];
export type TokenCreated = Schemas["TokenCreated"];
export type MemberKind = Schemas["JoinMember"]["kind"];
