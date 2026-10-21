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
  ClaudeMcpStatusError,
  ClaudeSettings,
  type ClaudeMcpServerReport,
  type ClaudeMcpStatusInput,
  type ClaudeMcpStatusResult,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
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

/** The SDK `query` entry point, injectable so tests can fake the Claude process. */
export type ClaudeMcpQuery = typeof claudeQuery;

/**
 * Unlike the capabilities probe this keeps project and local MCP sources and
 * claude.ai connectors, so it passes no `mcpServers` or `strictMcpConfig`.
 * Hooks stay off: the probe runs on page open, and SessionStart hooks must not.
 */
function buildClaudeMcpProbeQueryOptions(input: {
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
    settings: { disableAllHooks: true },
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

function toReport(server: McpServerStatus): ClaudeMcpServerReport {
  return {
    name: server.name,
    status: server.status,
    toolCount: server.tools?.length ?? 0,
    ...(server.error === undefined ? {} : { error: server.error }),
    ...(server.scope === undefined ? {} : { scope: server.scope }),
    ...(server.source === undefined ? {} : { source: server.source }),
  };
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export class ClaudeMcpStatus extends Context.Service<
  ClaudeMcpStatus,
  {
    /** Every MCP server Claude would load in `cwd`. Cached for five minutes per directory. */
    readonly probe: (
      input: ClaudeMcpStatusInput,
    ) => Effect.Effect<ClaudeMcpStatusResult, ClaudeMcpStatusError>;
  }
>()("t3/provider/ClaudeMcpStatus") {}

const make = Effect.fn("ClaudeMcpStatus.make")(function* (query: ClaudeMcpQuery) {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;

  const resolveSettings = settingsService.getSettings.pipe(
    Effect.flatMap((settings) =>
      Effect.try(() =>
        decodeClaudeSettings(settings.providerInstances[CLAUDE_DRIVER_KIND]?.config ?? {}),
      ),
    ),
    Effect.mapError((cause) => new ClaudeMcpStatusError({ reason: "settings", cause })),
  );

  const runProbe = Effect.fn("ClaudeMcpStatus.probe")(function* (cwd: string) {
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
          }),
        }),
      catch: (cause) => new ClaudeMcpStatusError({ reason: "startFailed", cause }),
    });

    const readSettled = Effect.gen(function* () {
      yield* Effect.tryPromise(() => started.initializationResult());
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
      servers: settled.value.map(toReport),
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies ClaudeMcpStatusResult;
  });

  // Cache.get dedupes concurrent lookups for a key; only successes are kept.
  const cache = yield* Cache.makeWith(runProbe, {
    capacity: CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? CACHE_TTL : Duration.zero),
  });

  return ClaudeMcpStatus.of({
    probe: ({ cwd }) => Cache.get(cache, cwd),
  });
});

export const makeLayer = (options?: { readonly query?: ClaudeMcpQuery }) =>
  Layer.effect(ClaudeMcpStatus, make(options?.query ?? claudeQuery));

export const layer = makeLayer();
