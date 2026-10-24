import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { McpServerStatus, Options } from "@anthropic-ai/claude-agent-sdk";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  ClaudeMcpAddServerConfig,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeMcpStatus from "./ClaudeMcpStatus.ts";

type FakeStatus = (call: number) => Promise<ReadonlyArray<McpServerStatus>>;

/** A faked SDK `query`: records the options it was started with and whether it was aborted. */
const makeFakeQuery = (mcpServerStatus: FakeStatus) => {
  const started: Array<Options> = [];
  const aborted: Array<boolean> = [];
  const toggles: Array<readonly [string, boolean]> = [];
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
      toggleMcpServer: (name: string, enabled: boolean) => {
        toggles.push([name, enabled]);
        return Promise.resolve();
      },
      mcpServerStatus: () => mcpServerStatus(++statusCalls),
    };
  }) as unknown as ClaudeMcpStatus.ClaudeMcpQuery;
  return { query, started, aborted, toggles, statusCalls: () => statusCalls };
};

/** A faked Claude CLI: records each call and answers with `result`. */
const makeFakeCli = (
  result: (
    call: ClaudeMcpStatus.ClaudeCliCall,
  ) => Partial<ClaudeMcpStatus.ClaudeCliOutput> = () => ({}),
) => {
  const calls: Array<ClaudeMcpStatus.ClaudeCliCall> = [];
  const runCli: ClaudeMcpStatus.ClaudeMcpCli = (call) =>
    Effect.sync(() => {
      calls.push(call);
      return { code: 0, stdout: "", stderr: "", ...result(call) };
    });
  return { runCli, calls };
};

const projectRow = (projectId: ProjectId, workspaceRoot: string): ProjectStore.ProjectRow => ({
  projectId,
  title: "App",
  workspaceRoot,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const layerFor = (
  query: ClaudeMcpStatus.ClaudeMcpQuery,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
  runCli: ClaudeMcpStatus.ClaudeMcpCli = makeFakeCli().runCli,
  /** Workspace roots of the projects this environment knows, by id. */
  projectRoots: Record<string, string> = {},
) => {
  const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (id) =>
      Effect.succeed(
        Option.fromNullishOr(projectRoots[id]).pipe(
          Option.map((workspaceRoot) => projectRow(id, workspaceRoot)),
        ),
      ),
  });
  const base = Layer.mergeAll(
    ServerSettings.layerTest(settings),
    McpProviderSessions.layer,
    NodeServices.layer,
    projects,
  );
  return ClaudeMcpStatus.makeLayer({ query, runCli }).pipe(Layer.provideMerge(base));
};

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

it.effect("detail redacts headers, env, args and URL query strings", () => {
  const fake = makeFakeQuery(() =>
    Promise.resolve([
      connected("remote", {
        serverInfo: { name: "Remote MCP", version: "1.2.0" },
        config: {
          type: "http",
          url: "https://user:pw@mcp.example.com/v1/mcp?token=secret#frag",
          headers: { Authorization: "Bearer secret" },
        },
        scope: "user",
        source: "user",
        tools: [
          { name: "read", description: "Reads", annotations: { readOnly: true, openWorld: true } },
          { name: "drop", annotations: { destructive: true } },
        ],
      }),
      connected("local", {
        config: {
          type: "stdio",
          command: "/usr/local/bin/npx",
          args: ["-y", "server", "--key=secret"],
          env: { API_KEY: "secret" },
        },
        scope: "project",
      }),
      connected("plain", { config: { command: "C:\\tools\\mcp-server.exe" }, scope: "user" }),
    ]),
  );
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const remote = yield* service.detail({ cwd: "/work/app", name: "remote" });
    assert.deepStrictEqual(remote.server, {
      name: "remote",
      status: "connected",
      toolCount: 2,
      scope: "user",
      source: "user",
      serverInfo: { name: "Remote MCP", version: "1.2.0" },
      transport: "http",
      url: "https://mcp.example.com/v1/mcp",
      tools: [
        { name: "read", description: "Reads", readOnly: true, destructive: false },
        { name: "drop", readOnly: false, destructive: true },
      ],
    });
    const local = yield* service.detail({ cwd: "/work/app", name: "local" });
    assert.equal(local.server?.transport, "stdio");
    assert.equal(local.server?.command, "npx");
    assert.notInclude(JSON.stringify(local), "secret");
    const plain = yield* service.detail({ cwd: "/work/app", name: "plain" });
    assert.equal(plain.server?.command, "mcp-server.exe");
  }).pipe(Effect.provide(layerFor(fake.query)));
});

