import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  type McpServerCheck,
  type McpServerConfig,
  type ServerSettings as ServerSettingsType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import * as McpServerChecks from "./McpServerChecks.ts";
import * as McpSignIn from "./McpSignIn.ts";
import { layerMemorySecretStore } from "./McpSignIn.testkit.ts";
import * as McpUpstream from "./McpUpstream.ts";

const fixture = fileURLToPath(new URL("./fakeMcpStdioServer.fixture.mjs", import.meta.url));

const json = (res: NodeHttp.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** A minimal streamable HTTP MCP server: `/mcp` works, `/auth` demands sign-in, `/hang` never answers. */
const startFakeHttpServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<NodeHttp.Server>((resolve) => {
        const server = NodeHttp.createServer((req, res) => {
          const chunks: Array<Buffer> = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            if (req.url === "/auth") {
              res.writeHead(401, { "www-authenticate": 'Bearer realm="up"' });
              res.end();
              return;
            }
            if (req.url === "/hang") return;
            if (req.url === "/key" && req.headers["x-api-key"] !== "k-1") {
              res.writeHead(403);
              res.end();
              return;
            }
            if (req.method !== "POST") {
              res.writeHead(405);
              res.end();
              return;
            }
            const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              id?: number;
              method: string;
              params?: { protocolVersion?: string };
            };
            if (message.method === "initialize") {
              json(res, 200, {
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: message.params?.protocolVersion,
                  capabilities: { tools: {} },
                  serverInfo: { name: "fake", version: "1" },
                },
              });
            } else if (message.method === "tools/list") {
              json(res, 200, {
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  tools: [1, 2, 3, 4].map((n) => ({
                    name: `tool${n}`,
                    inputSchema: { type: "object" },
                  })),
                },
              });
            } else {
              res.writeHead(202);
              res.end();
            }
          });
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
      }),
  ),
  (server) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

const url = (server: NodeHttp.Server, path: string) =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;

const layerFor = (timeoutMs: number) =>
  McpServerChecks.layerWithTimeout(timeoutMs).pipe(
    Layer.provideMerge(McpUpstream.layer.pipe(Layer.provide(FetchHttpClient.layer))),
    Layer.provideMerge(McpSignIn.layer),
    Layer.provideMerge(layerMemorySecretStore),
    Layer.provideMerge(ServerSettings.layerTest()),
  );

/** Settings whose writes are also published on `streamChanges`, as the real service does. */
const streamingSettings = Layer.unwrap(
  Effect.gen(function* () {
    const hub = yield* PubSub.unbounded<ServerSettingsType>();
    const base = yield* ServerSettings.ServerSettingsService.pipe(
      Effect.provide(ServerSettings.layerTest()),
    );
    return Layer.succeed(ServerSettings.ServerSettingsService)({
      ...base,
      updateSettings: (patch) =>
        base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(hub, next))),
      streamChanges: Stream.fromPubSub(hub),
    });
  }),
);

const feedLayer = (timeoutMs: number) =>
  McpServerChecks.layerWithTimeout(timeoutMs).pipe(
    Layer.provideMerge(McpUpstream.layer.pipe(Layer.provide(FetchHttpClient.layer))),
    Layer.provideMerge(McpSignIn.layer),
    Layer.provideMerge(layerMemorySecretStore),
    Layer.provideMerge(streamingSettings),
  );

const resultOf = (checks: ReadonlyArray<McpServerCheck>, name: string) =>
  checks.find((check) => check.scope === "global" && check.name === name);

it.live("reports connected with a tool count for an http server", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startFakeHttpServer;
      const settings = yield* ServerSettings.ServerSettingsService;
      const checks = yield* McpServerChecks.McpServerChecks;
      yield* settings.updateSettings({
        mcpServers: {
          docs: {
            transport: "http",
            url: url(server, "/key"),
            headers: [{ name: "X-Api-Key", value: "k-1", sensitive: true }],
          },
        },
      });
      yield* checks.check();
      const result = resultOf(yield* checks.current, "docs");
      assert.equal(result?.status, "connected");
      assert.equal(result?.toolCount, 4);
      assert.equal(result?.error, undefined);
    }),
  ).pipe(Effect.provide(layerFor(5_000))),
);

it.live("maps a 401 or WWW-Authenticate response to needs-auth", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startFakeHttpServer;
      const settings = yield* ServerSettings.ServerSettingsService;
      const checks = yield* McpServerChecks.McpServerChecks;
      yield* settings.updateSettings({
        mcpServers: { docs: { transport: "http", url: url(server, "/auth"), headers: [] } },
      });
      yield* checks.check();
      assert.equal(resultOf(yield* checks.current, "docs")?.status, "needs-auth");
    }),
  ).pipe(Effect.provide(layerFor(5_000))),
);

