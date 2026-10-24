import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { BUILT_IN_MCP_SERVER_NAME, McpHttpServerConfig, McpServerHeader } from "./mcpServers.ts";

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

/** The Claude config scopes T3 removes servers from; claude.ai, plugin, managed and project servers stay Claude's to manage. */
export const ClaudeMcpRemovableScope = Schema.Literals(["user", "local"]);
export type ClaudeMcpRemovableScope = typeof ClaudeMcpRemovableScope.Type;

/**
 * Removes one server from Claude's own config with `claude mcp remove`, at the
 * scope the probe reported. `cwd` is the directory it was probed in, which
 * picks the project a local server belongs to.
 */
export const RemoveClaudeMcpServerInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  scope: ClaudeMcpRemovableScope,
  cwd: ClaudeMcpStatusInput.fields.cwd,
});
export type RemoveClaudeMcpServerInput = typeof RemoveClaudeMcpServerInput.Type;

export class ClaudeMcpRemoveError extends Schema.TaggedError<ClaudeMcpRemoveError>()(
  "ClaudeMcpRemoveError",
  {
    /** `failed`: Claude ran and refused, with its own words in `detail`. */
    reason: Schema.Literals(["settings", "startFailed", "failed"]),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "settings":
        return "Could not read the Claude provider settings.";
      case "startFailed":
        return "Could not run Claude to remove the MCP server.";
      case "failed":
        return this.detail ?? "Claude could not remove the MCP server.";
    }
  }
}

/**
 * Names Claude's CLI takes for a server, and that can't be misread as a flag:
 * letters, digits, `-` and `_`, starting with a letter or digit.
 */
export const CLAUDE_MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Why `name` can't be added to Claude's own config, or undefined when it can.
 * A name T3 also configures would merge two different servers into one row on
 * the list, and `t3-code` is T3's built-in server. The add form and the server
 * both check with this.
 */
export function claudeMcpServerNameError(
  name: string,
  t3Names: ReadonlyArray<string>,
): string | undefined {
  if (name.startsWith(BUILT_IN_MCP_SERVER_NAME)) {
    return `Names starting with "${BUILT_IN_MCP_SERVER_NAME}" are reserved.`;
  }
  if (!CLAUDE_MCP_SERVER_NAME_PATTERN.test(name)) {
    return "Use letters, digits, - or _, starting with a letter or digit.";
  }
  if (t3Names.includes(name)) {
    return `T3 Code already has a server named "${name}". Pick another name.`;
  }
  return undefined;
}

/** Where in Claude's own config an added server is saved. */
export const ClaudeMcpAddScope = Schema.Literals(["user"]);
export type ClaudeMcpAddScope = typeof ClaudeMcpAddScope.Type;

/** A stdio server, in the JSON shape `claude mcp add-json` takes. */
export const ClaudeMcpStdioServerConfig = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
});
export type ClaudeMcpStdioServerConfig = typeof ClaudeMcpStdioServerConfig.Type;

/** A streamable HTTP server, in the JSON shape `claude mcp add-json` takes. */
export const ClaudeMcpHttpServerConfig = Schema.Struct({
  type: Schema.Literal("http"),
  url: McpHttpServerConfig.fields.url,
  headers: Schema.Record(McpServerHeader.fields.name, Schema.String),
});
export type ClaudeMcpHttpServerConfig = typeof ClaudeMcpHttpServerConfig.Type;

/** The server config passed to Claude as-is; each transport is one member. */
export const ClaudeMcpAddServerConfig = Schema.Union([
  ClaudeMcpStdioServerConfig,
  ClaudeMcpHttpServerConfig,
]);
export type ClaudeMcpAddServerConfig = typeof ClaudeMcpAddServerConfig.Type;

/**
 * Adds a server to Claude's own config through Claude's CLI. `cwd` and
 * `projectId` name the list to re-probe afterwards, as in
 * {@link ClaudeMcpStatusInput}.
 */
export const AddClaudeMcpServerInput = Schema.Struct({
  cwd: ClaudeMcpStatusInput.fields.cwd,
  projectId: ClaudeMcpStatusInput.fields.projectId,
  name: TrimmedNonEmptyString,
  scope: ClaudeMcpAddScope,
  server: ClaudeMcpAddServerConfig,
});
export type AddClaudeMcpServerInput = typeof AddClaudeMcpServerInput.Type;

export class ClaudeMcpAddError extends Schema.TaggedError<ClaudeMcpAddError>()(
  "ClaudeMcpAddError",
  {
    /**
     * `invalidName`: refused by {@link claudeMcpServerNameError}.
     * `unsupportedLauncher`: Claude resolves to a Windows script that would
     * need a shell to run. `rejected`: Claude refused; `detail` is its error.
     */
    reason: Schema.Literals(["invalidName", "settings", "unsupportedLauncher", "rejected"]),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.detail !== undefined && this.detail.length > 0) return this.detail;
    switch (this.reason) {
      case "invalidName":
        return "That name can't be used for a Claude server.";
      case "settings":
        return "Could not read the Claude provider settings.";
      case "unsupportedLauncher":
        return "Claude's launcher script can't be run directly. Set the Claude binary path to claude.exe.";
      case "rejected":
        return "Claude could not add the MCP server.";
    }
  }
}
