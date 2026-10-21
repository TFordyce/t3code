import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { McpServerStatus, Options } from "@anthropic-ai/claude-agent-sdk";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeMcpStatus from "./ClaudeMcpStatus.ts";

type FakeStatus = (call: number) => Promise<ReadonlyArray<McpServerStatus>>;

/** A faked SDK `query`: records the options it was started with and whether it was aborted. */
const makeFakeQuery = (mcpServerStatus: FakeStatus) => {
  const started: Array<Options> = [];
  const aborted: Array<boolean> = [];
  let statusCalls = 0;
  const query = ((args: { readonly options?: Options }) => {
    const options = args.options ?? {};
    started.push(options);
    const index = started.length - 1;
    options.abortController?.signal.addEventListener("abort", () => {
      aborted[index] = true;
    });
    return {
      initializationResult: () => Promise.resolve({}),
      mcpServerStatus: () => mcpServerStatus(++statusCalls),
    };
  }) as unknown as ClaudeMcpStatus.ClaudeMcpQuery;
  return { query, started, aborted, statusCalls: () => statusCalls };
};

const layerFor = (query: ClaudeMcpStatus.ClaudeMcpQuery) =>
  ClaudeMcpStatus.makeLayer({ query }).pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(NodeServices.layer),
  );

const connected = (name: string, extra: Partial<McpServerStatus> = {}): McpServerStatus => ({
  name,
  status: "connected",
  tools: [{ name: "a" }, { name: "b" }],
  ...extra,
});

it.effect("returns every reported server with status, tool count, scope and source", () => {
  const fake = makeFakeQuery(() =>
    Promise.resolve([
      connected("claude.ai Gmail", { scope: "claudeai", source: "claudeai" }),
      {
        name: "docs",
        status: "failed",
        error: "spawn ENOENT",
        scope: "project",
        source: "project",
      },
      { name: "gated", status: "needs-auth", scope: "user", source: "user" },
    ]),
  );
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const result = yield* service.probe({ cwd: "/work/app" });
    assert.deepStrictEqual(result.servers, [
      {
        name: "claude.ai Gmail",
        status: "connected",
        toolCount: 2,
        scope: "claudeai",
        source: "claudeai",
      },
      {
        name: "docs",
        status: "failed",
        toolCount: 0,
        error: "spawn ENOENT",
        scope: "project",
        source: "project",
      },
      { name: "gated", status: "needs-auth", toolCount: 0, scope: "user", source: "user" },
    ]);
    assert.isTrue(fake.aborted[0]);
  }).pipe(Effect.provide(layerFor(fake.query)));
});

it.effect("probes with its own options: project config and connectors on, hooks off", () => {
  const fake = makeFakeQuery(() => Promise.resolve([]));
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    yield* service.probe({ cwd: "/work/app" });
    const options = fake.started[0]!;
    assert.equal(options.cwd, "/work/app");
    assert.equal(options.strictMcpConfig, undefined);
    assert.equal(options.mcpServers, undefined);
    assert.deepStrictEqual(options.settingSources, ["user", "project", "local"]);
    assert.deepStrictEqual(options.settings, { disableAllHooks: true });
    assert.notEqual(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  }).pipe(Effect.provide(layerFor(fake.query)));
});

it.effect("waits out pending servers and returns once none is pending", () => {
  const fake = makeFakeQuery((call) =>
    Promise.resolve(
      call < 3 ? [{ name: "slow", status: "pending" }] : [connected("slow", { scope: "user" })],
    ),
  );
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const fiber = yield* Effect.forkChild(service.probe({ cwd: "/work/app" }));
    yield* TestClock.adjust(Duration.seconds(5));
    const result = yield* Fiber.join(fiber);
    assert.equal(result.servers[0]?.status, "connected");
    assert.equal(fake.statusCalls(), 3);
  }).pipe(Effect.provide(layerFor(fake.query)));
});

it.effect("fails with a timeout when a server stays pending, aborts, and does not cache", () => {
  const fake = makeFakeQuery(() => Promise.resolve([{ name: "stuck", status: "pending" }]));
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const fiber = yield* Effect.forkChild(service.probe({ cwd: "/work/app" }).pipe(Effect.flip));
    yield* TestClock.adjust(Duration.minutes(2));
    const error = yield* Fiber.join(fiber);
    assert.equal(error.reason, "timeout");
    assert.isTrue(fake.aborted[0]);

    const retry = yield* Effect.forkChild(service.probe({ cwd: "/work/app" }).pipe(Effect.flip));
    yield* TestClock.adjust(Duration.minutes(2));
    yield* Fiber.join(retry);
    assert.equal(fake.started.length, 2);
  }).pipe(Effect.provide(layerFor(fake.query)));
});

it.effect("does not cache errors", () => {
  const fake = makeFakeQuery((call) =>
    call === 1 ? Promise.reject(new Error("boom")) : Promise.resolve([connected("a")]),
  );
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const error = yield* service.probe({ cwd: "/work/app" }).pipe(Effect.flip);
    assert.equal(error.reason, "startFailed");
    const result = yield* service.probe({ cwd: "/work/app" });
    assert.equal(result.servers.length, 1);
    assert.equal(fake.started.length, 2);
  }).pipe(Effect.provide(layerFor(fake.query)));
});

it.effect("caches a success per working directory for five minutes", () => {
  const fake = makeFakeQuery(() => Promise.resolve([connected("a")]));
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const first = yield* service.probe({ cwd: "/work/app" });
    yield* TestClock.adjust(Duration.minutes(4));
    const second = yield* service.probe({ cwd: "/work/app" });
    assert.deepStrictEqual(second, first);
    assert.equal(fake.started.length, 1);

    yield* service.probe({ cwd: "/work/other" });
    assert.equal(fake.started.length, 2);

    yield* TestClock.adjust(Duration.minutes(2));
    yield* service.probe({ cwd: "/work/app" });
    assert.equal(fake.started.length, 3);
  }).pipe(Effect.provide(layerFor(fake.query)));
});

it.effect("dedupes concurrent requests for the same working directory", () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fake = makeFakeQuery(() => {
    entered.resolve();
    return release.promise.then(() => [connected("a")]);
  });
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const both = yield* Effect.forkChild(
      Effect.all([service.probe({ cwd: "/work/app" }), service.probe({ cwd: "/work/app" })], {
        concurrency: "unbounded",
      }),
    );
    yield* Effect.promise(() => entered.promise);
    release.resolve();
    yield* Fiber.join(both);
    assert.equal(fake.started.length, 1);
  }).pipe(Effect.provide(layerFor(fake.query)));
});
