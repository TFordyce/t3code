/**
 * The generic walker behind every secret held in settings.json.
 *
 * Each secret-bearing field is described once as a `SecretKind` registered in
 * `SETTINGS_SECRET_KINDS`. A kind only knows how to visit its rows and how to
 * read and write one row's secret. Redacting for clients, persisting into the
 * secret store (with a change list the caller applies and rolls back), moving
 * hand-edited plaintext into the store, and materializing real values for the
 * server are written once here and run over every registered kind.
 *
 * The store key of a row is derived by its kind from scope, name and field
 * (for example a provider instance id plus a variable name).
 *
 * @module serverSettingsSecrets
 */
import {
  isMcpServerDisabledMarker,
  type McpServerConfig,
  type McpServerDisabledMarker,
  type McpServerHeader,
  type ProjectSettingsOverrides,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ServerSettings,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

/**
 * On disk a secret is replaced by this marker (or a `valueRedacted` flag) and
 * the real value lives in the secret store. A client that sends the marker back
 * means "keep what you have".
 */
export const SECRET_REDACTED = "••••••";

/** Names the row in errors and logs; never part of the store key. */
export interface SecretRowContext {
  readonly providerInstanceId?: string;
  readonly environmentVariable?: string;
}

/** One secret-bearing row, decoded from whatever shape its kind stores. */
export interface SecretEntry {
  /** Secret store key for the row. */
  readonly key: string;
  /** A non-sensitive row never reaches the store. */
  readonly sensitive: boolean;
  /** The value lives in the store; `value` is empty. */
  readonly redacted: boolean;
  readonly value: string;
  readonly context?: SecretRowContext;
}

/** What a kind should write back for a row. `resolved` means `value` is the real secret. */
export interface SecretValue {
  readonly redacted: boolean;
  readonly value: string;
  readonly resolved?: true;
}

/**
 * Registering a new secret-bearing field is one `SecretKind`: visit the rows in
 * a stable order, call `visit` for each, and rebuild the row from the answer.
 * Returning `undefined` from `visit` drops the row.
 */
export interface SecretKind {
  readonly map: (
    settings: ServerSettings,
    visit: (entry: SecretEntry) => SecretValue | undefined,
  ) => ServerSettings;
  /** Persisting an emptied row removes it instead of keeping an empty one. */
  readonly dropEmptyOnPersist?: true;
  /** Plaintext hand-edited into settings.json moves into the store on load. */
  readonly adoptInlineOnLoad?: true;
}

const encodeSecretName = (value: string) => Buffer.from(value, "utf8").toString("base64url");

/** Rows stored as a plain string where `SECRET_REDACTED` stands for "in the store". */
const markerEntry = (key: string, raw: string, context?: SecretRowContext): SecretEntry =>
  raw === SECRET_REDACTED
    ? { key, sensitive: true, redacted: true, value: "", ...(context ? { context } : {}) }
    : { key, sensitive: true, redacted: false, value: raw, ...(context ? { context } : {}) };

const markerValue = (next: SecretValue): string =>
  next.redacted && !next.resolved ? SECRET_REDACTED : next.value;

/** An env row rebuilt from what a kind's visitor answered for it. */
const applySecretValue = <Row extends ProviderInstanceEnvironmentVariable | McpServerHeader>(
  variable: Row,
  entry: SecretEntry,
  next: SecretValue,
): Row => {
  if (next.redacted === entry.redacted && next.value === entry.value) return variable;
  const { valueRedacted: _omit, ...rest } = variable;
  return {
    ...rest,
    value: next.value,
    ...(next.redacted ? { valueRedacted: true } : {}),
  };
};

const providerEnvironmentKind: SecretKind = {
  map: (settings, visit) => {
    const providerInstances: Record<string, ProviderInstanceConfig> = {
      ...settings.providerInstances,
    };
    for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
      if (!instance.environment) continue;
      const environment: ProviderInstanceEnvironmentVariable[] = [];
      for (const variable of instance.environment) {
        const entry: SecretEntry = {
          key: `provider-env-${encodeSecretName(instanceId)}-${encodeSecretName(variable.name)}`,
          sensitive: variable.sensitive,
          redacted: variable.valueRedacted === true,
          value: variable.value,
          context: { providerInstanceId: instanceId, environmentVariable: variable.name },
        };
        const next = visit(entry);
        if (next === undefined) continue;
        environment.push(applySecretValue(variable, entry, next));
      }
      providerInstances[instanceId] = { ...instance, environment } satisfies ProviderInstanceConfig;
    }
    return {
      ...settings,
      providerInstances: providerInstances as ServerSettings["providerInstances"],
    };
  },
};