it.effect(
  "detail reads the cached probe, probes on a miss, and is null for an unknown name",
  () => {
    const fake = makeFakeQuery(() => Promise.resolve([connected("docs", { scope: "user" })]));
    return Effect.gen(function* () {
      const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
      const missed = yield* service.detail({ cwd: "/work/app", name: "docs" });
      assert.equal(missed.server?.status, "connected");
      assert.equal(fake.started.length, 1);

      const list = yield* service.probe({ cwd: "/work/app" });
      const hit = yield* service.detail({ cwd: "/work/app", name: "docs" });
      assert.equal(hit.checkedAt, list.checkedAt);
      assert.equal(fake.started.length, 1);
      assert.deepStrictEqual(list.servers, [
        { name: "docs", status: "connected", toolCount: 2, scope: "user" },
      ]);

      const gone = yield* service.detail({ cwd: "/work/app", name: "removed" });
      assert.isNull(gone.server);
      assert.equal(fake.started.length, 1);
    }).pipe(Effect.provide(layerFor(fake.query)));
  },
);

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

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");

it.effect("probes with the disabled list applied and reports those servers as disabled", () => {
  const fake = makeFakeQuery(() =>
    Promise.resolve([connected("docs", { scope: "project" }), connected("gmail")]),
  );
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const result = yield* service.probe({ cwd: "/work/app" });
    assert.deepStrictEqual(fake.toggles, [["docs", false]]);
    assert.deepStrictEqual(fake.started[0]?.settings, {
      disableAllHooks: true,
      disabledMcpjsonServers: ["docs"],
    });
    assert.deepStrictEqual(
      result.servers.map((server) => [server.name, server.status, server.toolCount]),
      [
        ["docs", "disabled", 0],
        ["gmail", "connected", 2],
      ],
    );
  }).pipe(Effect.provide(layerFor(fake.query, { claudeDisabledMcpServers: ["docs"] })));
});

it.effect("uses the project's own disabled list when it overrides the environment's", () => {
  const fake = makeFakeQuery(() => Promise.resolve([connected("docs"), connected("gmail")]));
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    yield* service.probe({ cwd: "/work/app", projectId });
    assert.deepStrictEqual(fake.toggles, [["gmail", false]]);
    yield* service.probe({ cwd: "/work/app", projectId: otherProjectId });
    assert.deepStrictEqual(fake.toggles, [
      ["gmail", false],
      ["docs", false],
    ]);
  }).pipe(
    Effect.provide(
      layerFor(fake.query, {
        claudeDisabledMcpServers: ["docs"],
        projectSettingsOverrides: { [projectId]: { claudeDisabledMcpServers: ["gmail"] } },
      }),
    ),
  );
});

it.effect("disabling a server with no running session saves it and re-probes fresh", () => {
  const fake = makeFakeQuery(() => Promise.resolve([connected("docs")]));
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const settings = yield* ServerSettings.ServerSettingsService;
    const before = yield* service.probe({ cwd: "/work/app" });
    assert.equal(before.servers[0]?.status, "connected");

    yield* service.setServerEnabled({ name: "docs", enabled: false });
    assert.deepStrictEqual((yield* settings.getSettings).claudeDisabledMcpServers, ["docs"]);

    const after = yield* service.probe({ cwd: "/work/app" });
    assert.equal(after.servers[0]?.status, "disabled");

    yield* service.setServerEnabled({ name: "docs", enabled: true });
    assert.deepStrictEqual((yield* settings.getSettings).claudeDisabledMcpServers, []);
  }).pipe(Effect.provide(layerFor(fake.query)));
});

