import {
  BUILT_IN_MCP_SERVER_NAME,
  MCP_HEADER_NAME_PATTERN,
  MCP_SERVER_NAME_PATTERN,
  ProviderInstanceEnvironmentVariableName,
  type McpServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isEnvironmentVariableName = Schema.is(ProviderInstanceEnvironmentVariableName);

/** One env or header row while editing. `redacted` means the value is stored on the host and not shown. */
export interface McpEnvDraftRow {
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly redacted: boolean;
}

/** A server form's state. `args` is one argument per line, so quoting never needs parsing. */
export interface McpServerDraft {
  readonly name: string;
  readonly transport: McpServerConfig["transport"];
  readonly command: string;
  readonly args: string;
  readonly env: ReadonlyArray<McpEnvDraftRow>;
  readonly url: string;
  readonly headers: ReadonlyArray<McpEnvDraftRow>;
  readonly enabled: boolean;
}

export const emptyDraft = (): McpServerDraft => ({
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  env: [],
  url: "",
  headers: [],
  enabled: true,
});

const draftRows = (
  rows: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly sensitive: boolean;
    readonly valueRedacted?: boolean;
  }>,
): ReadonlyArray<McpEnvDraftRow> =>
  rows.map((row) => ({
    name: row.name,
    value: row.value,
    sensitive: row.sensitive,
    redacted: row.valueRedacted === true,
  }));

export function draftFromConfig(name: string, config: McpServerConfig): McpServerDraft {
  const base = { ...emptyDraft(), name, enabled: config.enabled !== false };
  return config.transport === "http"
    ? { ...base, transport: "http", url: config.url, headers: draftRows(config.headers) }
    : {
        ...base,
        command: config.command,
        args: config.args.join("\n"),
        env: draftRows(config.env),
      };
}

/**
 * A redacted row goes back redacted and empty, which the server reads as "keep
 * what you have"; a row the user retyped carries its new value.
 */
const rowsFromDraft = (rows: ReadonlyArray<McpEnvDraftRow>) =>
  rows.flatMap((row) => {
    const name = row.name.trim();
    if (name.length === 0) return [];
    return row.redacted
      ? [{ name, value: "", sensitive: true, valueRedacted: true }]
      : [{ name, value: row.value, sensitive: row.sensitive }];
  });

/** The config a draft saves. */
export function configFromDraft(draft: McpServerDraft): McpServerConfig {
  const enabled = draft.enabled ? {} : { enabled: false };
  if (draft.transport === "http") {
    return {
      transport: "http",
      url: draft.url.trim(),
      headers: rowsFromDraft(draft.headers),
      ...enabled,
    };
  }
  return {
    transport: "stdio",
    command: draft.command.trim(),
    args: draft.args
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    env: rowsFromDraft(draft.env),
    ...enabled,
  };
}

export interface McpDraftErrors {
  readonly name?: string;
  readonly command?: string;
  readonly env?: string;
  readonly url?: string;
  readonly headers?: string;
}

const isHttpUrl = (value: string) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/** Field errors for a draft; an empty object means it can be saved. */
export function validateDraft(
  draft: McpServerDraft,
  context: { readonly existingNames: ReadonlyArray<string>; readonly isNew: boolean },
): McpDraftErrors {
  const errors: { -readonly [K in keyof McpDraftErrors]: McpDraftErrors[K] } = {};
  const name = draft.name;
  if (name.startsWith(BUILT_IN_MCP_SERVER_NAME)) {
    errors.name = `Names starting with "${BUILT_IN_MCP_SERVER_NAME}" are reserved.`;
  } else if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    errors.name = "Use 1 to 32 lowercase letters, digits, - or _, starting with a letter or digit.";
  } else if (context.isNew && context.existingNames.includes(name)) {
    errors.name = "A server with this name already exists.";
  }

  if (draft.transport === "http") {
    if (!isHttpUrl(draft.url.trim())) errors.url = "Enter the server's http(s) URL.";
    const names = draft.headers
      .map((row) => row.name.trim())
      .filter((rowName) => rowName.length > 0);
    const invalid = names.find((rowName) => !MCP_HEADER_NAME_PATTERN.test(rowName));
    if (invalid !== undefined) {
      errors.headers = `"${invalid}" is not a valid header name.`;
    } else if (new Set(names.map((rowName) => rowName.toLowerCase())).size !== names.length) {
      errors.headers = "Each header can be set once.";
    }
    return errors;
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

const CREDENTIAL_QUERY_PARAMETER = /token|key|secret|auth|password|passwd|signature|bearer|sig$/i;

/**
 * A note for a URL whose query string looks like it carries a credential. URLs
 * are stored as plain text; headers can be marked sensitive and stored securely.
 */
export function urlQueryTokenWarning(url: string): string | undefined {
  let parameters: URLSearchParams;
  try {
    parameters = new URL(url.trim()).searchParams;
  } catch {
    return undefined;
  }
  for (const parameter of parameters.keys()) {
    if (CREDENTIAL_QUERY_PARAMETER.test(parameter)) {
      return `"${parameter}" in the URL looks like a credential. URLs are not stored securely; send it as a sensitive header instead.`;
    }
  }
  return undefined;
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
