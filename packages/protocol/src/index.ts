import type { components } from "./api.ts";

export type { components, paths } from "./api.ts";
export * from "./constants.ts";
export { type ParsedHandle, parseHandle, RESERVED_NAMES } from "./handle.ts";
export { inviteMessage } from "./invite.ts";

/** Request and response types generated from the server's OpenAPI description. */
type Schemas = components["schemas"];
export type BoardCreated = Schemas["BoardCreated"];
export type Document = Schemas["Document"];
export type FileInfo = Schemas["FileInfo"];
export type FileRef = Schemas["FileRef"];
export type FileSent = Schemas["FileSent"];
export type DocumentInfo = Schemas["DocumentInfo"];
/** `files` is missing in what a server older than file transfer sends. */
export type InboxMessage = Omit<Schemas["InboxMessage"], "files"> & { files?: FileRef[] };
export type InviteInfo = Schemas["InviteInfo"];
export type InboxResult = Schemas["InboxResult"];
export type JoinResult = Schemas["JoinResult"];
export type Me = Schemas["Me"];
/** `role` and `state` are missing in what a server older than board owners sends. */
export type MemberOut = Omit<Schemas["MemberOut"], "role" | "state"> &
  Partial<Pick<Schemas["MemberOut"], "role" | "state">>;
export type MembersResponse = { members: MemberOut[] };
/** Fields with a default on the server may be left out of a request. */
export type CreateTokenRequest = Omit<Schemas["CreateTokenRequest"], "open"> & { open?: boolean };
export type Message = Omit<Schemas["Message"], "files"> & { files?: FileRef[] };
export type MessagesPage = Schemas["MessagesPage"];
export type PostMessageResponse = Schemas["PostMessageResponse"];
export type Task = Schemas["Task"];
export type TaskState = Schemas["Task"]["state"];
export type TasksResponse = Schemas["TasksResponse"];
export type AddTaskRequest = Schemas["AddTaskRequest"];
export type TokenCreated = Schemas["TokenCreated"];
export type TokenOut = Schemas["TokenOut"];
export type SecurityEvent = Schemas["SecurityEvent"];
export type MemberKind = Schemas["JoinMember"]["kind"];
export type Zone = Schemas["Zone"];
export type ZoneOverlap = Schemas["ZoneOverlap"];
