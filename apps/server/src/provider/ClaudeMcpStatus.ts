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
  type AddClaudeMcpServerInput,
  ClaudeMcpAddError,
  ClaudeMcpAddServerConfig,
  ClaudeMcpReconnectError,
  ClaudeMcpStatusError,
  ClaudeMcpToggleError,
  ClaudeSettings,
  claudeMcpServerNameError,
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
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
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
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeSdkExecutablePath } from "./Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CACHE_TTL = Duration.minutes(5);
const CACHE_CAPACITY = 32;
// Stdio servers and claude.ai connectors can take a while to connect.
const SETTLE_TIMEOUT = Duration.seconds(30);
const PENDING_POLL_INTERVAL = Duration.millis(500);
// `claude mcp` edits a config file and exits; it never starts a server.
const CLI_TIMEOUT = Duration.seconds(30);

const PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const encodeServerJson = Schema.encodeSync(Schema.fromJsonString(ClaudeMcpAddServerConfig));

class ProbeKey extends Data.Class<{
  readonly cwd: string;
  readonly disabledServers: ReadonlyArray<string>;
}> {}

/** The SDK `query` entry point, injectable so tests can fake the Claude process. */
export type ClaudeMcpQuery = typeof claudeQuery;

/** One run of Claude's CLI: `binaryPath` is the configured Claude binary, `env` the probe's environment. */
export interface ClaudeCliCall {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

export interface ClaudeCliOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Claude's CLI could not be started at all; a non-zero exit is an output, not this. */
export class ClaudeCliLaunchError extends Data.TaggedError("ClaudeCliLaunchError")<{
  readonly reason: "unsupportedLauncher" | "spawnFailed";
  readonly cause?: unknown;
}> {}

/** Runs Claude's CLI, injectable so tests can fake the Claude process. */
export type ClaudeMcpCli = (
  call: ClaudeCliCall,
) => Effect.Effect<ClaudeCliOutput, ClaudeCliLaunchError>;

/**
 * Runs Claude without a shell. On Windows an npm `claude.cmd` shim is skipped
 * for the executable behind it; a launcher that still needs `cmd.exe` is
 * refused, since server JSON (quotes, `%`, `!`) doesn't survive its parsing.
 */
const makeClaudeCli = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runCli: ClaudeMcpCli = Effect.fn("ClaudeMcpStatus.runCli")(function* (call) {
    const spawn = yield* resolveSpawnCommand(call.binaryPath, call.args, {
      env: call.env,
      bypassNpmShim: true,
    });
    if (spawn.shell) return yield* new ClaudeCliLaunchError({ reason: "unsupportedLauncher" });
    const command = ChildProcess.make(spawn.command, spawn.args, {
      env: call.env,
      ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
    });
    return yield* spawnAndCollect(call.binaryPath, command).pipe(
      Effect.timeout(CLI_TIMEOUT),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError((cause) => new ClaudeCliLaunchError({ reason: "spawnFailed", cause })),
    );
  });
  return runCli;
});

/** The names T3 configures, environment-wide or in any project: a Claude server may not reuse one. */
const t3ServerNames = (settings: ServerSettingsValue): ReadonlyArray<string> => [
  ...Object.keys(settings.mcpServers),
  ...Object.values(settings.projectSettingsOverrides).flatMap((override) =>
    Object.keys(override?.mcpServers ?? {}),
  ),
];

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
    /**
     * Adds a server to Claude's own config with `claude mcp add-json`, in the
     * probe's Claude environment, then re-probes the input's list fresh. Only
     * Claude's CLI writes its config: `~/.claude.json` is large and Claude
     * rewrites it constantly. Running sessions keep what they loaded.
     */
    readonly addServer: (input: AddClaudeMcpServerInput) => Effect.Effect<void, ClaudeMcpAddError>;
  }
>()("t3/provider/ClaudeMcpStatus") {}

const make = Effect.fn("ClaudeMcpStatus.make")(function* (
  query: ClaudeMcpQuery,
  injectedCli: ClaudeMcpCli | undefined,
) {
  const runCli = injectedCli ?? (yield* makeClaudeCli);
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

  /** The Claude settings and environment both the probe and the CLI run with. */
  const resolveClaude = resolveSettings.pipe(
    Effect.flatMap((settings) =>
      makeClaudeEnvironment(settings).pipe(
        Effect.provideService(Path.Path, path),
        Effect.map((environment) => ({ settings, environment })),
      ),
    ),
  );

  const runProbe = Effect.fn("ClaudeMcpStatus.probe")(function* (key: ProbeKey) {
    const { cwd, disabledServers } = key;
    const disabled = new Set(disabledServers);
    const { settings, environment } = yield* resolveClaude;
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

  const addServer = Effect.fn("ClaudeMcpStatus.addServer")(function* (
    input: AddClaudeMcpServerInput,
  ) {
    const serverSettings = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => new ClaudeMcpAddError({ reason: "settings", cause })),
    );
    const nameError = claudeMcpServerNameError(input.name, t3ServerNames(serverSettings));
    if (nameError !== undefined) {
      return yield* new ClaudeMcpAddError({ reason: "invalidName", detail: nameError });
    }
    const { settings, environment } = yield* resolveClaude.pipe(
      Effect.mapError((cause) => new ClaudeMcpAddError({ reason: "settings", cause })),
    );
    const output = yield* runCli({
      binaryPath: settings.binaryPath,
      args: ["mcp", "add-json", input.name, encodeServerJson(input.server), "-s", input.scope],
      env: environment,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeMcpAddError({
            reason: cause.reason === "unsupportedLauncher" ? "unsupportedLauncher" : "rejected",
            cause,
          }),
      ),
    );
    if (output.code !== 0) {
      const detail = output.stderr.trim() || output.stdout.trim();
      return yield* new ClaudeMcpAddError({
        reason: "rejected",
        ...(detail.length === 0 ? {} : { detail }),
      });
    }
    // The add has landed; a failed re-probe shows on the list, not here.
    yield* cachedProbe({ cwd: input.cwd, projectId: input.projectId, fresh: true }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("claude-mcp-add-reprobe-failed", { cause })),
    );
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
    addServer,
  });
});

export const makeLayer = (options?: {
  readonly query?: ClaudeMcpQuery;
  readonly runCli?: ClaudeMcpCli;
}) => Layer.effect(ClaudeMcpStatus, make(options?.query ?? claudeQuery, options?.runCli));

export const layer = makeLayer();
