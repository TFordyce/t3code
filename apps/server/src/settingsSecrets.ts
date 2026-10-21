import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  EasDeviceHostConfig,
  isMcpServerDisabledMarker,
  type McpServerConfig,
  type McpServerDisabledMarker,
  type McpServerHeader,
  type ProjectSettingsOverrides,
  type ProviderInstanceEnvironmentVariable,
  type ServerSettings,
  UsageLimitSourceConfig,
  secretSettingsFields,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";
import {
  readSecretFieldValues,
  SOURCE_CONTROL_HOST_SECRET_FIELDS,
  sourceControlHostSecretName,
  writeSecretFieldValues,
} from "./sourceControl/sourceControlHostSecrets.ts";

export const SECRET_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

const providerSecretFields = new Map([
  ["codex", secretSettingsFields(CodexSettings)],
  ["claudeAgent", secretSettingsFields(ClaudeSettings)],
  ["antigravity", secretSettingsFields(AntigravitySettings)],
  ...[cursorClient, grokClient, museClient, openCodeClient, piClient, acpRegistryClient].map(
    (definition) =>
      [definition.driverKind, secretSettingsFields(definition.settingsSchema)] as const,
  ),
]);
const usageLimitSecretFields = secretSettingsFields(UsageLimitSourceConfig);
const easDeviceHostSecretFields = secretSettingsFields(EasDeviceHostConfig);
const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

type McpServerEntries = Readonly<Record<string, McpServerConfig | McpServerDisabledMarker>>;

/** Where an MCP entry lives, as part of its store keys: `"global"` or `project:<id>`. */
const mcpScopeKey = (projectId: string | null) =>
  projectId === null ? "global" : `project:${projectId}`;

/**
 * Rebuilds every MCP entry, environment-wide first and then each project's
 * overrides. The scope is part of the store key, so a project override never
 * shares a secret with the environment entry of the same name.
 */
const mapMcpEntries = (
  settings: ServerSettings,
  mapServer: (scope: string, name: string, server: McpServerConfig) => McpServerConfig,
): ServerSettings => {
  const mapEntries = <Entries extends McpServerEntries>(scope: string, entries: Entries) => {
    const mapped: Record<string, McpServerConfig | McpServerDisabledMarker> = {};
    for (const [name, server] of Object.entries(entries)) {
      mapped[name] = isMcpServerDisabledMarker(server) ? server : mapServer(scope, name, server);
    }
    return mapped as Entries;
  };

  const projectSettingsOverrides: Record<string, ProjectSettingsOverrides> = {};
  for (const [projectId, overrides] of Object.entries(settings.projectSettingsOverrides)) {
    projectSettingsOverrides[projectId] =
      overrides.mcpServers === undefined
        ? overrides
        : { ...overrides, mcpServers: mapEntries(mcpScopeKey(projectId), overrides.mcpServers) };
  }
  return {
    ...settings,
    mcpServers: mapEntries(mcpScopeKey(null), settings.mcpServers),
    projectSettingsOverrides:
      projectSettingsOverrides as ServerSettings["projectSettingsOverrides"],
  };
};

/** Where an entry's sign-in bundle lives. `scope` is `"global"` or `project:<id>`. */
export const mcpSignInSecretKey = (scope: string, name: string) =>
  `mcp-signin-${encode(scope)}-${encode(name)}`;

type McpHttpServer = Extract<McpServerConfig, { transport: "http" }>;

/**
 * Removals of the sign-ins an edit invalidates. A sign-in belongs to the
 * server it was granted for, so it goes when its entry is removed, its URL
 * changes, its transport leaves http, or its OAuth client id changes.
 * Toggling `enabled`, project markers and other header edits keep it.
 */
export function planMcpSignInClears(
  current: ServerSettings,
  next: ServerSettings,
): ReadonlyArray<string> {
  const httpEntries = (settings: ServerSettings) => {
    const entries = new Map<string, McpHttpServer>();
    mapMcpEntries(settings, (scope, name, server) => {
      if (server.transport === "http") entries.set(mcpSignInSecretKey(scope, name), server);
      return server;
    });
    return entries;
  };
  const after = httpEntries(next);
  const cleared: string[] = [];
  for (const [key, before] of httpEntries(current)) {
    const kept = after.get(key);
    if (
      kept === undefined ||
      kept.url !== before.url ||
      kept.oauth?.clientId !== before.oauth?.clientId
    ) {
      cleared.push(key);
    }
  }
  return cleared;
}

