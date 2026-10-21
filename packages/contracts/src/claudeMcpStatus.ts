import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
});
export type ClaudeMcpStatusInput = typeof ClaudeMcpStatusInput.Type;

export const ClaudeMcpStatusResult = Schema.Struct({
  servers: Schema.Array(ClaudeMcpServerReport),
  checkedAt: IsoDateTime,
});
export type ClaudeMcpStatusResult = typeof ClaudeMcpStatusResult.Type;

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
