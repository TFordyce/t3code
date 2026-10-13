import {
  BUILT_IN_MCP_SERVER_NAME,
  isMcpServerDisabledMarker,
  MCP_HEADER_NAME_PATTERN,
  MCP_SERVER_NAME_PATTERN,
  ProviderInstanceEnvironmentVariableName,
  type McpServerCheck,
  type McpServerConfig,
  type McpServerOverride,
  type ProjectId,
  type ProjectSettingsOverrides,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { selectMcpServerCheck } from "@t3tools/client-runtime/state/mcp-server-checks";
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
  /** Optional OAuth client for sign-in; blank means register one dynamically. */
  readonly oauthClientId: string;
  readonly oauthClientSecret: string;
  /** The secret is stored on the host and not shown. */
  readonly oauthClientSecretRedacted: boolean;
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
  oauthClientId: "",
  oauthClientSecret: "",
  oauthClientSecretRedacted: false,
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
    ? {
        ...base,
        transport: "http",
        url: config.url,
        headers: draftRows(config.headers),
        oauthClientId: config.oauth?.clientId ?? "",
        oauthClientSecret: config.oauth?.clientSecret?.value ?? "",
        oauthClientSecretRedacted: config.oauth?.clientSecret?.valueRedacted === true,
      }
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
    const clientId = draft.oauthClientId.trim();
    // A redacted secret goes back redacted and empty: the server keeps what it has.
    const clientSecret = draft.oauthClientSecretRedacted
      ? { value: "", valueRedacted: true }
      : draft.oauthClientSecret.length > 0
        ? { value: draft.oauthClientSecret }
        : undefined;
    return {
      transport: "http",
      url: draft.url.trim(),
      headers: rowsFromDraft(draft.headers),
      ...(clientId.length === 0
        ? {}
        : { oauth: { clientId, ...(clientSecret === undefined ? {} : { clientSecret }) } }),
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
  readonly oauthClientId?: string;
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
    if (draft.oauthClientId.trim().length === 0 && draft.oauthClientSecret.length > 0) {
      errors.oauthClientId = "Enter the client ID that goes with this secret.";
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

/**
 * The notice shown after a save. OpenCode registers servers on one shared
 * server per directory, so its running sessions pick a change up too.
 */
export function saveNotice(
  providers: ReadonlyArray<ServerProvider>,
  scope: "environment" | "project" = "environment",
): string {
  const where = scope === "project" ? " in this project" : "";
  const base = `Applies to new sessions${where}.`;
  return providers.some((provider) => provider.enabled && provider.driver === "opencode")
    ? `${base} OpenCode sessions${where} pick it up now.`
    : base;
}

/** One row in a project's own section: its servers and its overrides of environment ones. */
export interface ProjectMcpRow {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly kind: "project" | "override";
}

/** An environment server as a project sees it. */
export interface InheritedMcpRow {
  readonly name: string;
  readonly config: McpServerConfig;
  /** The project has a marker turning it off. */
  readonly offForProject: boolean;
  /** Off at environment level, so the project switch is inert. */
  readonly offOnEnvironment: boolean;
}

type McpSettingsView = Pick<ServerSettings, "mcpServers" | "projectSettingsOverrides">;

/**
 * The rows of a project's MCP page: what the project holds itself ("This
 * project") and the environment servers it inherits, in name order.
 */
export function projectMcpRows(
  settings: McpSettingsView,
  projectId: ProjectId,
): {
  readonly project: ReadonlyArray<ProjectMcpRow>;
  readonly inherited: ReadonlyArray<InheritedMcpRow>;
} {
  const overrides = settings.projectSettingsOverrides[projectId]?.mcpServers ?? {};
  const project: ProjectMcpRow[] = [];
  const inherited: InheritedMcpRow[] = [];
  for (const [name, override] of Object.entries(overrides)) {
    if (isMcpServerDisabledMarker(override)) continue;
    project.push({
      name,
      config: override,
      kind: Object.hasOwn(settings.mcpServers, name) ? "override" : "project",
    });
  }
  for (const [name, config] of Object.entries(settings.mcpServers)) {
    const override = overrides[name];
    if (override !== undefined && !isMcpServerDisabledMarker(override)) continue;
    inherited.push({
      name,
      config,
      offForProject: override !== undefined,
      offOnEnvironment: config.enabled === false,
    });
  }
  const byName = (left: { readonly name: string }, right: { readonly name: string }) =>
    left.name.localeCompare(right.name);
  return { project: project.toSorted(byName), inherited: inherited.toSorted(byName) };
}

/**
 * The patch that sets one project entry (`null` removes it). A project patch
 * replaces the project's whole override entry, so this resends the rest of it.
 */
export function projectMcpPatch(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  name: string,
  value: McpServerOverride | null,
): { readonly projectSettingsOverrides: Record<ProjectId, ProjectSettingsOverrides | null> } {
  const { mcpServers: current = {}, ...rest } = settings.projectSettingsOverrides[projectId] ?? {};
  const { [name]: _replaced, ...others } = current;
  const mcpServers = value === null ? others : { ...others, [name]: value };
  const entry: ProjectSettingsOverrides = {
    ...rest,
    ...(Object.keys(mcpServers).length === 0 ? {} : { mcpServers }),
  };
  return {
    projectSettingsOverrides: { [projectId]: Object.keys(entry).length === 0 ? null : entry },
  };
}

/**
 * The form for "Override for project", starting from the environment config.
 * Stored secrets belong to the environment entry and cannot be copied, so those
 * rows come back empty for the user to enter again.
 */
export function overrideDraftFromEnvironment(
  name: string,
  config: McpServerConfig,
): McpServerDraft {
  const draft = draftFromConfig(name, { ...config, enabled: true });
  const cleared = (rows: ReadonlyArray<McpEnvDraftRow>) =>
    rows.map((row) => (row.redacted ? { ...row, value: "", redacted: false } : row));
  return {
    ...draft,
    env: cleared(draft.env),
    headers: cleared(draft.headers),
    oauthClientSecret: "",
    oauthClientSecretRedacted: false,
  };
}

/**
 * The check a project row shows: its own for a project config, the
 * environment's for an inherited server.
 */
export function selectProjectMcpCheck(
  config: Parameters<typeof selectMcpServerCheck>[0],
  projectId: string,
  name: string,
  source: "global" | "override" | "project",
): McpServerCheck | undefined {
  return selectMcpServerCheck(config, source === "global" ? "global" : projectId, name);
}

export type McpSignInRelayResult =
  | { readonly kind: "completed" }
  | { readonly kind: "paste"; readonly notice?: string };

/**
 * Sign in to a server on a remote environment. Desktop catches the browser
 * redirect on its own loopback and hands it to the host; when it cannot (no
 * desktop receiver, or the port is busy) the page is opened as usual and the
 * user pastes the final address instead.
 */
export async function relayMcpSignIn(input: {
  readonly authorizationUrl: string;
  readonly receive: ((authorizationUrl: string) => Promise<string>) | undefined;
  readonly openExternal: (url: string) => Promise<unknown>;
  /** Resolves true when the host accepted the redirect. */
  readonly complete: (callbackUrl: string) => Promise<boolean>;
}): Promise<McpSignInRelayResult> {
  let notice: string | undefined;
  if (input.receive) {
    try {
      const callbackUrl = await input.receive(input.authorizationUrl);
      return (await input.complete(callbackUrl)) ? { kind: "completed" } : { kind: "paste" };
    } catch (cause) {
      notice = cause instanceof Error ? cause.message : undefined;
    }
  }
  await input.openExternal(input.authorizationUrl);
  return notice === undefined ? { kind: "paste" } : { kind: "paste", notice };
}
