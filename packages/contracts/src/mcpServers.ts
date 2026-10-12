import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ProviderInstanceEnvironmentVariable } from "./providerInstance.ts";

/** The built-in server every session already gets. User servers never share its prefix. */
export const BUILT_IN_MCP_SERVER_NAME = "t3-code";

/**
 * Key of one `settings.mcpServers` entry: lowercase letters, digits, `_` and
 * `-`, 1 to 32 characters, starting with a letter or digit. Names starting
 * with `t3-code` are reserved for the built-in server.
 */
export const MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const McpServerName = Schema.String.check(
  Schema.isPattern(MCP_SERVER_NAME_PATTERN),
  Schema.makeFilter(
    (name) =>
      !name.startsWith(BUILT_IN_MCP_SERVER_NAME) ||
      `Names starting with "${BUILT_IN_MCP_SERVER_NAME}" are reserved.`,
  ),
);
export type McpServerName = typeof McpServerName.Type;

/** A server T3 starts as a child process of the provider session. */
export const McpStdioServerConfig = Schema.Struct({
  transport: Schema.Literal("stdio"),
  command: Schema.String.check(Schema.isNonEmpty()),
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  env: Schema.Array(ProviderInstanceEnvironmentVariable).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Absent means enabled. */
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type McpStdioServerConfig = typeof McpStdioServerConfig.Type;

/** Tagged on `transport`; other transports join this union. */
export const McpServerConfig = Schema.Union([McpStdioServerConfig]);
export type McpServerConfig = typeof McpServerConfig.Type;

const decodeMcpServerNameOption = Schema.decodeUnknownOption(McpServerName);

/**
 * A record keyed by MCP server name. Written as a check on a string-keyed
 * record because a record skips keys its key schema rejects, and a patch has
 * to refuse an invalid name instead.
 */
export const McpServerRecord = <Value extends Schema.Top>(value: Value) =>
  Schema.Record(Schema.String, value).check(
    Schema.makeFilter((record) => {
      const invalid = Object.keys(record).find(
        (name) => decodeMcpServerNameOption(name)._tag === "None",
      );
      return invalid === undefined || `"${invalid}" is not a valid MCP server name.`;
    }),
  );

export const McpServers = McpServerRecord(McpServerConfig);
export type McpServers = typeof McpServers.Type;

const isValidMcpServerEntry = (() => {
  const decodeConfig = Schema.decodeUnknownOption(McpServerConfig);
  return (name: string, config: unknown) =>
    decodeMcpServerNameOption(name)._tag === "Some" && decodeConfig(config)._tag === "Some";
})();

/**
 * The stored form of `ServerSettings.mcpServers`: a hand-edited file with one
 * bad entry loses only that entry. The loader logs the names it lost, found as
 * the raw keys missing from the decoded record.
 */
export const StoredMcpServers = Schema.Unknown.pipe(
  Schema.decodeTo(
    McpServers,
    SchemaTransformation.transform<McpServers["Encoded"], unknown>({
      decode: (raw) => keepValidMcpServerEntries(raw) as McpServers["Encoded"],
      encode: (value) => value,
    }),
  ),
);

/** Entries of a raw `mcpServers` value that `StoredMcpServers` would keep. */
export function keepValidMcpServerEntries(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([name, config]) =>
      isValidMcpServerEntry(name, config),
    ),
  );
}
