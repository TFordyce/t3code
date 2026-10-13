/**
 * T3's own test of each configured user MCP server, run from the environment
 * host: the MCP client does `initialize` then `tools/list` and the result is
 * kept in memory.
 *
 * Checks run when an entry is created or edited, when a client asks for one,
 * and once lazily the first time a client asks for the results after boot.
 * Never at boot and never on a timer. Stdio servers are spawned with their
 * materialized env and killed afterwards; HTTP servers are reached through
 * {@link McpUpstream}, which applies the entry's headers.
 *
 * @module McpServerChecks
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isMcpServerDisabledMarker,
  type McpServerCheck,
  type McpServerCheckStatus,
  type McpServerCheckTarget,
  type McpServerConfig,
  type ProjectId,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSettings from "../serverSettings.ts";
import * as McpSignIn from "./McpSignIn.ts";
import * as McpUpstream from "./McpUpstream.ts";

const GLOBAL_SCOPE = "global";
const CHECK_TIMEOUT = Duration.seconds(15);
const MAX_TOOL_PAGES = 20;
const MAX_ERROR_LENGTH = 300;

type Checks = ReadonlyArray<McpServerCheck>;

/** One configured entry as a check sees it: environment-wide, or a project's full config. */
interface ConfiguredEntry {
  readonly scope: string;
  readonly name: string;
  readonly config: McpServerConfig;
}

const keyOf = (scope: string, name: string) => `${scope}:${name}`;

/** Every entry that can be checked. Project markers have nothing to check and are left out. */
const configuredEntries = (
  settings: Pick<ServerSettingsValue, "mcpServers" | "projectSettingsOverrides">,
): ReadonlyMap<string, ConfiguredEntry> => {
  const entries = new Map<string, ConfiguredEntry>();
  for (const [name, config] of Object.entries(settings.mcpServers)) {
    entries.set(keyOf(GLOBAL_SCOPE, name), { scope: GLOBAL_SCOPE, name, config });
  }
  for (const [projectId, overrides] of Object.entries(settings.projectSettingsOverrides)) {
    for (const [name, override] of Object.entries(overrides.mcpServers ?? {})) {
      if (isMcpServerDisabledMarker(override)) continue;
      entries.set(keyOf(projectId, name), { scope: projectId, name, config: override });
    }
  }
  return entries;
};

export class McpServerChecks extends Context.Service<
  McpServerChecks,
  {
    /** The results held right now. */
    readonly current: Effect.Effect<Checks>;
    /** The current set, then the full set again on every change. */
    readonly streamChanges: Stream.Stream<Checks>;
    /**
     * Checks the targets (every configured server when absent) and completes
     * once each has a result. Targets that are gone or turned off lose their
     * result instead.
     */
    readonly check: (targets?: ReadonlyArray<McpServerCheckTarget>) => Effect.Effect<void>;
    /** The first call after boot checks every server; later calls do nothing. */
    readonly ensureChecked: Effect.Effect<void>;
  }
>()("t3/mcp/McpServerChecks") {}

interface Outcome {
  readonly status: Exclude<McpServerCheckStatus, "checking">;
  readonly toolCount?: number;
  readonly error?: string;
}

const failed = (error: string): Outcome => ({ status: "failed", error });

