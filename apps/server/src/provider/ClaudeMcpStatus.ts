/**
 * Asks Claude which MCP servers it would load for a working directory, with
 * each server's status and tool count.
 *
 * This is a heavier probe than the capabilities probe: it honours project and
 * local `.mcp.json`, enables claude.ai connectors, and so really starts stdio
 * servers. It therefore stays out of the generic provider refresh and is
 * reached only through {@link ClaudeMcpStatus.probe}, which dedupes in-flight
 * requests and caches successes per working directory.
 *
 * @module ClaudeMcpStatus
 */
import {
  query as claudeQuery,
  type McpServerStatus,
  type Options as ClaudeQueryOptions,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeMcpReconnectError,
  ClaudeMcpStatusError,
  ClaudeMcpToggleError,
  ClaudeSettings,
  defaultInstanceIdForDriver,
  type ClaudeMcpServerDetail,
  type ClaudeMcpServerDetailInput,
  type ClaudeMcpServerDetailResult,
  type ClaudeMcpServerReport,
  type ClaudeMcpStatusInput,
  type ClaudeMcpStatusResult,
  type ProjectId,
  type ReconnectClaudeMcpServerInput,
  ProviderDriverKind,
  type ServerSettings as ServerSettingsValue,
  type SetClaudeMcpServerEnabledInput,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeSdkExecutablePath } from "./Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CACHE_TTL = Duration.minutes(5);
const CACHE_CAPACITY = 32;
// Stdio servers and claude.ai connectors can take a while to connect.
const SETTLE_TIMEOUT = Duration.seconds(30);
const PENDING_POLL_INTERVAL = Duration.millis(500);

const PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

class ProbeKey extends Data.Class<{
  readonly cwd: string;
  readonly disabledServers: ReadonlyArray<string>;
}> {}

/** The SDK `query` entry point, injectable so tests can fake the Claude process. */
export type ClaudeMcpQuery = typeof claudeQuery;

/**
 * Unlike the capabilities probe this keeps project and local MCP sources and
 * claude.ai connectors, so it passes no `mcpServers` or `strictMcpConfig`.
 * Hooks stay off: the probe runs on page open, and SessionStart hooks must not.
 */
function buildClaudeMcpProbeQueryOptions(input: {
  readonly disabledServers: ReadonlyArray<string>;
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...PROBE_SETTING_SOURCES],
    // `disabledMcpjsonServers` keeps project `.mcp.json` servers from starting
    // at all; the rest are switched off right after init (see `runProbe`).
    settings: {
      disableAllHooks: true,
      ...(input.disabledServers.length === 0
        ? {}
        : { disabledMcpjsonServers: [...input.disabledServers] }),
    },
    allowedTools: [],
    env: {
      ...input.environment,
      // Unset rather than "true": an inherited opt-out must not hide connectors here.
      ENABLE_CLAUDEAI_MCP_SERVERS: undefined,
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    cwd: input.cwd,
    stderr: () => {},
  };
}

/** A probe result as cached: every server's redacted detail, so the list and detail RPCs share one probe. */
interface ProbeResult {
  readonly servers: ReadonlyArray<ClaudeMcpServerDetail>;
  readonly checkedAt: string;
}

/** Drops userinfo, query string and fragment, where remote server credentials live. */
function redactUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/** Only the executable's own name: its directory, args and env stay on the server. */
const commandName = (command: string) => command.split(/[\\/]/).at(-1) ?? command;

function transportOf(
  config: McpServerStatus["config"],
): Pick<ClaudeMcpServerDetail, "transport" | "url" | "command"> {
  if (config === undefined) return {};
  switch (config.type) {
    case undefined:
    case "stdio":
      return { transport: "stdio", command: commandName(config.command) };
    case "http":
    case "sse":
    case "claudeai-proxy": {
      const url = redactUrl(config.url);
      return {
        transport: config.type === "claudeai-proxy" ? "claudeai" : config.type,
        ...(url === undefined ? {} : { url }),
      };
    }
    default:
      return { transport: "sdk" };
  }
}

/**
 * The redacted detail for one reported server. Everything that could carry a
 * secret (headers, env, args, URL query strings) is dropped here, before
 * caching, so nothing downstream can send it.
 */
function toDetail(server: McpServerStatus, disabled: ReadonlySet<string>): ClaudeMcpServerDetail {
  const isDisabled = disabled.has(server.name);
  const tools = isDisabled ? [] : (server.tools ?? []);
  return {
    name: server.name,
    status: isDisabled ? "disabled" : server.status,
    toolCount: tools.length,
    ...(server.error === undefined || isDisabled ? {} : { error: server.error }),
    ...(server.scope === undefined ? {} : { scope: server.scope }),
    ...(server.source === undefined ? {} : { source: server.source }),
    ...(server.serverInfo === undefined || isDisabled
      ? {}
      : { serverInfo: { name: server.serverInfo.name, version: server.serverInfo.version } }),
    ...transportOf(server.config),
    tools: tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      readOnly: tool.annotations?.readOnly === true,
      destructive: tool.annotations?.destructive === true,
    })),
  };
}

