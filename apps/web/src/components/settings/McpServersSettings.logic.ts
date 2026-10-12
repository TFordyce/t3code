import {
  BUILT_IN_MCP_SERVER_NAME,
  MCP_SERVER_NAME_PATTERN,
  ProviderInstanceEnvironmentVariableName,
  type McpServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isEnvironmentVariableName = Schema.is(ProviderInstanceEnvironmentVariableName);

/** One env row while editing. `redacted` means the value is stored on the host and not shown. */
export interface McpEnvDraftRow {
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly redacted: boolean;
}

/** A server form's state. `args` is one argument per line, so quoting never needs parsing. */
export interface McpServerDraft {
  readonly name: string;
  readonly command: string;
  readonly args: string;
  readonly env: ReadonlyArray<McpEnvDraftRow>;
  readonly enabled: boolean;
}

export const emptyDraft = (): McpServerDraft => ({
  name: "",
  command: "",
  args: "",
  env: [],
  enabled: true,
});

export function draftFromConfig(name: string, config: McpServerConfig): McpServerDraft {
  return {
    name,
    command: config.command,
    args: config.args.join("\n"),
    env: config.env.map((row) => ({
      name: row.name,
      value: row.value,
      sensitive: row.sensitive,
      redacted: row.valueRedacted === true,
    })),
    enabled: config.enabled !== false,
  };
}

/**
 * The config a draft saves. A redacted row goes back redacted and empty, which
 * the server reads as "keep what you have"; a row the user retyped carries its
 * new value.
 */
export function configFromDraft(draft: McpServerDraft): McpServerConfig {
  return {
    transport: "stdio",
    command: draft.command.trim(),
    args: draft.args
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    env: draft.env.flatMap((row) => {
      const name = row.name.trim();
      if (name.length === 0) return [];
      return row.redacted
        ? [{ name, value: "", sensitive: true, valueRedacted: true }]
        : [{ name, value: row.value, sensitive: row.sensitive }];
    }),
    ...(draft.enabled ? {} : { enabled: false }),
  };
}

export interface McpDraftErrors {
  readonly name?: string;
  readonly command?: string;
  readonly env?: string;
}

/** Field errors for a draft; an empty object means it can be saved. */
export function validateDraft(
  draft: McpServerDraft,
  context: { readonly existingNames: ReadonlyArray<string>; readonly isNew: boolean },
): McpDraftErrors {
  const errors: { name?: string; command?: string; env?: string } = {};
  const name = draft.name;
  if (name.startsWith(BUILT_IN_MCP_SERVER_NAME)) {
    errors.name = `Names starting with "${BUILT_IN_MCP_SERVER_NAME}" are reserved.`;
  } else if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    errors.name = "Use 1 to 32 lowercase letters, digits, - or _, starting with a letter or digit.";
  } else if (context.isNew && context.existingNames.includes(name)) {
    errors.name = "A server with this name already exists.";
  }
  if (draft.command.trim().length === 0)
    errors.command = "Enter the command that starts the server.";

  const names = draft.env.map((row) => row.name.trim()).filter((rowName) => rowName.length > 0);
  const invalid = names.find((rowName) => !isEnvironmentVariableName(rowName));
  if (invalid !== undefined) {
    errors.env = `"${invalid}" is not a valid variable name.`;
  } else if (new Set(names).size !== names.length) {
    errors.env = "Each variable can be set once.";
  }
  return errors;
}

/**
 * Display names of enabled providers known to be unable to carry servers of
 * `transport`. A provider that did not report support is left out: unknown is
 * not "unsupported".
 */
export function providersWithoutMcpSupport(
  providers: ReadonlyArray<ServerProvider>,
  transport: McpServerConfig["transport"],
): ReadonlyArray<string> {
  const names = providers
    .filter(
      (provider) =>
        provider.enabled &&
        provider.userMcpTransports !== undefined &&
        !provider.userMcpTransports.includes(transport),
    )
    .map((provider) => provider.displayName ?? provider.driver);
  return [...new Set(names)];
}
