import { NodeHttpServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSession from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { McpServerCheck } from "@t3tools/contracts";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import * as McpProxy from "./McpProxy.ts";
import * as McpServerChecks from "./McpServerChecks.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpSignIn from "./McpSignIn.ts";
import {
  authorizationRedirect,
  layerMemorySecretStore,
  startFakeOAuthWorld,
  type FakeOAuthWorld,
} from "./McpSignIn.testkit.ts";
import * as McpUpstream from "./McpUpstream.ts";

const environmentId = EnvironmentId.make("environment-signin-test");
const threadId = ThreadId.make("thread-signin-test");
const BEARER = "sessionTokenWithoutDots";
const target = { scope: "global", name: "docs" } as const;

const sessionScope = {
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
} as const;

const layer = Layer.mergeAll(McpServerChecks.layer, McpProviderSessions.layer).pipe(
  Layer.provideMerge(McpUpstream.layer.pipe(Layer.provide(FetchHttpClient.layer))),
  Layer.provideMerge(McpSignIn.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        resolve: (token) => Effect.succeed(token === BEARER ? (sessionScope as never) : undefined),
      }),
      ServerSettings.layerTest(),
      layerMemorySecretStore,
    ),
  ),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

const initialize = HttpBody.text(
  `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
  "application/json",
);

/** Waits for the check feed to show a row for `docs` matching `wanted`. */
const awaitCheck = (
  checks: McpServerChecks.McpServerChecks["Service"],
  wanted: (row: McpServerCheck) => boolean,
) =>
  checks.streamChanges.pipe(
    Stream.map((rows) => rows.find((candidate) => candidate.name === "docs")),
    Stream.filter((row): row is McpServerCheck => row !== undefined && wanted(row)),
    Stream.runHead,
    Effect.map((head) => (head._tag === "Some" ? head.value : undefined)),
  );

/** A signed-in `docs` server behind the real proxy route, in a running session. */
const withSignedInServer = <A, E>(
  use: (context: {
    readonly world: FakeOAuthWorld;
    readonly client: HttpClient.HttpClient;
    readonly signIn: McpSignIn.McpSignIn["Service"];
    readonly checks: McpServerChecks.McpServerChecks["Service"];
    readonly settings: ServerSettings.ServerSettingsService["Service"];
  }) => Effect.Effect<A, E, HttpClient.HttpClient>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* startFakeOAuthWorld;
      const settings = yield* ServerSettings.ServerSettingsService;
      const signIn = yield* McpSignIn.McpSignIn;
      yield* settings.updateSettings({
        mcpServers: { docs: { transport: "http", url: world.mcpUrl, headers: [] } },
      });
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
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
              upstreamUrlFingerprint: McpSession.upstreamUrlFingerprint(world.mcpUrl),
            },
          ],
          skipped: [],
        },
      });
      yield* HttpRouter.serve(McpProxy.layer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const started = yield* signIn.start(target);
      yield* signIn.complete(target, authorizationRedirect(started.authorizationUrl));
      // Signing in triggers a check of its own; let it settle so it adds no traffic later.
      const checks = yield* McpServerChecks.McpServerChecks;
      yield* awaitCheck(checks, (row) => row.status === "connected");
      world.mcpRequests.length = 0;
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(BEARER)),
      );
      return yield* use({
        world,
        client,
        signIn,
        checks,
        settings,
      });
    }),
  ).pipe(Effect.provide(layer));

const lastAuthorization = (world: FakeOAuthWorld) => world.mcpRequests.at(-1)?.authorization;

it.effect("the proxy sends the sign-in's bearer, and stops at once after sign-out", () =>
  withSignedInServer(({ world, client, signIn }) =>
    Effect.gen(function* () {
      assert.equal((yield* client.post("/mcp-proxy/docs", { body: initialize })).status, 200);
      assert.equal(lastAuthorization(world), "Bearer access-1");

      yield* signIn.signOut(target);

      assert.equal((yield* client.post("/mcp-proxy/docs", { body: initialize })).status, 401);
      assert.isUndefined(lastAuthorization(world));
    }),
  ),
);

it.effect("a user Authorization header wins over the sign-in", () =>
  withSignedInServer(({ world, client, settings }) =>
    Effect.gen(function* () {
      yield* settings.updateSettings({
        mcpServers: {
          docs: {
            transport: "http",
            url: world.mcpUrl,
            headers: [{ name: "Authorization", value: "Bearer mine", sensitive: false }],
          },
        },
      });
      yield* client.post("/mcp-proxy/docs", { body: initialize });
      assert.equal(lastAuthorization(world), "Bearer mine");
    }),
  ),
);

it.effect("a 401 refreshes once and retries", () =>
  withSignedInServer(({ world, client }) =>
    Effect.gen(function* () {
      // The server forgets the token before the client's clock says it expired.
      world.validTokens.delete("access-1");
      const before = world.mcpRequests.length;

      const response = yield* client.post("/mcp-proxy/docs", { body: initialize });

      assert.equal(response.status, 200);
      assert.deepEqual(
        world.mcpRequests.slice(before).map((request) => request.authorization),
        ["Bearer access-1", "Bearer access-2"],
      );
    }),
  ),
);

it.effect("a failed refresh marks the entry expired and passes the 401 on", () =>
  withSignedInServer(({ world, client, signIn, checks }) =>
    Effect.gen(function* () {
      world.validTokens.clear();
      world.refreshFails = true;

      assert.equal((yield* client.post("/mcp-proxy/docs", { body: initialize })).status, 401);

      assert.equal(yield* signIn.authState(target), "expired");
      const row = yield* awaitCheck(
        checks,
        (check) => check.auth === "expired" && check.status === "needs-auth",
      );
      assert.deepInclude(row, { status: "needs-auth", auth: "expired" });
    }),
  ),
);

it.effect("checks show the sign-in state and republish when it changes", () =>
  withSignedInServer(({ checks, signIn }) =>
    Effect.gen(function* () {
      const connected = (yield* checks.current).find((check) => check.name === "docs");
      assert.deepInclude(connected, { status: "connected", toolCount: 1, auth: "signed-in" });

      yield* signIn.signOut(target);
      const signedOut = yield* awaitCheck(checks, (check) => check.status === "needs-auth");
      assert.deepInclude(signedOut, { status: "needs-auth", auth: "signed-out" });
    }),
  ),
);
