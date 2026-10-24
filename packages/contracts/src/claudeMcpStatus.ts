import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Mirrors the status values the Claude Agent SDK reports for a loaded MCP server. */
export const ClaudeMcpServerStatusValue = Schema.Literals([
  "connected",
  "pending",
  "failed",
  "needs-auth",
  "disabled",
]);
export type ClaudeMcpServerStatusValue = typeof ClaudeMcpServerStatusValue.Type;

/**
 * One MCP server Claude would load for a working directory. `scope` and
 * `source` are the SDK's own strings (`user`, `project`, `claudeai`, `plugin`,
 * `sdk`, ...), passed through so clients decide the level and group.
 */
export const ClaudeMcpServerReport = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: ClaudeMcpServerStatusValue,
  toolCount: NonNegativeInt,
  error: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
});
export type ClaudeMcpServerReport = typeof ClaudeMcpServerReport.Type;

export const ClaudeMcpStatusInput = Schema.Struct({
  /** The directory Claude is started in: the project root, or a user-level directory. */
  cwd: TrimmedNonEmptyString,
  /** Whose disabled list applies: the project's override, else the environment's. */
  projectId: Schema.optional(ProjectId),
  /** Skip the server's cached probe and ask Claude again (Refresh, after a reconnect). */
  fresh: Schema.optional(Schema.Boolean),
});
export type ClaudeMcpStatusInput = typeof ClaudeMcpStatusInput.Type;

export const ClaudeMcpStatusResult = Schema.Struct({
  servers: Schema.Array(ClaudeMcpServerReport),
  checkedAt: IsoDateTime,
});
export type ClaudeMcpStatusResult = typeof ClaudeMcpStatusResult.Type;

/** How Claude reaches a server: `claudeai` is a claude.ai connector, `sdk` an in-process server. */
export const ClaudeMcpTransportKind = Schema.Literals(["stdio", "http", "sse", "claudeai", "sdk"]);
export type ClaudeMcpTransportKind = typeof ClaudeMcpTransportKind.Type;

export const ClaudeMcpToolDetail = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  readOnly: Schema.Boolean,
  destructive: Schema.Boolean,
});
export type ClaudeMcpToolDetail = typeof ClaudeMcpToolDetail.Type;

/**
 * One server as Claude reports it, redacted on the server: headers, env, args
 * and URL query strings never cross the wire. `url` is set for remote servers
 * (without its query string), `command` only names the stdio executable.
 */
export const ClaudeMcpServerDetail = Schema.Struct({
  ...ClaudeMcpServerReport.fields,
  serverInfo: Schema.optional(Schema.Struct({ name: Schema.String, version: Schema.String })),
  transport: Schema.optional(ClaudeMcpTransportKind),
  url: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  tools: Schema.Array(ClaudeMcpToolDetail),
});
export type ClaudeMcpServerDetail = typeof ClaudeMcpServerDetail.Type;

export const ClaudeMcpServerDetailInput = Schema.Struct({
  cwd: ClaudeMcpStatusInput.fields.cwd,
  projectId: ClaudeMcpStatusInput.fields.projectId,
  name: TrimmedNonEmptyString,
});
export type ClaudeMcpServerDetailInput = typeof ClaudeMcpServerDetailInput.Type;

export const ClaudeMcpServerDetailResult = Schema.Struct({
  /** Null when Claude no longer reports a server by that name. */
  server: Schema.NullOr(ClaudeMcpServerDetail),
  checkedAt: IsoDateTime,
});
export type ClaudeMcpServerDetailResult = typeof ClaudeMcpServerDetailResult.Type;

export class ClaudeMcpStatusError extends Schema.TaggedError<ClaudeMcpStatusError>()(
  "ClaudeMcpStatusError",
  {
    reason: Schema.Literals(["settings", "startFailed", "timeout"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "settings":
        return "Could not read the Claude provider settings.";
      case "startFailed":
        return "Claude could not report its MCP servers.";
      case "timeout":
        return "Claude's MCP servers did not finish connecting in time.";
    }
  }
}

/**
 * Turns one Claude MCP server on or off. With `projectId` the project's own
 * disabled list is written (seeded from what applies to it today); without,
 * the environment-wide list.
 */
export const SetClaudeMcpServerEnabledInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  projectId: Schema.optional(ProjectId),
});
export type SetClaudeMcpServerEnabledInput = typeof SetClaudeMcpServerEnabledInput.Type;

export class ClaudeMcpToggleError extends Schema.TaggedError<ClaudeMcpToggleError>()(
  "ClaudeMcpToggleError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not save the Claude MCP server setting.";
  }
}

/** Asks the thread's running Claude process to reconnect one MCP server. */
export const ReconnectClaudeMcpServerInput = Schema.Struct({
  threadId: ThreadId,
  name: TrimmedNonEmptyString,
});
export type ReconnectClaudeMcpServerInput = typeof ReconnectClaudeMcpServerInput.Type;

export class ClaudeMcpReconnectError extends Schema.TaggedError<ClaudeMcpReconnectError>()(
  "ClaudeMcpReconnectError",
  {
    /** `noSession`: the thread has no running Claude process to reconnect in. */
    reason: Schema.Literals(["noSession", "failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "noSession":
        return "No active session. Start a turn in this thread to reconnect MCP servers.";
      case "failed":
        return "Claude could not reconnect the MCP server.";
    }
  }
}
