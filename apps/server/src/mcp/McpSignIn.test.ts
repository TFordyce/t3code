// @effect-diagnostics globalDateInEffect:off globalFetchInEffect:off - Test clock arithmetic and a plain fetch against the loopback fixture.
import { assert, it } from "@effect/vitest";
import type { McpServerConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { mcpSignInSecretKey } from "../settingsSecrets.ts";
import * as McpSignIn from "./McpSignIn.ts";
import {
  authorizationRedirect,
  layerMemorySecretStore,
  startFakeOAuthWorld,
  type FakeOAuthWorld,
} from "./McpSignIn.testkit.ts";

const layer = McpSignIn.layer.pipe(
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(layerMemorySecretStore),
);

const target = { scope: "global", name: "docs" } as const;

const httpEntry = (world: FakeOAuthWorld, extra: Record<string, unknown> = {}) =>
  ({ transport: "http", url: world.mcpUrl, headers: [], ...extra }) as McpServerConfig;

const withWorld = <A, E>(
  use: (context: {
    readonly world: FakeOAuthWorld;
    readonly signIn: McpSignIn.McpSignIn["Service"];
    readonly settings: ServerSettings.ServerSettingsService["Service"];
    readonly store: ServerSecretStore.ServerSecretStore["Service"];
  }) => Effect.Effect<A, E, never>,
  entry: (world: FakeOAuthWorld) => McpServerConfig = (world) => httpEntry(world),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* startFakeOAuthWorld;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ mcpServers: { docs: entry(world) } });
      return yield* use({
        world,
        signIn: yield* McpSignIn.McpSignIn,
        settings,
        store: yield* ServerSecretStore.ServerSecretStore,
      });
    }),
  ).pipe(Effect.provide(layer));

const visit = (url: string) => Effect.promise(() => fetch(url).then((response) => response.status));

it.effect("signs in through the host loopback listener and stores the bundle", () =>
  withWorld(({ world, signIn, store }) =>
    Effect.gen(function* () {
      const { authorizationUrl } = yield* signIn.start(target);
      const authorize = new URL(authorizationUrl);
      assert.equal(authorize.origin + authorize.pathname, `${world.origin}/authorize`);
      assert.match(
        authorize.searchParams.get("redirect_uri")!,
        /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
      );
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      assert.equal(world.registrations[0]?.application_type, "native");
      assert.equal(yield* signIn.authState(target), undefined);

      assert.equal(yield* visit(authorizationRedirect(authorizationUrl)), 200);

      assert.equal(yield* signIn.authState(target), "signed-in");
      const stored = Option.getOrThrow(yield* store.get(mcpSignInSecretKey("global", "docs")));
      const bundle = JSON.parse(new TextDecoder().decode(stored));
      assert.deepInclude(bundle, { resourceUrl: world.mcpUrl, issuer: world.origin });
      assert.equal(bundle.clientInformation.client_id, "dcr-client");
      assert.equal(bundle.tokens.access_token, "access-1");
      assert.isNumber(bundle.expiresAt);
      assert.isFalse(yield* signIn.isPending(target));
    }),
  ),
);

it.effect("completes from a pasted callback URL", () =>
  withWorld(({ signIn }) =>
    Effect.gen(function* () {
      const { authorizationUrl } = yield* signIn.start(target);
      yield* signIn.complete(target, authorizationRedirect(authorizationUrl));
      assert.equal(yield* signIn.authState(target), "signed-in");
    }),
  ),
);

it.effect("rejects state and issuer mismatches, then still accepts the real redirect", () =>
  withWorld(({ signIn }) =>
    Effect.gen(function* () {
      const { authorizationUrl } = yield* signIn.start(target);
      for (const overrides of [
        { state: "forged" },
        { iss: "https://evil.example.com" },
        { iss: undefined },
        { code: undefined },
      ]) {
        const failure = yield* signIn
          .complete(target, authorizationRedirect(authorizationUrl, overrides))
          .pipe(Effect.flip);
        assert.equal(failure._tag, "McpServerSignInError");
      }
      assert.equal(yield* signIn.authState(target), undefined);
      yield* signIn.complete(target, authorizationRedirect(authorizationUrl));
      assert.equal(yield* signIn.authState(target), "signed-in");
    }),
  ),
);

