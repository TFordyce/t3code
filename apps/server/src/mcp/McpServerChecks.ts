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
import type {
  McpServerCheck,
  McpServerCheckStatus,
  McpServerCheckTarget,
  McpServerConfig,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSettings from "../serverSettings.ts";
import * as McpUpstream from "./McpUpstream.ts";

const GLOBAL_SCOPE = "global";
const CHECK_TIMEOUT = Duration.seconds(15);
const MAX_TOOL_PAGES = 20;
const MAX_ERROR_LENGTH = 300;

type Checks = ReadonlyArray<McpServerCheck>;

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
    const state = yield* SubscriptionRef.make<Checks>([]);
    const generations = new Map<string, number>();
    const everChecked = yield* Ref.make(false);

    const keyOf = (name: string) => `${GLOBAL_SCOPE}:${name}`;
    const replace = (name: string, next: McpServerCheck | undefined) =>
      SubscriptionRef.update(state, (checks) => {
        const others = checks.filter((c) => !(c.scope === GLOBAL_SCOPE && c.name === name));
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
              const entry = yield* upstream.resolve(name, null);
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

    const checkOne = Effect.fn("McpServerChecks.checkOne")(function* (name: string) {
      const current = yield* settings.getSettings.pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      const config = current?.mcpServers[name];
      const generation = (generations.get(keyOf(name)) ?? 0) + 1;
      generations.set(keyOf(name), generation);
      if (config === undefined || !isEnabled(config)) {
        yield* replace(name, undefined);
        return;
      }
      const checkedAt = new Date().toISOString();
      yield* replace(name, { scope: GLOBAL_SCOPE, name, status: "checking", checkedAt });
      const outcome = yield* probe(name, config);
      // An edit or removal that landed meanwhile owns the row now.
      if (generations.get(keyOf(name)) !== generation) return;
      yield* replace(name, { scope: GLOBAL_SCOPE, name, checkedAt, ...outcome });
    });

    const check: McpServerChecks["Service"]["check"] = Effect.fn("McpServerChecks.check")(
      function* (targets) {
        yield* Ref.set(everChecked, true);
        const configured = yield* settings.getSettings.pipe(
          Effect.map((current) => Object.keys(current.mcpServers)),
          Effect.catch(() => Effect.succeed([] as Array<string>)),
        );
        const requested =
          targets === undefined
            ? [
                ...new Set([
                  ...configured,
                  ...(yield* SubscriptionRef.get(state)).map((c) => c.name),
                ]),
              ]
            : targets.filter((t) => t.scope === GLOBAL_SCOPE).map((t) => t.name);
        yield* Effect.forEach(requested, checkOne, { concurrency: "unbounded", discard: true });
      },
    );

    // Edits re-check just the entries whose config changed. The first
    // emission only sets the baseline, so nothing runs at boot.
    let previous = yield* settings.getSettings.pipe(
      Effect.map((current) => current.mcpServers),
      Effect.catch(() => Effect.succeed({} as Record<string, McpServerConfig>)),
    );
    yield* settings.streamChanges.pipe(
      Stream.runForEach((next) => {
        const before = previous;
        previous = next.mcpServers;
        const names = new Set([...Object.keys(before), ...Object.keys(next.mcpServers)]);
        const changed = [...names].filter(
          (name) => JSON.stringify(before[name]) !== JSON.stringify(next.mcpServers[name]),
        );
        return Effect.forEach(changed, checkOne, { concurrency: "unbounded", discard: true });
      }),
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
