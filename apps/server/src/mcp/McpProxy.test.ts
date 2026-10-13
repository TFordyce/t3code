// @effect-diagnostics nodeBuiltinImport:off - Node http fixture server for loopback tests.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSession from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProxy from "./McpProxy.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpSignIn from "./McpSignIn.ts";
import { layerMemorySecretStore } from "./McpSignIn.testkit.ts";
import * as McpUpstream from "./McpUpstream.ts";

const environmentId = EnvironmentId.make("environment-proxy-test");
const threadId = ThreadId.make("thread-proxy-test");
const BEARER = "sessionTokenWithoutDots";

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

/** An in-process stand-in for a user's MCP server. */
const startFakeMcpServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly server: NodeHttp.Server; readonly seen: Array<SeenRequest> }>(
        (resolve) => {
          const seen: Array<SeenRequest> = [];
          const server = NodeHttp.createServer((req, res) => {
            const chunks: Array<Buffer> = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
              seen.push({
                method: req.method ?? "",
                url: req.url ?? "",
                headers: req.headers,
                body: Buffer.concat(chunks).toString("utf8"),
              });
              if (req.url === "/sse") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                // The second event goes out once the first is flushed, so the
                // stream arrives in two chunks without a timer.
                res.write("data: one\n\n", () => {
                  res.write("data: two\n\n");
                  res.end();
                });
                return;
              }
              if (req.url === "/needs-auth") {
                res.writeHead(401, { "www-authenticate": 'Bearer realm="up"' });
                res.end("nope");
                return;
              }
              if (req.url === "/teapot") {
                res.writeHead(418, { "content-type": "text/plain" });
                res.end("short and stout");
                return;
              }
              res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "up-1" });
              res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
            });
          });
          server.listen(0, "127.0.0.1", () => resolve({ server, seen }));
        },
      ),
  ),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

const upstreamUrl = (server: NodeHttp.Server, path: string) =>
  `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}${path}`;

const sessionScope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId,
  requestNamespace: "provider-session",
  thread: {
    threadId,
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const header = (name: string, value: string, sensitive = false) => ({ name, value, sensitive });

/**
 * Serves the real proxy route over HTTP in front of a fake upstream. The
 * session was started with `docs` pointing at `/mcp`.
 */
const withProxy = <A, E, R>(
  use: (context: {
    readonly client: HttpClient.HttpClient;
    readonly seen: ReadonlyArray<SeenRequest>;
    readonly upstream: NodeHttp.Server;
    readonly settings: ServerSettings.ServerSettingsService["Service"];
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { server, seen } = yield* startFakeMcpServer;
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        mcpServers: {
          docs: {
            transport: "http",
            url: upstreamUrl(server, "/mcp"),
            headers: [header("X-Api-Key", "key-1"), header("Authorization", "Bearer up", true)],
          },
        },
      });
      yield* sessions.set({
        environmentId,
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:1/mcp",
        authorizationHeader: `Bearer ${BEARER}`,
        browserToolsAvailable: false,
        userMcp: {
          servers: [
            {
              name: "docs",
              transport: "http",
              url: "http://127.0.0.1:1/mcp-proxy/docs",
              upstreamUrlFingerprint: McpSession.upstreamUrlFingerprint(
                upstreamUrl(server, "/mcp"),
              ),
            },
          ],
          skipped: [],
        },
      });
      yield* HttpRouter.serve(McpProxy.layer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(BEARER)),
      );
      return yield* use({ client, seen, upstream: server, settings });
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        McpUpstream.layer.pipe(Layer.provide(FetchHttpClient.layer)),
        McpProviderSessions.layer,
      ).pipe(
        Layer.provideMerge(McpSignIn.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (token) => Effect.succeed(token === BEARER ? sessionScope : undefined),
            }),
            ServerSettings.layerTest(),
            layerMemorySecretStore,
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    ),
  );