it.effect("a project toggle writes the project's list, seeded from what applies to it", () => {
  const fake = makeFakeQuery(() => Promise.resolve([]));
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* service.setServerEnabled({ name: "gmail", enabled: false, projectId });
    const stored = yield* settings.getSettings;
    assert.deepStrictEqual(stored.claudeDisabledMcpServers, ["docs"]);
    assert.deepStrictEqual(stored.projectSettingsOverrides[projectId]?.claudeDisabledMcpServers, [
      "docs",
      "gmail",
    ]);
  }).pipe(Effect.provide(layerFor(fake.query, { claudeDisabledMcpServers: ["docs"] })));
});

it.effect("a toggle reaches live sessions whose effective list changed, and only those", () => {
  const fake = makeFakeQuery(() => Promise.resolve([]));
  const live: Array<readonly [string, string, boolean]> = [];
  const register = (threadId: string, session: ProjectId) =>
    McpProviderSessions.McpProviderSessions.pipe(
      Effect.flatMap((sessions) =>
        sessions.setLiveToggle(ThreadId.make(threadId), {
          projectId: session,
          toggle: (name, enabled) => Effect.sync(() => void live.push([threadId, name, enabled])),
          reconnect: () => Effect.succeed(true),
        }),
      ),
    );
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    yield* register("t-a", projectId);
    yield* register("t-b", otherProjectId);

    yield* service.setServerEnabled({ name: "docs", enabled: false });
    // `projectId` pins its own list, so only the other project's session changes.
    assert.deepStrictEqual(live, [["t-b", "docs", false]]);

    yield* service.setServerEnabled({ name: "docs", enabled: false, projectId });
    assert.deepStrictEqual(live.at(-1), ["t-a", "docs", false]);
    assert.equal(live.length, 2);

    yield* service.setServerEnabled({ name: "docs", enabled: true });
    assert.deepStrictEqual(live.at(-1), ["t-b", "docs", true]);
    assert.equal(live.length, 3);
  }).pipe(
    Effect.provide(
      layerFor(fake.query, {
        projectSettingsOverrides: { [projectId]: { claudeDisabledMcpServers: [] } },
      }),
    ),
  );
});

it.effect("reconnect reaches the thread's live process", () => {
  const fake = makeFakeQuery(() => Promise.resolve([]));
  const reconnected: Array<string> = [];
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    yield* sessions.setLiveToggle(ThreadId.make("t-a"), {
      projectId,
      toggle: () => Effect.void,
      reconnect: (name) => Effect.sync(() => void reconnected.push(name)).pipe(Effect.as(true)),
    });
    yield* service.reconnectServer({ threadId: ThreadId.make("t-a"), name: "docs" });
    assert.deepStrictEqual(reconnected, ["docs"]);
  }).pipe(Effect.provide(layerFor(fake.query)));
});

it.effect("reconnect says there is no session when the thread has no live process", () => {
  const fake = makeFakeQuery(() => Promise.resolve([]));
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    const none = yield* service
      .reconnectServer({ threadId: ThreadId.make("t-none"), name: "docs" })
      .pipe(Effect.flip);
    assert.equal(none.reason, "noSession");

    yield* sessions.setLiveToggle(ThreadId.make("t-closed"), {
      projectId,
      toggle: () => Effect.void,
      reconnect: () => Effect.succeed(false),
    });
    const closed = yield* service
      .reconnectServer({ threadId: ThreadId.make("t-closed"), name: "docs" })
      .pipe(Effect.flip);
    assert.equal(closed.reason, "noSession");
  }).pipe(Effect.provide(layerFor(fake.query)));
});

it.effect("reconnect surfaces a refusal from Claude", () => {
  const fake = makeFakeQuery(() => Promise.resolve([]));
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    yield* sessions.setLiveToggle(ThreadId.make("t-a"), {
      projectId,
      toggle: () => Effect.void,
      reconnect: () => Effect.fail({ message: "refused" }),
    });
    const error = yield* service
      .reconnectServer({ threadId: ThreadId.make("t-a"), name: "docs" })
      .pipe(Effect.flip);
    assert.equal(error.reason, "failed");
  }).pipe(Effect.provide(layerFor(fake.query)));
});

