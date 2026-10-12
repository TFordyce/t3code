import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * What a running provider session reports about one MCP server. `unsupported`
 * is a transport the adapter cannot carry; `unknown` is a configured server the
 * provider has not reported on (yet).
 */
export const McpSessionServerStatusValue = Schema.Literals([
  "connecting",
  "connected",
  "needs-auth",
  "failed",
  "disabled",
  "unsupported",
  "unknown",
]);
export type McpSessionServerStatusValue = typeof McpSessionServerStatusValue.Type;

export const McpSessionServerStatus = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: McpSessionServerStatusValue,
  error: Schema.optional(Schema.String),
  toolCount: Schema.optional(NonNegativeInt),
});
export type McpSessionServerStatus = typeof McpSessionServerStatus.Type;

/** The full latest list for a session; each update replaces the previous one. */
export const McpSessionStatusList = Schema.Array(McpSessionServerStatus);
export type McpSessionStatusList = typeof McpSessionStatusList.Type;