const errorMessage = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}...` : message;
};

const rowsOf = (config: McpServerConfig) =>
  config.transport === "stdio" ? config.env : config.headers;

/** A sensitive row whose value the secret store no longer holds. */
const missingSecret = (config: McpServerConfig) =>
  rowsOf(config).find((row) => row.sensitive && row.valueRedacted === true && row.value === "");

const isEnabled = (config: McpServerConfig) => config.enabled !== false;

const make = (timeout: Duration.Duration) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const upstream = yield* McpUpstream.McpUpstream;
    const signIn = yield* McpSignIn.McpSignIn;
    const state = yield* SubscriptionRef.make<Checks>([]);
    const generations = new Map<string, number>();
    const everChecked = yield* Ref.make(false);

    const replace = (scope: string, name: string, next: McpServerCheck | undefined) =>
      SubscriptionRef.update(state, (checks) => {
        const others = checks.filter((c) => !(c.scope === scope && c.name === name));
        return next === undefined ? others : [...others, next];
      });

    /** Lists every tool of a connected client, following pagination. */
    const countTools = async (client: Client, signal: AbortSignal) => {
      let count = 0;
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const result = await client.listTools(cursor === undefined ? undefined : { cursor }, {
          signal,
        });
        count += result.tools.length;
        cursor = result.nextCursor;
        if (cursor === undefined) break;
      }
      return count;
    };

    const probeStdio = async (
      config: Extract<McpServerConfig, { transport: "stdio" }>,
      signal: AbortSignal,
    ): Promise<Outcome> => {
      const client = new Client({ name: "t3-code-check", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: config.command,
        args: [...config.args],
        env: Object.fromEntries(config.env.map((row) => [row.name, row.value])),
        stderr: "ignore",
      });
      try {
        await client.connect(transport, { signal });
        return { status: "connected", toolCount: await countTools(client, signal) };
      } finally {
        await client.close().catch(() => undefined);
      }
    };

    const probeHttp = async (
      entry: McpUpstream.McpUpstreamEntry,
      signal: AbortSignal,
    ): Promise<Outcome> => {
      let challenged = false;
      // Only POSTs are sent: the standalone SSE stream and session teardown
      // are not needed to count tools.
      const fetchViaUpstream = async (_url: string | URL, init?: RequestInit) => {
        if (init?.method !== "POST" || typeof init.body !== "string") {
          return new Response(null, { status: 405 });
        }
        const headers: Record<string, string> = {};
        new Headers(init.headers).forEach((value, key) => {
          headers[key] = value;
        });
        const sent = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const response = yield* upstream.send(entry, {
                method: "POST",
                headers,
                body: new TextEncoder().encode(init.body as string),
              });
              return {
                status: response.status,
                headers: response.headers,
                bytes: new Uint8Array(yield* response.arrayBuffer),
              };
            }),
          ),
          { signal },
        );
        if (sent.status === 401 || (sent.status >= 400 && sent.headers["www-authenticate"])) {
          challenged = true;
        }
        const bodyless = sent.status === 204 || sent.status === 205 || sent.bytes.length === 0;
        return new Response(bodyless ? null : sent.bytes, {
          status: sent.status,
          headers: sent.headers,
        });
      };
      const client = new Client({ name: "t3-code-check", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
        fetch: fetchViaUpstream as typeof fetch,
      }) as Transport;
      try {
        await client.connect(transport, { signal });
        return { status: "connected", toolCount: await countTools(client, signal) };
      } catch (cause) {
        if (challenged || (cause instanceof StreamableHTTPError && cause.code === 401)) {
          return { status: "needs-auth" };
        }
        throw cause;
      } finally {
        await client.close().catch(() => undefined);
      }
    };

    const probe = Effect.fn("McpServerChecks.probe")(function* (
      scope: string,
      name: string,
      config: McpServerConfig,
    ) {
      const missing = missingSecret(config);
      if (missing !== undefined) {
        return failed(`The stored secret for "${missing.name}" is missing. Enter it again.`);
      }
      const run =
        config.transport === "stdio"
          ? Effect.tryPromise((signal) => probeStdio(config, signal))
          : Effect.gen(function* () {
              const entry = yield* upstream.resolve(
                name,
                scope === GLOBAL_SCOPE ? null : (scope as ProjectId),
              );
              if (entry === undefined) {
                return failed("The server's stored secrets could not be read.");
              }
              return yield* Effect.tryPromise((signal) => probeHttp(entry, signal));
            });
      return yield* run.pipe(
        Effect.timeoutOption(timeout),
        Effect.map((outcome) =>
          outcome._tag === "Some"
            ? outcome.value
            : failed(`Timed out after ${Duration.toSeconds(timeout)}s.`),
        ),
        Effect.catch((cause) =>
          Effect.succeed(failed(errorMessage("cause" in cause ? cause.cause : cause))),
        ),
      );
    });

    const checkOne = Effect.fn("McpServerChecks.checkOne")(function* (
      target: McpServerCheckTarget,
    ) {
      const { scope, name } = target;
      const key = keyOf(scope, name);
      const current = yield* settings.getSettings.pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      const config =
        current === undefined ? undefined : configuredEntries(current).get(key)?.config;
      const generation = (generations.get(key) ?? 0) + 1;
      generations.set(key, generation);
      if (config === undefined || !isEnabled(config)) {
        yield* replace(scope, name, undefined);
        return;
      }
      // @effect-diagnostics-next-line globalDateInEffect:off - wall-clock timestamp shown to the user.
      const checkedAt = new Date().toISOString();
      const previousAuth = (yield* SubscriptionRef.get(state)).find(
        (row) => row.scope === scope && row.name === name,
      )?.auth;
      yield* replace(scope, name, {
        scope,
        name,
        status: "checking",
        checkedAt,
        ...(previousAuth === undefined ? {} : { auth: previousAuth }),
      });
      const outcome = yield* probe(scope, name, config);
      // An edit or removal that landed meanwhile owns the row now.
      if (generations.get(key) !== generation) return;
      // `auth` stays absent until the server has shown OAuth: a sign-in exists,
      // an OAuth client is configured, the server asked for one, or it was shown before.
      const stored =
        config.transport === "http" ? yield* signIn.authState({ scope, name }) : undefined;
      const auth =
        stored ??
        (config.transport === "http" &&
        (config.oauth !== undefined ||
          outcome.status === "needs-auth" ||
          previousAuth !== undefined)
          ? ("signed-out" as const)
          : undefined);
      yield* replace(scope, name, {
        scope,
        name,
        checkedAt,
        ...outcome,
        ...(auth === undefined ? {} : { auth }),
      });
    });

    const check: McpServerChecks["Service"]["check"] = Effect.fn("McpServerChecks.check")(
      function* (targets) {
        yield* Ref.set(everChecked, true);
        const requested: ReadonlyArray<McpServerCheckTarget> =
          targets ??
          (yield* Effect.gen(function* () {
            const configured = yield* settings.getSettings.pipe(
              Effect.map((current) => [...configuredEntries(current).values()]),
              Effect.catch(() => Effect.succeed([] as Array<ConfiguredEntry>)),
            );
            const held = yield* SubscriptionRef.get(state);
            const unique = new Map<string, McpServerCheckTarget>();
            for (const { scope, name } of [...configured, ...held]) {
              unique.set(keyOf(scope, name), { scope, name });
            }
            return [...unique.values()];
          }));
        yield* Effect.forEach(requested, checkOne, { concurrency: "unbounded", discard: true });
      },
    );

    // Edits re-check just the entries whose config changed. The first
    // emission only sets the baseline, so nothing runs at boot.
    let previous = yield* settings.getSettings.pipe(
      Effect.map(configuredEntries),
      Effect.catch(() => Effect.succeed(new Map<string, ConfiguredEntry>())),
    );
    yield* settings.streamChanges.pipe(
      Stream.runForEach((next) => {
        const before = previous;
        const after = configuredEntries(next);
        previous = after;
        const changed = [...new Set([...before.keys(), ...after.keys()])]
          .filter((key) => JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)))
          .map((key) => {
            const entry = after.get(key) ?? before.get(key)!;
            return { scope: entry.scope, name: entry.name };
          });
        return Effect.forEach(changed, checkOne, { concurrency: "unbounded", discard: true });
      }),
      Effect.forkScoped({ startImmediately: true }),
    );

    // A sign-in, sign-out or failed refresh shows up as a fresh check of that entry.
    yield* signIn.changes.pipe(
      Stream.runForEach((target) => checkOne(target)),
      Effect.forkScoped({ startImmediately: true }),
    );

    return McpServerChecks.of({
      current: SubscriptionRef.get(state),
      streamChanges: SubscriptionRef.changes(state),
      check,
      ensureChecked: Ref.getAndSet(everChecked, true).pipe(
        Effect.flatMap((already) => (already ? Effect.void : check())),
      ),
    });
  });

export const layerWithTimeout = (timeoutMs: number) =>
  Layer.effect(McpServerChecks, make(Duration.millis(timeoutMs)));

export const layer = Layer.effect(McpServerChecks, make(CHECK_TIMEOUT));