it.effect("a fresh request re-probes its own directory and leaves the others cached", () => {
  let probes = 0;
  const fake = makeFakeQuery(() => Promise.resolve([connected(`probe-${++probes}`)]));
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    yield* service.probe({ cwd: "/work/app" });
    const other = yield* service.probe({ cwd: "/work/other" });
    assert.equal(fake.started.length, 2);

    const fresh = yield* service.probe({ cwd: "/work/app", fresh: true });
    assert.equal(fresh.servers[0]?.name, "probe-3");
    assert.equal(fake.started.length, 3);

    // Later plain reads see the fresh result; the other directory keeps its own.
    const after = yield* service.probe({ cwd: "/work/app" });
    assert.deepStrictEqual(after, fresh);
    assert.deepStrictEqual(yield* service.probe({ cwd: "/work/other" }), other);
    assert.equal(fake.started.length, 3);
  }).pipe(Effect.provide(layerFor(fake.query)));
});

it.effect("concurrent fresh requests for one directory share a single probe", () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fake = makeFakeQuery(() => {
    entered.resolve();
    return release.promise.then(() => [connected("a")]);
  });
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const fresh = service.probe({ cwd: "/work/app", fresh: true });
    const all = yield* Effect.forkChild(
      Effect.all([fresh, fresh, service.probe({ cwd: "/work/app" })], {
        concurrency: "unbounded",
      }),
    );
    yield* Effect.promise(() => entered.promise);
    release.resolve();
    yield* Fiber.join(all);
    assert.equal(fake.started.length, 1);
  }).pipe(Effect.provide(layerFor(fake.query)));
});

/** Settings that configure the default Claude instance with `config`. */
const claudeAgent = (config: Record<string, unknown>) => ({
  providerInstances: {
    [ProviderInstanceId.make("claudeAgent")]: {
      driver: ProviderDriverKind.make("claudeAgent"),
      config,
    },
  },
});

const projectRoots = { [projectId]: "/repos/app" };

it.effect(
  "remove runs claude mcp remove at the reported scope, a local one in the project root",
  () => {
    const fake = makeFakeQuery(() => Promise.resolve([]));
    const cli = makeFakeCli();
    return Effect.gen(function* () {
      const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
      yield* service.removeServer({ name: "docs", scope: "local", cwd: "/work/app", projectId });
      yield* service.removeServer({ name: "my server", scope: "user", cwd: "/work/app" });
      assert.deepStrictEqual(
        cli.calls.map((call) => [call.binaryPath, call.args, call.cwd]),
        [
          ["/opt/claude", ["mcp", "remove", "docs", "-s", "local"], "/repos/app"],
          ["/opt/claude", ["mcp", "remove", "my server", "-s", "user"], undefined],
        ],
      );
    }).pipe(
      Effect.provide(
        layerFor(fake.query, claudeAgent({ binaryPath: "/opt/claude" }), cli.runCli, projectRoots),
      ),
    );
  },
);

const decodeServerJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ClaudeMcpAddServerConfig),
);

const stdioServer = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@acme/mcp", "--flag=a b"],
  env: { API_KEY: "secret" },
} as const;

it.effect("add runs claude mcp add-json at user scope in the probe's Claude environment", () => {
  const fake = makeFakeQuery(() => Promise.resolve([]));
  const cli = makeFakeCli();
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    yield* service.addServer({
      cwd: "/work/app",
      name: "acme",
      scope: "user",
      server: stdioServer,
    });
    assert.equal(cli.calls.length, 1);
    const call = cli.calls[0]!;
    assert.equal(call.binaryPath, "/opt/claude");
    assert.deepStrictEqual(call.args.slice(0, 3), ["mcp", "add-json", "acme"]);
    assert.deepStrictEqual(yield* decodeServerJson(call.args[3]), stdioServer);
    assert.deepStrictEqual(call.args.slice(4), ["-s", "user"]);
    assert.isUndefined(call.cwd);
    assert.equal(call.env.CLAUDE_CONFIG_DIR, (yield* Path.Path).resolve("/claude-home"));
  }).pipe(
    Effect.provide(
      layerFor(
        fake.query,
        claudeAgent({ binaryPath: "/opt/claude", homePath: "/claude-home" }),
        cli.runCli,
      ),
    ),
  );
});