const initialize = HttpBody.text(
  `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
  "application/json",
);

it.effect("rejects an unknown bearer and a missing one", () =>
  withProxy(({ client, seen }) =>
    Effect.gen(function* () {
      const plain = yield* HttpClient.HttpClient;
      const unknown = yield* plain.post("/mcp-proxy/docs", {
        headers: { authorization: "Bearer someoneElse" },
        body: initialize,
      });
      assert.equal(unknown.status, 401);
      const missing = yield* plain.post("/mcp-proxy/docs", { body: initialize });
      assert.equal(missing.status, 401);
      assert.equal(seen.length, 0);
      assert.equal((yield* client.post("/mcp-proxy/docs", { body: initialize })).status, 200);
    }),
  ),
);

it.effect("rejects a name outside the session's set", () =>
  withProxy(({ client, settings, seen }) =>
    Effect.gen(function* () {
      // Configured now, but the session was not started with it.
      yield* settings.updateSettings({
        mcpServers: { later: { transport: "http", url: "http://127.0.0.1:1/x", headers: [] } },
      });
      assert.equal((yield* client.post("/mcp-proxy/later", { body: initialize })).status, 403);
      assert.equal((yield* client.post("/mcp-proxy/nothing", { body: initialize })).status, 403);
      assert.equal(seen.length, 0);
    }),
  ),
);

it.effect("adds the current headers and drops the T3 bearer", () =>
  withProxy(({ client, settings, seen }) =>
    Effect.gen(function* () {
      const first = yield* client.post("/mcp-proxy/docs", {
        headers: { accept: "application/json, text/event-stream", "x-api-key": "from-agent" },
        body: initialize,
      });
      assert.equal(first.status, 200);
      assert.equal(first.headers["mcp-session-id"], "up-1");
      assert.equal(seen[0]?.headers["x-api-key"], "key-1");
      assert.equal(seen[0]?.headers.authorization, "Bearer up");
      assert.equal(seen[0]?.body, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');

      yield* settings.updateSettings({
        mcpServers: {
          docs: {
            transport: "http",
            url: seen[0] ? `http://127.0.0.1:${seen[0].headers.host?.split(":")[1]}/mcp` : "",
            headers: [header("X-Api-Key", "key-2")],
          },
        },
      });
      yield* client.post("/mcp-proxy/docs", { body: initialize });
      assert.equal(seen[1]?.headers["x-api-key"], "key-2");
      assert.isUndefined(seen[1]?.headers.authorization);
    }),
  ),
);

it.effect("passes upstream statuses through unchanged", () =>
  withProxy(({ client, settings, upstream }) =>
    Effect.gen(function* () {
      const point = (path: string) =>
        settings.updateSettings({
          mcpServers: {
            docs: { transport: "http", url: upstreamUrl(upstream, path), headers: [] },
          },
        });
      // The session started with `/mcp`; keep its fingerprint in step with each path.
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      for (const [path, status] of [
        ["/needs-auth", 401],
        ["/teapot", 418],
      ] as const) {
        yield* point(path);
        const slot = (yield* sessions.read(threadId))!;
        yield* sessions.set({
          ...slot,
          userMcp: {
            servers: [
              {
                name: "docs",
                transport: "http",
                url: "http://127.0.0.1:1/mcp-proxy/docs",
                upstreamUrlFingerprint: McpSession.upstreamUrlFingerprint(
                  upstreamUrl(upstream, path),
                ),
              },
            ],
            skipped: [],
          },
        });
        const response = yield* client.post("/mcp-proxy/docs", { body: initialize });
        assert.equal(response.status, status);
        if (status === 401) {
          assert.equal(response.headers["www-authenticate"], 'Bearer realm="up"');
        }
        assert.equal(yield* response.text, status === 401 ? "nope" : "short and stout");
      }
    }),
  ),
);