it.live("fails with a timeout message when the server never answers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startFakeHttpServer;
      const settings = yield* ServerSettings.ServerSettingsService;
      const checks = yield* McpServerChecks.McpServerChecks;
      yield* settings.updateSettings({
        mcpServers: { docs: { transport: "http", url: url(server, "/hang"), headers: [] } },
      });
      yield* checks.check();
      const result = resultOf(yield* checks.current, "docs");
      assert.equal(result?.status, "failed");
      assert.match(result?.error ?? "", /timed out/i);
    }),
  ).pipe(Effect.provide(layerFor(300))),
);

it.live("fails when a sensitive value has no stored secret", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startFakeHttpServer;
      const settings = yield* ServerSettings.ServerSettingsService;
      const checks = yield* McpServerChecks.McpServerChecks;
      yield* settings.updateSettings({
        mcpServers: {
          docs: {
            transport: "http",
            url: url(server, "/mcp"),
            headers: [{ name: "Authorization", value: "", sensitive: true, valueRedacted: true }],
          },
          local: {
            transport: "stdio",
            command: process.execPath,
            args: [fixture],
            env: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
          },
        },
      });
      yield* checks.check();
      const current = yield* checks.current;
      for (const name of ["docs", "local"]) {
        assert.equal(resultOf(current, name)?.status, "failed");
        assert.match(resultOf(current, name)?.error ?? "", /secret/i);
      }
    }),
  ).pipe(Effect.provide(layerFor(5_000))),
);

it.live("checks stdio servers with their env", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const checks = yield* McpServerChecks.McpServerChecks;
      yield* settings.updateSettings({
        mcpServers: {
          ok: {
            transport: "stdio",
            command: process.execPath,
            args: [fixture],
            env: [{ name: "FIXTURE_REQUIRED", value: "yes", sensitive: false }],
          },
          bad: {
            transport: "stdio",
            command: process.execPath,
            args: [fixture],
            env: [{ name: "FIXTURE_REQUIRED", value: "no", sensitive: false }],
          },
          missing: { transport: "stdio", command: "t3-no-such-command-xyz", args: [], env: [] },
        },
      });
      yield* checks.check();
      const current = yield* checks.current;
      assert.equal(resultOf(current, "ok")?.status, "connected");
      assert.equal(resultOf(current, "ok")?.toolCount, 3);
      assert.equal(resultOf(current, "bad")?.status, "failed");
      assert.equal(resultOf(current, "missing")?.status, "failed");
    }),
  ).pipe(Effect.provide(layerFor(10_000))),
);

it.live("publishes full sets, checking first, and checks only the targets", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startFakeHttpServer;
      const settings = yield* ServerSettings.ServerSettingsService;
      const checks = yield* McpServerChecks.McpServerChecks;
      yield* settings.updateSettings({
        mcpServers: {
          a: { transport: "http", url: url(server, "/mcp"), headers: [] },
          b: { transport: "http", url: url(server, "/mcp"), headers: [] },
        },
      });
      const seen: Array<ReadonlyArray<McpServerCheck>> = [];
      yield* checks.streamChanges.pipe(
        Stream.runForEach((set) => Effect.sync(() => void seen.push(set))),
        Effect.forkScoped,
      );
      yield* checks.check([{ scope: "global", name: "a" }]);
      yield* Effect.yieldNow;
      const statuses = seen.map((set) => set.map((c) => `${c.name}:${c.status}`).join(","));
      assert.deepEqual(statuses.slice(-2), ["a:checking", "a:connected"]);
      assert.equal(resultOf(yield* checks.current, "b"), undefined);
    }),
  ).pipe(Effect.provide(layerFor(5_000))),
);

it.live("ensureChecked checks everything the first time only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startFakeHttpServer;
      const settings = yield* ServerSettings.ServerSettingsService;
      const checks = yield* McpServerChecks.McpServerChecks;
      yield* settings.updateSettings({
        mcpServers: { docs: { transport: "http", url: url(server, "/mcp"), headers: [] } },
      });
      assert.deepEqual(yield* checks.current, []);
      yield* checks.ensureChecked;
      assert.equal(resultOf(yield* checks.current, "docs")?.status, "connected");
      const first = resultOf(yield* checks.current, "docs")?.checkedAt;
      yield* checks.ensureChecked;
      assert.equal(resultOf(yield* checks.current, "docs")?.checkedAt, first);
    }),
  ).pipe(Effect.provide(layerFor(5_000))),
);

it.live("drops the result of an entry that was removed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startFakeHttpServer;
      const settings = yield* ServerSettings.ServerSettingsService;
      const checks = yield* McpServerChecks.McpServerChecks;
      yield* settings.updateSettings({
        mcpServers: { docs: { transport: "http", url: url(server, "/mcp"), headers: [] } },
      });
      yield* checks.check();
      yield* settings.updateSettings({ mcpServers: { docs: null } });
      yield* checks.check();
      assert.deepEqual(yield* checks.current, []);
    }),
  ).pipe(Effect.provide(layerFor(5_000))),
);