/** The lean list row: counts only, so the list payload doesn't grow with tools. */
const toReport = (detail: ClaudeMcpServerDetail): ClaudeMcpServerReport => ({
  name: detail.name,
  status: detail.status,
  toolCount: detail.toolCount,
  ...(detail.error === undefined ? {} : { error: detail.error }),
  ...(detail.scope === undefined ? {} : { scope: detail.scope }),
  ...(detail.source === undefined ? {} : { source: detail.source }),
});

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** The names Claude must not load for a project (or the environment when `projectId` is absent). */
const disabledServersFor = (
  settings: ServerSettingsValue,
  projectId: ProjectId | undefined,
): ReadonlyArray<string> =>
  resolveProjectSettings(settings, projectId ?? null).settings.claudeDisabledMcpServers;

export class ClaudeMcpStatus extends Context.Service<
  ClaudeMcpStatus,
  {
    /**
     * Every MCP server Claude would load in `cwd`, with the disabled list that
     * applies to `projectId` honoured. Cached for five minutes per directory
     * and list; `fresh` drops that one entry and asks Claude again.
     */
    readonly probe: (
      input: ClaudeMcpStatusInput,
    ) => Effect.Effect<ClaudeMcpStatusResult, ClaudeMcpStatusError>;
    /**
     * One server's redacted detail, read from the same cached probe as
     * {@link probe} and probing on a miss. `server` is null when Claude no
     * longer reports that name.
     */
    readonly detail: (
      input: ClaudeMcpServerDetailInput,
    ) => Effect.Effect<ClaudeMcpServerDetailResult, ClaudeMcpStatusError>;
    /**
     * Turns one server on or off: saves it to the environment's disabled list
     * (or the project's own, seeded from what applies to it) and switches it
     * in every running Claude session it newly applies to. T3 never edits
     * Claude's own config files. Works with no session running.
     */
    readonly setServerEnabled: (
      input: SetClaudeMcpServerEnabledInput,
    ) => Effect.Effect<void, ClaudeMcpToggleError>;
    /**
     * Reconnects one server in the thread's running Claude process. Fails with
     * `noSession` when the thread has none; the caller re-probes afterwards.
     */
    readonly reconnectServer: (
      input: ReconnectClaudeMcpServerInput,
    ) => Effect.Effect<void, ClaudeMcpReconnectError>;
  }
>()("t3/provider/ClaudeMcpStatus") {}