export interface SettingsSecret {
  readonly secretName: string;
  readonly kind: "field" | "environment";
  readonly value: string;
  readonly redacted: boolean;
  readonly sensitive: boolean;
  readonly providerInstanceId?: string;
  readonly environmentVariable?: string;
}

type SecretValue = Pick<SettingsSecret, "value" | "redacted">;

export function mapSettingsSecrets(
  settings: ServerSettings,
  map: (secret: SettingsSecret) => SecretValue,
): ServerSettings {
  const mapFields = (
    fields: Readonly<Record<string, unknown>>,
    secretFields: ReadonlyArray<string>,
    name: (field: string, serverHost: string | null) => string,
  ) => {
    const next = { ...fields };
    for (const field of secretFields) {
      if (!(field in next)) continue;
      next[field] = writeSecretFieldValues(
        next[field],
        readSecretFieldValues(next[field]).map(([serverHost, value]) => {
          const result = map({
            secretName: name(field, serverHost),
            kind: "field",
            value,
            redacted: value === SECRET_REDACTED,
            sensitive: true,
          });
          return [serverHost, result.redacted ? SECRET_REDACTED : result.value] as const;
        }),
      );
    }
    return next;
  };

  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => {
      const config = instance.config;
      return [
        instanceId,
        {
          ...instance,
          ...(config !== null && typeof config === "object" && !Array.isArray(config)
            ? {
                config: mapFields(
                  config as Record<string, unknown>,
                  providerSecretFields.get(instance.driver) ?? [],
                  (field, serverHost) =>
                    `provider-config-${encode(instanceId)}-${encode(instance.driver)}-${encode(field)}` +
                    (serverHost === null ? "" : `-${encode(serverHost)}`),
                ),
              }
            : {}),
          ...(instance.environment
            ? {
                environment: instance.environment.map((variable) => {
                  const result = map({
                    secretName: `provider-env-${encode(instanceId)}-${encode(variable.name)}`,
                    kind: "environment",
                    value: variable.value,
                    redacted: variable.valueRedacted === true,
                    sensitive: variable.sensitive,
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                  });
                  const { valueRedacted: _omit, ...rest } = variable;
                  return {
                    ...rest,
                    value: result.value,
                    ...(result.redacted ? { valueRedacted: true } : {}),
                  };
                }),
              }
            : {}),
        },
      ];
    }),
  );

  const sourceControlHosts = Object.fromEntries(
    Object.entries(settings.sourceControlHosts).map(([kind, fields]) => [
      kind,
      mapFields(fields, SOURCE_CONTROL_HOST_SECRET_FIELDS.get(kind) ?? [], (field, serverHost) =>
        sourceControlHostSecretName({ kind, field, serverHost }),
      ),
    ]),
  ) as ServerSettings["sourceControlHosts"];

  const usageLimitSources = Object.fromEntries(
    Object.entries(settings.usageLimitSources).map(([id, source]) => [
      id,
      mapFields(
        source,
        usageLimitSecretFields,
        (field, serverHost) =>
          `usage-limit-source-${encode(id)}` +
          (field === "managementKey" && serverHost === null
            ? ""
            : `-${encode(field)}${serverHost === null ? "" : `-${encode(serverHost)}`}`),
      ),
    ]),
  ) as ServerSettings["usageLimitSources"];

  const easDeviceHosts = settings.easDeviceHosts.map(
    (host) =>
      mapFields(
        host,
        easDeviceHostSecretFields,
        (field, serverHost) =>
          `device-host-${encode(host.id)}-${encode(field)}` +
          (serverHost === null ? "" : `-${encode(serverHost)}`),
      ) as EasDeviceHostConfig,
  );

  // Env rows (stdio) and header rows (http) of user MCP servers, plus the OAuth
  // client secret of http ones. Sensitive values live in the store like provider
  // environment variables do.
  const mapRow = <Row extends ProviderInstanceEnvironmentVariable | McpServerHeader>(
    row: Row,
    secretName: string,
  ): Row => {
    const result = map({
      secretName,
      kind: "environment",
      value: row.value,
      redacted: row.valueRedacted === true,
      sensitive: row.sensitive,
      environmentVariable: row.name,
    });
    const { valueRedacted: _omit, ...rest } = row;
    return {
      ...rest,
      value: result.value,
      ...(result.redacted ? { valueRedacted: true } : {}),
    } as Row;
  };
  const withMcpSecrets = mapMcpEntries(
    { ...settings, providerInstances, sourceControlHosts, usageLimitSources, easDeviceHosts },
    (scope, name, server) => {
      const prefix = `${encode(scope)}-${encode(name)}`;
      if (server.transport === "stdio") {
        return {
          ...server,
          env: server.env.map((row) => mapRow(row, `mcp-env-${prefix}-${encode(row.name)}`)),
        };
      }
      const headers = server.headers.map((row) =>
        mapRow(row, `mcp-header-${prefix}-${encode(row.name)}`),
      );
      const clientSecret = server.oauth?.clientSecret;
      if (server.oauth === undefined || clientSecret === undefined) {
        return { ...server, headers };
      }
      const result = map({
        secretName: `mcp-oauth-client-secret-${prefix}`,
        kind: "environment",
        value: clientSecret.value,
        redacted: clientSecret.valueRedacted === true,
        sensitive: true,
        environmentVariable: "oauth.clientSecret",
      });
      return {
        ...server,
        headers,
        oauth: {
          ...server.oauth,
          clientSecret: {
            value: result.value,
            ...(result.redacted ? { valueRedacted: true } : {}),
          },
        },
      };
    },
  );

  return withMcpSecrets;
}