it.effect("streams SSE responses through", () =>
  withProxy(({ client, settings, upstream }) =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const url = upstreamUrl(upstream, "/sse");
      yield* settings.updateSettings({
        mcpServers: { docs: { transport: "http", url, headers: [] } },
      });
      const slot = (yield* sessions.read(threadId))!;
      yield* sessions.set({
        ...slot,
        userMcp: {
          servers: [
            {
              name: "docs",
              transport: "http",
              url: "http://127.0.0.1:1/mcp-proxy/docs",
              upstreamUrlFingerprint: McpSession.upstreamUrlFingerprint(url),
            },
          ],
          skipped: [],
        },
      });
      const response = yield* client.get("/mcp-proxy/docs", {
        headers: { accept: "text/event-stream" },
      });
      assert.equal(response.status, 200);
      assert.include(response.headers["content-type"] ?? "", "text/event-stream");
      assert.equal(yield* response.text, "data: one\n\ndata: two\n\n");
    }),
  ),
);

it.effect("refuses at once after the entry is removed, disabled or re-pointed", () =>
  withProxy(({ client, settings, seen, upstream }) =>
    Effect.gen(function* () {
      const docs = {
        transport: "http" as const,
        url: upstreamUrl(upstream, "/mcp"),
        headers: [],
      };
      assert.equal((yield* client.post("/mcp-proxy/docs", { body: initialize })).status, 200);
      const reached = seen.length;

      yield* settings.updateSettings({
        mcpServers: { docs: { ...docs, url: upstreamUrl(upstream, "/elsewhere") } },
      });
      assert.equal((yield* client.post("/mcp-proxy/docs", { body: initialize })).status, 403);

      yield* settings.updateSettings({ mcpServers: { docs: { ...docs, enabled: false } } });
      assert.equal((yield* client.post("/mcp-proxy/docs", { body: initialize })).status, 403);

      yield* settings.updateSettings({ mcpServers: { docs: docs } });
      assert.equal((yield* client.post("/mcp-proxy/docs", { body: initialize })).status, 200);

      yield* settings.updateSettings({ mcpServers: { docs: null } });
      assert.equal((yield* client.post("/mcp-proxy/docs", { body: initialize })).status, 403);
      // Only the two allowed calls reached the upstream.
      assert.equal(seen.length, reached + 1);
    }),
  ),
);

it.effect("reaches the project's own config of a server for sessions in that project", () =>
  withProxy(({ client, seen, upstream, settings }) =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const projectId = ProjectId.make("project-a");
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: {
            mcpServers: {
              docs: { transport: "http", url: upstreamUrl(upstream, "/teapot"), headers: [] },
            },
          },
        },
      });
      const grant = (grantedProjectId?: ProjectId) =>
        sessions.set({
          environmentId,
          threadId,
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          endpoint: "http://127.0.0.1:1/mcp",
          authorizationHeader: `Bearer ${BEARER}`,
          browserToolsAvailable: false,
          userMcp: {
            servers: [
              {
                name: "docs",
                transport: "http",
                url: "http://127.0.0.1:1/mcp-proxy/docs",
                upstreamUrlFingerprint: McpSession.upstreamUrlFingerprint(
                  upstreamUrl(upstream, grantedProjectId === undefined ? "/mcp" : "/teapot"),
                ),
                ...(grantedProjectId === undefined ? {} : { projectId: grantedProjectId }),
              },
            ],
            skipped: [],
          },
        });

      yield* grant(projectId);
      const inProject = yield* client.post("/mcp-proxy/docs", { body: initialize });
      assert.equal(inProject.status, 418);
      assert.equal(seen.at(-1)?.url, "/teapot");
      assert.isUndefined(seen.at(-1)?.headers["x-api-key"]);

      // A session with no project gets the environment entry.
      yield* grant();
      const elsewhere = yield* client.post("/mcp-proxy/docs", { body: initialize });
      assert.equal(elsewhere.status, 200);
      assert.equal(seen.at(-1)?.url, "/mcp");
    }),
  ),
);