const make = Effect.fn("ClaudeMcpStatus.make")(function* (query: ClaudeMcpQuery) {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const liveSessions = yield* McpProviderSessions.McpProviderSessions;
  const path = yield* Path.Path;

  const resolveSettings = settingsService.getSettings.pipe(
    Effect.flatMap((settings) =>
      Effect.try(() =>
        decodeClaudeSettings(
          settings.providerInstances[defaultInstanceIdForDriver(CLAUDE_DRIVER_KIND)]?.config ?? {},
        ),
      ),
    ),
    Effect.mapError((cause) => new ClaudeMcpStatusError({ reason: "settings", cause })),
  );

  const runProbe = Effect.fn("ClaudeMcpStatus.probe")(function* (key: ProbeKey) {
    const { cwd, disabledServers } = key;
    const disabled = new Set(disabledServers);
    const settings = yield* resolveSettings;
    const environment = yield* makeClaudeEnvironment(settings).pipe(
      Effect.provideService(Path.Path, path),
    );
    const executablePath = yield* resolveClaudeSdkExecutablePath(settings.binaryPath, environment);
    const abort = new AbortController();
    const started = yield* Effect.try({
      try: () =>
        query({
          // Never yields: the process initializes and reports MCP state
          // without any model request.
          // oxlint-disable-next-line require-yield
          prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
            await waitForAbortSignal(abort.signal);
          })(),
          options: buildClaudeMcpProbeQueryOptions({
            executablePath,
            abortController: abort,
            environment,
            cwd,
            disabledServers,
          }),
        }),
      catch: (cause) => new ClaudeMcpStatusError({ reason: "startFailed", cause }),
    });

    const readSettled = Effect.gen(function* () {
      yield* Effect.tryPromise(() => started.initializationResult());
      // A name Claude does not know (a connector the user has since removed)
      // fails to toggle; the rest of the list still applies.
      yield* Effect.forEach(
        disabledServers,
        (name) => Effect.tryPromise(() => started.toggleMcpServer(name, false)).pipe(Effect.ignore),
        { discard: true },
      );
      while (true) {
        const servers = yield* Effect.tryPromise(() => started.mcpServerStatus());
        if (!servers.some((server) => server.status === "pending")) return servers;
        yield* Effect.sleep(PENDING_POLL_INTERVAL);
      }
    }).pipe(Effect.mapError((cause) => new ClaudeMcpStatusError({ reason: "startFailed", cause })));

    const settled = yield* readSettled.pipe(
      Effect.timeoutOption(SETTLE_TIMEOUT),
      Effect.ensuring(Effect.sync(() => abort.abort())),
    );
    if (Option.isNone(settled)) {
      return yield* new ClaudeMcpStatusError({ reason: "timeout" });
    }
    return {
      servers: settled.value.map((server) => toDetail(server, disabled)),
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies ProbeResult;
  });

  // Cache.get dedupes concurrent lookups for a key; only successes are kept.
  // Keyed by directory and disabled list, so a toggle never serves a stale probe.
  const cache = yield* Cache.makeWith(runProbe, {
    capacity: CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? CACHE_TTL : Duration.zero),
  });

  // Keys with a fresh probe in flight: a second fresh request joins it rather
  // than dropping it and starting another Claude process. The Cache alone can't
  // tell: `invalidate` drops an in-flight entry too, and `refresh` always runs
  // a new lookup.
  const freshInFlight = MutableHashSet.empty<ProbeKey>();
  const probeFresh = (key: ProbeKey) =>
    Effect.suspend(() => {
      if (MutableHashSet.has(freshInFlight, key)) return Cache.get(cache, key);
      MutableHashSet.add(freshInFlight, key);
      return Cache.invalidate(cache, key).pipe(
        Effect.andThen(Cache.get(cache, key)),
        Effect.ensuring(Effect.sync(() => MutableHashSet.remove(freshInFlight, key))),
      );
    });

  const setServerEnabled = Effect.fn("ClaudeMcpStatus.setServerEnabled")(
    function* (input: SetClaudeMcpServerEnabledInput) {
      const before = yield* settingsService.getSettings;
      const current = disabledServersFor(before, input.projectId);
      const next = input.enabled
        ? current.filter((name) => name !== input.name)
        : current.includes(input.name)
          ? current
          : [...current, input.name];
      yield* settingsService.updateSettings(
        input.projectId === undefined
          ? { claudeDisabledMcpServers: [...next] }
          : {
              projectSettingsOverrides: {
                [input.projectId]: {
                  ...before.projectSettingsOverrides[input.projectId],
                  claudeDisabledMcpServers: [...next],
                },
              },
            },
      );
      const after = yield* settingsService.getSettings;
      // Each live session answers for its own project: a global change skips a
      // project that keeps its own list, and a project change skips the others.
      const toggles = yield* liveSessions.liveToggles;
      yield* Effect.forEach(
        toggles,
        (live) => {
          const wasDisabled = disabledServersFor(before, live.projectId).includes(input.name);
          const isDisabled = disabledServersFor(after, live.projectId).includes(input.name);
          return wasDisabled === isDisabled
            ? Effect.void
            : live
                .toggle(input.name, !isDisabled)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("claude-mcp-live-toggle-failed", { name: input.name, cause }),
                  ),
                );
        },
        { discard: true },
      );
    },
    Effect.mapError((cause) => new ClaudeMcpToggleError({ cause })),
  );

  const reconnectServer = Effect.fn("ClaudeMcpStatus.reconnectServer")(function* (
    input: ReconnectClaudeMcpServerInput,
  ) {
    const live = yield* liveSessions.liveToggle(input.threadId);
    if (live === undefined) return yield* new ClaudeMcpReconnectError({ reason: "noSession" });
    const reconnected = yield* live
      .reconnect(input.name)
      .pipe(Effect.mapError((cause) => new ClaudeMcpReconnectError({ reason: "failed", cause })));
    if (!reconnected) return yield* new ClaudeMcpReconnectError({ reason: "noSession" });
  });

  const cachedProbe = Effect.fnUntraced(function* (input: {
    readonly cwd: string;
    readonly projectId?: ProjectId | undefined;
    readonly fresh?: boolean | undefined;
  }) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => new ClaudeMcpStatusError({ reason: "settings", cause })),
    );
    const key = new ProbeKey({
      cwd: input.cwd,
      disabledServers: [...disabledServersFor(settings, input.projectId)],
    });
    return yield* input.fresh === true ? probeFresh(key) : Cache.get(cache, key);
  });

  return ClaudeMcpStatus.of({
    probe: (input) =>
      cachedProbe(input).pipe(
        Effect.map((result): ClaudeMcpStatusResult => ({
          servers: result.servers.map(toReport),
          checkedAt: result.checkedAt,
        })),
      ),
    detail: (input) =>
      cachedProbe(input).pipe(
        Effect.map((result): ClaudeMcpServerDetailResult => ({
          server: result.servers.find((server) => server.name === input.name) ?? null,
          checkedAt: result.checkedAt,
        })),
      ),
    setServerEnabled,
    reconnectServer,
  });
});

export const makeLayer = (options?: { readonly query?: ClaudeMcpQuery }) =>
  Layer.effect(ClaudeMcpStatus, make(options?.query ?? claudeQuery));

export const layer = makeLayer();