const usageLimitSourceKind: SecretKind = {
  map: (settings, visit) => {
    const usageLimitSources: Record<string, UsageLimitSourceConfig> = {};
    for (const [sourceId, source] of Object.entries(settings.usageLimitSources)) {
      const next = visit(
        markerEntry(`usage-limit-source-${encodeSecretName(sourceId)}`, source.managementKey),
      );
      if (next === undefined) continue;
      usageLimitSources[sourceId] = { ...source, managementKey: markerValue(next) };
    }
    return {
      ...settings,
      usageLimitSources: usageLimitSources as ServerSettings["usageLimitSources"],
    };
  },
};

const BITBUCKET_FIELDS = [
  ["accessToken", "bitbucket-access-token"],
  ["apiToken", "bitbucket-api-token"],
] as const;

const bitbucketKind: SecretKind = {
  adoptInlineOnLoad: true,
  map: (settings, visit) => {
    const bitbucket = { ...settings.bitbucket };
    for (const [field, key] of BITBUCKET_FIELDS) {
      const next = visit(markerEntry(key, bitbucket[field]));
      if (next !== undefined) bitbucket[field] = markerValue(next);
    }
    return { ...settings, bitbucket };
  },
};

/** Hosts are case-insensitive; a patch can arrive before decoding lowercased its keys. */
const gitHubKind: SecretKind = {
  adoptInlineOnLoad: true,
  dropEmptyOnPersist: true,
  map: (settings, visit) => {
    const tokens: Record<string, string> = {};
    for (const [rawHost, raw] of Object.entries(settings.github.tokens)) {
      const host = rawHost.trim().toLowerCase();
      const next = visit(markerEntry(`github-token-${encodeSecretName(host)}`, raw));
      if (next !== undefined) tokens[host] = markerValue(next);
    }
    return { ...settings, github: { ...settings.github, tokens } };
  },
};

type McpServerEntries = Readonly<Record<string, McpServerConfig | McpServerDisabledMarker>>;

/**
 * Visits the rows of every MCP entry, environment-wide first and then each
 * project's overrides, and rebuilds the entries from the answers. The scope
 * is part of the store key, so a project override never shares a secret with
 * the environment entry of the same name.
 */