it.effect(
  "a local add runs Claude in the project's workspace root, not the list's directory",
  () => {
    const fake = makeFakeQuery(() => Promise.resolve([]));
    const cli = makeFakeCli();
    return Effect.gen(function* () {
      const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
      yield* service.addServer({
        cwd: "/somewhere/else",
        projectId,
        name: "acme",
        scope: "local",
        server: stdioServer,
      });
      assert.equal(cli.calls.length, 1);
      const call = cli.calls[0]!;
      assert.deepStrictEqual(call.args.slice(4), ["-s", "local"]);
      assert.equal(call.cwd, "/repos/app");
      assert.equal(call.env.CLAUDE_CONFIG_DIR, (yield* Path.Path).resolve("/claude-home"));
    }).pipe(
      Effect.provide(
        layerFor(
          fake.query,
          claudeAgent({ binaryPath: "/opt/claude", homePath: "/claude-home" }),
          cli.runCli,
          projectRoots,
        ),
      ),
    );
  },
);

it.effect("a local add or remove for an unknown project fails without running Claude", () => {
  const fake = makeFakeQuery(() => Promise.resolve([]));
  const cli = makeFakeCli();
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const target = { cwd: "/work/app", projectId, name: "acme", scope: "local" } as const;
    const added = yield* service.addServer({ ...target, server: stdioServer }).pipe(Effect.flip);
    const removed = yield* service.removeServer(target).pipe(Effect.flip);
    assert.deepStrictEqual([added.reason, removed.reason], ["project", "project"]);
    assert.equal(cli.calls.length, 0);
  }).pipe(Effect.provide(layerFor(fake.query, {}, cli.runCli)));
});

it.effect("add passes an HTTP server to add-json as Claude's http JSON, headers included", () => {
  const fake = makeFakeQuery(() => Promise.resolve([]));
  const cli = makeFakeCli();
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    yield* service.addServer({
      cwd: "/work/app",
      name: "linear",
      scope: "user",
      server: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: 'Bearer "x" %PATH% !bang' },
      },
    });
    const call = cli.calls[0]!;
    assert.deepStrictEqual(call.args.slice(0, 3), ["mcp", "add-json", "linear"]);
    assert.deepStrictEqual(JSON.parse(call.args[3]!), {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: 'Bearer "x" %PATH% !bang' },
    });
    assert.deepStrictEqual(call.args.slice(4), ["-s", "user"]);
  }).pipe(Effect.provide(layerFor(fake.query, {}, cli.runCli)));
});

it.effect("remove runs Claude with the probe's Claude home", () => {
  const fake = makeFakeQuery(() => Promise.resolve([]));
  const cli = makeFakeCli();
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    yield* service.probe({ cwd: "/work/app" });
    yield* service.removeServer({ name: "docs", scope: "user", cwd: "/work/app" });
    const probeHome = fake.started[0]?.env?.CLAUDE_CONFIG_DIR;
    assert.isDefined(probeHome);
    assert.equal(cli.calls[0]?.env.CLAUDE_CONFIG_DIR, probeHome);
  }).pipe(
    Effect.provide(
      layerFor(fake.query, claudeAgent({ homePath: "/profiles/work-claude" }), cli.runCli),
    ),
  );
});

it.effect("add and remove pass Claude's own error text back and skip the re-probe", () => {
  const fake = makeFakeQuery(() => Promise.resolve([]));
  const cli = makeFakeCli((call) => ({
    code: 1,
    stderr: `Claude refused ${call.args[1]}\n`,
  }));
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    const removed = yield* service
      .removeServer({ name: "docs", scope: "user", cwd: "/work/app" })
      .pipe(Effect.flip);
    const added = yield* service
      .addServer({ cwd: "/work/app", name: "acme", scope: "user", server: stdioServer })
      .pipe(Effect.flip);
    assert.deepStrictEqual(
      [removed.reason, removed.message, added.reason, added.message],
      ["rejected", "Claude refused remove", "rejected", "Claude refused add-json"],
    );
    assert.equal(fake.started.length, 0);
  }).pipe(Effect.provide(layerFor(fake.query, {}, cli.runCli)));
});