it.effect("uses the user-entered client before dynamic registration", () =>
  withWorld(
    ({ world, signIn }) =>
      Effect.gen(function* () {
        const { authorizationUrl } = yield* signIn.start(target);
        assert.equal(new URL(authorizationUrl).searchParams.get("client_id"), "my-client");
        yield* signIn.complete(target, authorizationRedirect(authorizationUrl));
        assert.deepEqual(world.registrations, []);
        assert.equal(world.tokenRequests[0]?.client_id, "my-client");
        assert.equal(world.tokenRequests[0]?.client_secret, "my-secret");
      }),
    (world) =>
      httpEntry(world, { oauth: { clientId: "my-client", clientSecret: { value: "my-secret" } } }),
  ),
);

it.effect("keeps one pending flow per entry; starting again replaces it", () =>
  withWorld(({ signIn }) =>
    Effect.gen(function* () {
      const first = yield* signIn.start(target);
      const second = yield* signIn.start(target);
      assert.notEqual(
        new URL(first.authorizationUrl).searchParams.get("state"),
        new URL(second.authorizationUrl).searchParams.get("state"),
      );
      const outcome = yield* Effect.promise(() =>
        fetch(authorizationRedirect(first.authorizationUrl)).then(
          () => "answered",
          () => "refused",
        ),
      );
      assert.equal(outcome, "refused");
      yield* signIn.complete(target, authorizationRedirect(second.authorizationUrl));
      assert.equal(yield* signIn.authState(target), "signed-in");
    }),
  ),
);

it.effect("aborts a pending flow when the entry is edited", () =>
  withWorld(({ world, signIn, settings }) =>
    Effect.gen(function* () {
      const { authorizationUrl } = yield* signIn.start(target);
      yield* settings.updateSettings({
        mcpServers: {
          docs: httpEntry(world, { headers: [{ name: "X-A", value: "1", sensitive: false }] }),
        },
      });
      const failure = yield* signIn
        .complete(target, authorizationRedirect(authorizationUrl))
        .pipe(Effect.flip);
      assert.include(failure.message, "changed");
      assert.isFalse(yield* signIn.isPending(target));
      assert.equal(yield* signIn.authState(target), undefined);
    }),
  ),
);

it.effect("is not offered while the entry has its own Authorization header", () =>
  withWorld(
    ({ signIn }) =>
      Effect.gen(function* () {
        const failure = yield* signIn.start(target).pipe(Effect.flip);
        assert.include(failure.message, "Authorization header");
      }),
    (world) =>
      httpEntry(world, {
        headers: [{ name: "authorization", value: "Bearer mine", sensitive: true }],
      }),
  ),
);

it.effect("counts a bundle granted for another URL as signed out", () =>
  withWorld(({ world, signIn, settings }) =>
    Effect.gen(function* () {
      const { authorizationUrl } = yield* signIn.start(target);
      yield* signIn.complete(target, authorizationRedirect(authorizationUrl));
      // Hand-edited: the real settings service would have cleared the sign-in.
      const elsewhere = `${world.origin}/elsewhere`;
      yield* settings.updateSettings({
        mcpServers: { docs: httpEntry(world, { url: elsewhere }) },
      });
      assert.equal(yield* signIn.authState(target), "signed-out");
      assert.isUndefined(yield* signIn.bearer({ ...target, url: elsewhere }));
    }),
  ),
);

it.effect("refreshes before expiry, marks the entry expired when a refresh fails", () =>
  withWorld(
    ({ world, signIn }) =>
      Effect.gen(function* () {
        const { authorizationUrl } = yield* signIn.start(target);
        yield* signIn.complete(target, authorizationRedirect(authorizationUrl));
        const url = world.mcpUrl;
        // The token is inside the refresh window, so asking for it refreshes.
        assert.equal(yield* signIn.bearer({ ...target, url }), "access-2");
        assert.equal(world.tokenRequests.at(-1)?.grant_type, "refresh_token");

        world.refreshFails = true;
        assert.isUndefined(yield* signIn.bearer({ ...target, url }));
        assert.equal(yield* signIn.authState(target), "expired");

        yield* signIn.signOut(target);
        assert.equal(yield* signIn.authState(target), undefined);
        assert.isUndefined(yield* signIn.bearer({ ...target, url }));
      }),
    (world) => {
      world.lifetimeSeconds = 30;
      return httpEntry(world);
    },
  ),
);