it.live("re-checks an entry when it is created or edited, and never at start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startFakeHttpServer;
      const checks = yield* McpServerChecks.McpServerChecks;
      const settings = yield* ServerSettings.ServerSettingsService;
      const publish = (mcpServers: Record<string, McpServerConfig>) =>
        settings.updateSettings({ mcpServers });
      assert.deepEqual(yield* checks.current, []);
      yield* publish({ docs: { transport: "http", url: url(server, "/mcp"), headers: [] } });
      const connected = yield* checks.streamChanges.pipe(
        Stream.filter((set) => resultOf(set, "docs")?.status === "connected"),
        Stream.runHead,
      );
      assert.equal(connected._tag, "Some");
      yield* publish({ docs: { transport: "http", url: url(server, "/auth"), headers: [] } });
      const needsAuth = yield* checks.streamChanges.pipe(
        Stream.filter((set) => resultOf(set, "docs")?.status === "needs-auth"),
        Stream.runHead,
      );
      assert.equal(needsAuth._tag, "Some");
    }),
  ).pipe(Effect.provide(feedLayer(5_000))),
);

const projectId = ProjectId.make("project-a");
const projectResultOf = (checks: ReadonlyArray<McpServerCheck>, name: string) =>
  checks.find((check) => check.scope === projectId && check.name === name);

it.live("keeps a project override's check apart from the environment entry's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startFakeHttpServer;
      const settings = yield* ServerSettings.ServerSettingsService;
      const checks = yield* McpServerChecks.McpServerChecks;
      yield* settings.updateSettings({
        mcpServers: {
          docs: { transport: "http", url: url(server, "/mcp"), headers: [] },
          shared: { transport: "http", url: url(server, "/mcp"), headers: [] },
        },
        projectSettingsOverrides: {
          [projectId]: {
            mcpServers: {
              docs: { transport: "http", url: url(server, "/auth"), headers: [] },
              local: { transport: "http", url: url(server, "/mcp"), headers: [] },
              shared: { enabled: false },
            },
          },
        },
      });
      yield* checks.check();
      const current = yield* checks.current;
      assert.equal(resultOf(current, "docs")?.status, "connected");
      assert.equal(projectResultOf(current, "docs")?.status, "needs-auth");
      assert.equal(projectResultOf(current, "local")?.status, "connected");
      assert.equal(resultOf(current, "shared")?.status, "connected");
      // A marker has nothing to check.
      assert.isUndefined(projectResultOf(current, "shared"));
    }),
  ).pipe(Effect.provide(layerFor(5_000))),
);

it.live("checks just the requested project target, and drops it once the override goes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startFakeHttpServer;
      const settings = yield* ServerSettings.ServerSettingsService;
      const checks = yield* McpServerChecks.McpServerChecks;
      yield* settings.updateSettings({
        mcpServers: { docs: { transport: "http", url: url(server, "/mcp"), headers: [] } },
        projectSettingsOverrides: {
          [projectId]: {
            mcpServers: { local: { transport: "http", url: url(server, "/mcp"), headers: [] } },
          },
        },
      });
      yield* checks.check([{ scope: projectId, name: "local" }]);
      const current = yield* checks.current;
      assert.deepEqual(
        current.map((check) => [check.scope, check.name]),
        [[projectId, "local"]],
      );

      yield* settings.updateSettings({ projectSettingsOverrides: { [projectId]: null } });
      yield* checks.check([{ scope: projectId, name: "local" }]);
      assert.deepEqual(yield* checks.current, []);
    }),
  ).pipe(Effect.provide(layerFor(5_000))),
);

it.live("re-checks a project override when it is edited", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startFakeHttpServer;
      const checks = yield* McpServerChecks.McpServerChecks;
      const settings = yield* ServerSettings.ServerSettingsService;
      const publish = (path: string) =>
        settings.updateSettings({
          projectSettingsOverrides: {
            [projectId]: {
              mcpServers: { local: { transport: "http", url: url(server, path), headers: [] } },
            },
          },
        });
      yield* publish("/mcp");
      assert.equal(
        (yield* checks.streamChanges.pipe(
          Stream.filter((set) => projectResultOf(set, "local")?.status === "connected"),
          Stream.runHead,
        ))._tag,
        "Some",
      );
      yield* publish("/auth");
      assert.equal(
        (yield* checks.streamChanges.pipe(
          Stream.filter((set) => projectResultOf(set, "local")?.status === "needs-auth"),
          Stream.runHead,
        ))._tag,
        "Some",
      );
    }),
  ).pipe(Effect.provide(feedLayer(5_000))),
);