it.effect("add and remove name a Claude that could not start the same way", () => {
  const fake = makeFakeQuery(() => Promise.resolve([]));
  const launchFailing =
    (reason: ClaudeMcpStatus.ClaudeCliLaunchError["reason"]): ClaudeMcpStatus.ClaudeMcpCli =>
    () =>
      Effect.fail(new ClaudeMcpStatus.ClaudeCliLaunchError({ reason }));
  const reasonsWith = (runCli: ClaudeMcpStatus.ClaudeMcpCli) =>
    Effect.gen(function* () {
      const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
      const added = yield* service
        .addServer({ cwd: "/work/app", name: "acme", scope: "user", server: stdioServer })
        .pipe(Effect.flip);
      const removed = yield* service
        .removeServer({ name: "acme", scope: "user", cwd: "/work/app" })
        .pipe(Effect.flip);
      return [added.reason, removed.reason];
    }).pipe(Effect.provide(layerFor(fake.query, {}, runCli)));
  return Effect.gen(function* () {
    assert.deepStrictEqual(yield* reasonsWith(launchFailing("spawnFailed")), [
      "startFailed",
      "startFailed",
    ]);
    assert.deepStrictEqual(yield* reasonsWith(launchFailing("unsupportedLauncher")), [
      "unsupportedLauncher",
      "unsupportedLauncher",
    ]);
  });
});

it.effect("a successful add runs the fresh probe after success", () => {
  let added = false;
  const fake = makeFakeQuery(() =>
    Promise.resolve(added ? [connected("docs"), connected("acme")] : [connected("docs")]),
  );
  const cli = makeFakeCli(() => {
    added = true;
    return {};
  });
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    yield* service.probe({ cwd: "/work/app" });
    yield* service.addServer({
      cwd: "/work/app",
      name: "acme",
      scope: "user",
      server: stdioServer,
    });
    assert.equal(fake.started.length, 2);
    const after = yield* service.probe({ cwd: "/work/app" });
    assert.deepStrictEqual(
      after.servers.map((server) => server.name),
      ["docs", "acme"],
    );
    assert.equal(fake.started.length, 2);
  }).pipe(Effect.provide(layerFor(fake.query, {}, cli.runCli)));
});

it.effect("a successful remove runs the fresh probe after success", () => {
  let removed = false;
  const fake = makeFakeQuery(() =>
    Promise.resolve(removed ? [connected("docs")] : [connected("docs"), connected("acme")]),
  );
  const cli = makeFakeCli(() => {
    removed = true;
    return {};
  });
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    yield* service.probe({ cwd: "/work/app", projectId });
    yield* service.removeServer({ name: "acme", scope: "local", cwd: "/work/app", projectId });
    assert.equal(fake.started.length, 2);
    const after = yield* service.probe({ cwd: "/work/app", projectId });
    assert.deepStrictEqual(
      after.servers.map((server) => server.name),
      ["docs"],
    );
    assert.equal(fake.started.length, 2);
  }).pipe(Effect.provide(layerFor(fake.query, {}, cli.runCli, projectRoots)));
});

it.effect("add refuses a name T3 configures, in any project, without running Claude", () => {
  const fake = makeFakeQuery(() => Promise.resolve([]));
  const cli = makeFakeCli();
  const docs = { transport: "stdio", command: "npx", args: [], env: [] } as const;
  return Effect.gen(function* () {
    const service = yield* ClaudeMcpStatus.ClaudeMcpStatus;
    for (const name of ["docs", "project-only", "t3-code-x"]) {
      const error = yield* service
        .addServer({ cwd: "/work/app", name, scope: "user", server: stdioServer })
        .pipe(Effect.flip);
      assert.equal(error.reason, "invalidName");
    }
    assert.equal(cli.calls.length, 0);
  }).pipe(
    Effect.provide(
      layerFor(
        fake.query,
        {
          mcpServers: { docs },
          projectSettingsOverrides: { [projectId]: { mcpServers: { "project-only": docs } } },
        },
        cli.runCli,
      ),
    ),
  );
});