const mapMcpServerRows = (
  settings: ServerSettings,
  kind: "env" | "header",
  visit: (entry: SecretEntry) => SecretValue | undefined,
): ServerSettings => {
  const mapEntries = <Entries extends McpServerEntries>(scope: string, entries: Entries) => {
    const mapped: Record<string, McpServerConfig | McpServerDisabledMarker> = {};
    for (const [name, server] of Object.entries(entries)) {
      const wanted = kind === "header" ? "http" : "stdio";
      if (isMcpServerDisabledMarker(server) || server.transport !== wanted) {
        mapped[name] = server;
        continue;
      }
      const rows: ReadonlyArray<ProviderInstanceEnvironmentVariable | McpServerHeader> =
        server.transport === "http" ? server.headers : server.env;
      const next: Array<ProviderInstanceEnvironmentVariable | McpServerHeader> = [];
      for (const row of rows) {
        const entry: SecretEntry = {
          key: `mcp-${kind}-${encodeSecretName(scope)}-${encodeSecretName(name)}-${encodeSecretName(row.name)}`,
          sensitive: row.sensitive,
          redacted: row.valueRedacted === true,
          value: row.value,
          context: { environmentVariable: row.name },
        };
        const answer = visit(entry);
        if (answer === undefined) continue;
        next.push(applySecretValue(row, entry, answer));
      }
      mapped[name] =
        server.transport === "http"
          ? { ...server, headers: next as McpServerHeader[] }
          : { ...server, env: next as ProviderInstanceEnvironmentVariable[] };
    }
    return mapped as Entries;
  };

  const projectSettingsOverrides: Record<string, ProjectSettingsOverrides> = {};
  for (const [projectId, overrides] of Object.entries(settings.projectSettingsOverrides)) {
    projectSettingsOverrides[projectId] =
      overrides.mcpServers === undefined
        ? overrides
        : { ...overrides, mcpServers: mapEntries(`project:${projectId}`, overrides.mcpServers) };
  }
  return {
    ...settings,
    mcpServers: mapEntries("global", settings.mcpServers),
    projectSettingsOverrides:
      projectSettingsOverrides as ServerSettings["projectSettingsOverrides"],
  };
};

/** Sensitive header values of user HTTP MCP servers, keyed by scope, server and header. */
const mcpServerHeaderKind: SecretKind = {
  map: (settings, visit) => mapMcpServerRows(settings, "header", visit),
};

/** Sensitive env values of user MCP servers, keyed by scope, server and variable. */
const mcpServerEnvironmentKind: SecretKind = {
  map: (settings, visit) => mapMcpServerRows(settings, "env", visit),
};

/** Every secret-bearing settings field. Add a field here and it is covered everywhere. */
export const SETTINGS_SECRET_KINDS: ReadonlyArray<SecretKind> = [
  providerEnvironmentKind,
  usageLimitSourceKind,
  mcpServerEnvironmentKind,
  mcpServerHeaderKind,
  bitbucketKind,
  gitHubKind,
];

const collectEntries = (
  settings: ServerSettings,
  kinds: ReadonlyArray<SecretKind>,
): ReadonlyArray<SecretEntry> => {
  const entries: SecretEntry[] = [];
  for (const kind of kinds) {
    kind.map(settings, (entry) => {
      entries.push(entry);
      return { redacted: entry.redacted, value: entry.value };
    });
  }
  return entries;
};

/** Clients learn only that a secret is set. */
export function redactSettingsSecrets(
  settings: ServerSettings,
  kinds: ReadonlyArray<SecretKind> = SETTINGS_SECRET_KINDS,
): ServerSettings {
  return kinds.reduce(
    (current, kind) =>
      kind.map(current, (entry) =>
        entry.sensitive
          ? { redacted: entry.value.length > 0 || entry.redacted, value: "" }
          : { redacted: false, value: entry.value },
      ),
    settings,
  );
}

export type SecretChange = {
  readonly secretName: string;
  readonly context?: SecretRowContext;
} & (
  | { readonly kind: "write"; readonly value: Uint8Array }
  | { readonly kind: "remove"; readonly operation: "remove-secret" | "remove-stale-secret" }
);

const textEncoder = new TextEncoder();

/**
 * Plans the store writes and removals that turn `next` into its on-disk form,
 * and returns `next` with every secret redacted. A redacted row keeps the
 * stored value; plaintext hand-edited into `current` moves into the store.
 */