const textEncoder = new TextEncoder();

export type SecretChange = {
  readonly secretName: string;
  readonly providerInstanceId?: string;
  readonly environmentVariable?: string;
} & (
  | { readonly kind: "write"; readonly value: Uint8Array }
  | { readonly kind: "remove"; readonly operation: "remove-secret" | "remove-stale-secret" }
);

/**
 * Plans the secret-store writes and removals that turn `next` into its on-disk
 * form, and returns `next` with every secret redacted. A redacted row keeps the
 * stored value; plaintext hand-edited into `current` moves into the store.
 */
export function planSettingsSecretPersist(
  current: ServerSettings,
  next: ServerSettings,
): { readonly settings: ServerSettings; readonly changes: ReadonlyArray<SecretChange> } {
  const previous = new Map<string, SettingsSecret>();
  mapSettingsSecrets(current, (secret) => {
    previous.set(secret.secretName, secret);
    return secret;
  });
  const changes: SecretChange[] = [];
  const nextSecretNames = new Set<string>();
  const settings = mapSettingsSecrets(next, (secret) => {
    const metadata = {
      secretName: secret.secretName,
      ...(secret.providerInstanceId !== undefined
        ? { providerInstanceId: secret.providerInstanceId }
        : {}),
      ...(secret.environmentVariable !== undefined
        ? { environmentVariable: secret.environmentVariable }
        : {}),
    };
    if (!secret.sensitive) {
      changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
      return { value: secret.value, redacted: false };
    }
    const old = previous.get(secret.secretName);
    const inlineValue =
      old?.sensitive && !old.redacted && old.value.length > 0 ? old.value : undefined;
    const value = secret.redacted ? inlineValue : secret.value;
    if (value === undefined) {
      nextSecretNames.add(secret.secretName);
      return { value: "", redacted: true };
    }
    if (value.length === 0) {
      changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
      return { value: "", redacted: false };
    }
    nextSecretNames.add(secret.secretName);
    changes.push({ ...metadata, kind: "write", value: textEncoder.encode(value) });
    return { value: "", redacted: true };
  });
  for (const secret of previous.values()) {
    if (!secret.sensitive || nextSecretNames.has(secret.secretName)) continue;
    if (changes.some((change) => change.secretName === secret.secretName)) continue;
    changes.push({
      kind: "remove",
      secretName: secret.secretName,
      operation: "remove-stale-secret",
      ...(secret.providerInstanceId !== undefined
        ? { providerInstanceId: secret.providerInstanceId }
        : {}),
      ...(secret.environmentVariable !== undefined
        ? { environmentVariable: secret.environmentVariable }
        : {}),
    });
  }
  for (const secretName of planMcpSignInClears(current, next)) {
    changes.push({ kind: "remove", secretName, operation: "remove-secret" });
  }
  return { settings, changes };
}