export function planSettingsSecretPersist(
  current: ServerSettings,
  next: ServerSettings,
  kinds: ReadonlyArray<SecretKind> = SETTINGS_SECRET_KINDS,
): { readonly settings: ServerSettings; readonly changes: ReadonlyArray<SecretChange> } {
  const currentEntries = collectEntries(current, kinds);
  // Duplicate keys: the last row wins.
  const currentByKey = new Map(currentEntries.map((entry) => [entry.key, entry]));
  const changes: SecretChange[] = [];
  const nextKeys = new Set<string>();

  const settings = kinds.reduce(
    (acc, kind) =>
      kind.map(acc, (entry): SecretValue | undefined => {
        const context = entry.context ? { context: entry.context } : {};
        if (!entry.sensitive) {
          changes.push({
            kind: "remove",
            secretName: entry.key,
            operation: "remove-secret",
            ...context,
          });
          return { redacted: false, value: entry.value };
        }
        nextKeys.add(entry.key);
        const previous = entry.redacted ? currentByKey.get(entry.key) : undefined;
        const inline =
          previous?.sensitive && !previous.redacted && previous.value.length > 0
            ? previous.value
            : undefined;
        if (entry.redacted && inline === undefined) return { redacted: true, value: "" };
        const value = inline ?? entry.value;
        if (value.length > 0) {
          changes.push({
            kind: "write",
            secretName: entry.key,
            value: textEncoder.encode(value),
            ...context,
          });
          return { redacted: true, value: "" };
        }
        changes.push({
          kind: "remove",
          secretName: entry.key,
          operation: "remove-secret",
          ...context,
        });
        return kind.dropEmptyOnPersist ? undefined : { redacted: false, value: "" };
      }),
    next,
  );

  for (const entry of currentEntries) {
    if (!entry.sensitive || nextKeys.has(entry.key)) continue;
    changes.push({
      kind: "remove",
      secretName: entry.key,
      operation: "remove-stale-secret",
      ...(entry.context ? { context: entry.context } : {}),
    });
  }
  return { settings, changes };
}

/**
 * Replaces every redacted row with its real value from the store; a row with
 * nothing stored becomes empty. `read` errors fail the whole walk.
 */
export const materializeSettingsSecrets = <E>(
  settings: ServerSettings,
  read: (entry: SecretEntry) => Effect.Effect<Option.Option<Uint8Array>, E>,
  kinds: ReadonlyArray<SecretKind> = SETTINGS_SECRET_KINDS,
): Effect.Effect<ServerSettings, E> =>
  Effect.gen(function* () {
    const decoder = new TextDecoder();
    const values = new Map<string, string>();
    for (const entry of collectEntries(settings, kinds)) {
      if (!entry.sensitive || !entry.redacted || values.has(entry.key)) continue;
      const stored = yield* read(entry);
      values.set(entry.key, stored._tag === "Some" ? decoder.decode(stored.value) : "");
    }
    return kinds.reduce(
      (acc, kind) =>
        kind.map(acc, (entry) =>
          entry.sensitive && entry.redacted
            ? { redacted: true, value: values.get(entry.key) ?? "", resolved: true }
            : { redacted: entry.redacted, value: entry.value },
        ),
      settings,
    );
  });

/**
 * Moves plaintext hand-edited into settings.json into the store as it loads.
 * `store` reports whether the row was saved; a row that was not stays plaintext
 * and is retried on the next load.
 */
export const adoptInlineSettingsSecrets = <R>(
  settings: ServerSettings,
  store: (entry: SecretEntry) => Effect.Effect<boolean, never, R>,
  kinds: ReadonlyArray<SecretKind> = SETTINGS_SECRET_KINDS,
): Effect.Effect<ServerSettings, never, R> =>
  Effect.gen(function* () {
    let result = settings;
    for (const kind of kinds) {
      if (!kind.adoptInlineOnLoad) continue;
      const moved = new Set<string>();
      for (const entry of collectEntries(result, [kind])) {
        if (!entry.sensitive || entry.redacted || entry.value.length === 0) continue;
        if (yield* store(entry)) moved.add(entry.key);
      }
      if (moved.size === 0) continue;
      result = kind.map(result, (entry) =>
        moved.has(entry.key)
          ? { redacted: true, value: "" }
          : { redacted: entry.redacted, value: entry.value },
      );
    }
    return result;
  });
