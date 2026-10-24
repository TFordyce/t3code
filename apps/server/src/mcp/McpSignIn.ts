// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalErrorInEffectCatch:off globalTimersInEffect:off preferSchemaOverJson:off - Loopback OAuth callback server; wraps the MCP SDK's promise API, token expiry is wall-clock, and the JSON is only an equality key.
/**
 * OAuth sign-in for user HTTP MCP servers, held on the environment host.
 *
 * The MCP SDK's `auth()` runs the protocol; this module supplies an
 * `OAuthClientProvider` that keeps everything in memory during a flow and in
 * one `ServerSecretStore` secret per entry afterwards. On top of the SDK it
 * adds `state` and RFC 9207 `iss` validation, a loopback redirect listener on
 * the host, at most one pending flow per entry, refresh before expiry and
 * after an upstream 401, and the `auth` state shown next to server checks.
 *
 * Providers never see a token: {@link McpUpstream} asks {@link McpSignIn} for
 * the bearer on every request, so signing out takes effect at once.
 *
 * @module McpSignIn
 */
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  McpServerSignInError,
  type McpServerAuthState,
  type McpServerCheckTarget,
  type McpServerConfig,
  type McpServerSignInStarted,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { mcpSignInSecretKey } from "../settingsSecrets.ts";

/** A pending flow is dropped after this long without a redirect. */
const PENDING_FLOW_TTL_MS = 10 * 60_000;
/** Tokens this close to expiry are refreshed before a request uses them. */
const REFRESH_SKEW_MS = 60_000;

/** What is held per signed-in entry. */
interface SignInBundle {
  /** The URL the sign-in was granted for. A different URL counts as signed out. */
  readonly resourceUrl: string;
  readonly issuer: string;
  readonly clientInformation: OAuthClientInformationMixed;
  readonly tokens: OAuthTokens;
  /** Epoch ms; absent when the authorization server gave no lifetime. */
  readonly expiresAt?: number;
}

/** An HTTP entry as sign-in sees it: where it is, and the URL its bundle must match. */
export interface McpSignInTarget extends McpServerCheckTarget {
  readonly url: string;
}

type HttpConfig = Extract<McpServerConfig, { transport: "http" }>;

const keyOf = (target: McpServerCheckTarget) => `${target.scope}:${target.name}`;

const storeKeyOf = (target: McpServerCheckTarget) =>
  mcpSignInSecretKey(target.scope === "global" ? "global" : `project:${target.scope}`, target.name);

/** The enabled-or-not HTTP entry for a target: global, or a project's full override. */
const httpEntryOf = (
  settings: Pick<ServerSettingsValue, "mcpServers" | "projectSettingsOverrides">,
  target: McpServerCheckTarget,
): HttpConfig | undefined => {
  const entry =
    target.scope === "global"
      ? settings.mcpServers[target.name]
      : (
          settings.projectSettingsOverrides as Record<
            string,
            { readonly mcpServers?: Record<string, unknown> } | undefined
          >
        )[target.scope]?.mcpServers?.[target.name];
  const config = entry as McpServerConfig | { readonly enabled: false } | undefined;
  return config !== undefined && "transport" in config && config.transport === "http"
    ? config
    : undefined;
};

export const hasAuthorizationHeader = (config: HttpConfig) =>
  config.headers.some((row) => row.name.toLowerCase() === "authorization");

const signInError = (message: string) => new McpServerSignInError({ message });

const toError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const decodeBundle = (bytes: Uint8Array): SignInBundle | undefined => {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SignInBundle>;
    return typeof value.resourceUrl === "string" &&
      typeof value.issuer === "string" &&
      value.clientInformation !== undefined &&
      typeof value.tokens?.access_token === "string"
      ? (value as SignInBundle)
      : undefined;
  } catch {
    return undefined;
  }
};

/** Everything the SDK keeps between its calls during one flow or refresh. */
interface Session {
  readonly redirectUrl: string;
  readonly state: string;
  clientInformation: OAuthClientInformationMixed | undefined;
  tokens: OAuthTokens | undefined;
  codeVerifier: string;
  discovery: OAuthDiscoveryState | undefined;
  authorizationUrl: URL | undefined;
}

const providerFor = (session: Session): OAuthClientProvider => ({
  get redirectUrl() {
    return session.redirectUrl;
  },
  get clientMetadata() {
    return {
      client_name: "T3 Code",
      redirect_uris: [session.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      // Registered as a native app so a loopback redirect is acceptable.
      application_type: "native",
    } as OAuthClientMetadata;
  },
  state: () => session.state,
  clientInformation: () => session.clientInformation,
  saveClientInformation: (information) => {
    session.clientInformation = information;
  },
  tokens: () => session.tokens,
  saveTokens: (tokens) => {
    session.tokens = tokens;
  },
  redirectToAuthorization: (url) => {
    session.authorizationUrl = url;
  },
  saveCodeVerifier: (verifier) => {
    session.codeVerifier = verifier;
  },
  codeVerifier: () => session.codeVerifier,
  saveDiscoveryState: (discovery) => {
    session.discovery = discovery;
  },
  discoveryState: () => session.discovery,
});

const newSession = (redirectUrl: string): Session => ({
  redirectUrl,
  state: NodeCrypto.randomBytes(24).toString("base64url"),
  clientInformation: undefined,
  tokens: undefined,
  codeVerifier: "",
  discovery: undefined,
  authorizationUrl: undefined,
});

const issuerOf = (discovery: OAuthDiscoveryState | undefined) =>
  discovery?.authorizationServerMetadata?.issuer ??
  (discovery?.authorizationServerUrl === undefined
    ? undefined
    : String(discovery.authorizationServerUrl));

const expiresAtOf = (tokens: OAuthTokens) =>
  tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;

/** One in-progress flow, for one entry. */
interface PendingFlow {
  readonly session: Session;
  readonly url: string;
  /** The entry's JSON when the flow started; any edit aborts the flow. */
  readonly entryJson: string;
  readonly close: Effect.Effect<void>;
  used: boolean;
}

export class McpSignIn extends Context.Service<
  McpSignIn,
  {
    /**
     * Sign-in state of the entry, from its stored bundle: `signed-in`,
     * `expired` (a refresh failed or the lapsed token cannot be refreshed), or
     * `signed-out` when the bundle was granted for another URL. Undefined when
     * the entry has no bundle.
     */
    readonly authState: (
      target: McpServerCheckTarget,
    ) => Effect.Effect<McpServerAuthState | undefined>;
    /**
     * The access token to send upstream, refreshed first when near expiry.
     * Read from the store on every call. Undefined when signed out.
     */
    readonly bearer: (target: McpSignInTarget) => Effect.Effect<string | undefined>;
    /**
     * Called after an upstream 401 for `rejected`. Refreshes once and returns
     * the new token, or marks the entry `expired` and returns undefined. Where
     * another caller already refreshed, returns that token.
     */
    readonly refreshAfterUnauthorized: (
      target: McpSignInTarget,
      rejected: string,
    ) => Effect.Effect<string | undefined>;
    readonly start: (
      target: McpServerCheckTarget,
    ) => Effect.Effect<McpServerSignInStarted, McpServerSignInError>;
    /** Finishes the pending flow from the final redirect URL (pasted or relayed). */
    readonly complete: (
      target: McpServerCheckTarget,
      callbackUrl: string,
    ) => Effect.Effect<void, McpServerSignInError>;
    /** Deletes the bundle and aborts a pending flow. No revocation. */
    readonly signOut: (target: McpServerCheckTarget) => Effect.Effect<void>;
    /** Whether the entry has a flow waiting for its redirect. */
    readonly isPending: (target: McpServerCheckTarget) => Effect.Effect<boolean>;
    /** Entries whose sign-in state changed: sign-in, sign-out, or a failed refresh. */
    readonly changes: Stream.Stream<McpServerCheckTarget>;
  }
>()("t3/mcp/McpSignIn") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const changes = yield* PubSub.unbounded<McpServerCheckTarget>();
  const refreshLock = yield* Semaphore.make(1);
  const pending = new Map<string, PendingFlow>();
  /** Entries whose refresh failed; cleared by a new sign-in, a refresh or sign-out. */
  const expired = new Set<string>();

  const publish = (target: McpServerCheckTarget) =>
    PubSub.publish(changes, { scope: target.scope, name: target.name }).pipe(Effect.asVoid);

  const readBundle = (target: McpServerCheckTarget) =>
    store.get(storeKeyOf(target)).pipe(
      Effect.map((bytes) => (bytes._tag === "Some" ? decodeBundle(bytes.value) : undefined)),
      Effect.catch((cause) =>
        Effect.logWarning("Could not read an MCP sign-in.", { ...target, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );

  const writeBundle = (target: McpServerCheckTarget, bundle: SignInBundle) =>
    store.set(storeKeyOf(target), new TextEncoder().encode(JSON.stringify(bundle)));

  const currentSettings = settings.getSettings.pipe(Effect.catch(() => Effect.succeed(undefined)));

  const abortPending = (target: McpServerCheckTarget) =>
    Effect.suspend(() => {
      const flow = pending.get(keyOf(target));
      if (flow === undefined) return Effect.void;
      pending.delete(keyOf(target));
      return flow.close;
    });

  const markExpired = (target: McpServerCheckTarget) =>
    Effect.suspend(() => {
      if (expired.has(keyOf(target))) return Effect.void;
      expired.add(keyOf(target));
      return publish(target);
    });

  // An edit to an entry aborts its pending flow. (A sign-in already granted is
  // cleared by the settings write itself; see `planSettingsSecretPersist`.)
  yield* settings.streamChanges.pipe(
    Stream.runForEach((next) =>
      Effect.forEach(
        [...pending.entries()],
        ([key, flow]) => {
          const separator = key.indexOf(":");
          const target = { scope: key.slice(0, separator), name: key.slice(separator + 1) };
          return JSON.stringify(httpEntryOf(next, target)) === flow.entryJson
            ? Effect.void
            : abortPending(target);
        },
        { discard: true },
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  const authState: McpSignIn["Service"]["authState"] = Effect.fn("McpSignIn.authState")(
    function* (target) {
      const bundle = yield* readBundle(target);
      if (bundle === undefined) return undefined;
      const current = yield* currentSettings;
      const config = current === undefined ? undefined : httpEntryOf(current, target);
      if (config === undefined || config.url !== bundle.resourceUrl) return "signed-out";
      if (expired.has(keyOf(target))) return "expired";
      const lapsed = bundle.expiresAt !== undefined && bundle.expiresAt <= Date.now();
      return lapsed && bundle.tokens.refresh_token === undefined ? "expired" : "signed-in";
    },
  );

  /** Refreshes with the SDK, which rediscovers the authorization server from the stored issuer. */
  const refresh = Effect.fn("McpSignIn.refresh")(function* (
    target: McpSignInTarget,
    bundle: SignInBundle,
  ) {
    const session = newSession("http://127.0.0.1/");
    session.clientInformation = bundle.clientInformation;
    session.tokens = bundle.tokens;
    const outcome = yield* Effect.tryPromise({
      try: () => auth(providerFor(session), { serverUrl: target.url }),
      catch: toError,
    }).pipe(Effect.result);
    const refreshed = session.tokens;
    if (
      outcome._tag === "Failure" ||
      outcome.success !== "AUTHORIZED" ||
      refreshed === undefined ||
      refreshed.access_token === bundle.tokens.access_token
    ) {
      yield* markExpired(target);
      return undefined;
    }
    const expiresAt = expiresAtOf(refreshed);
    const next: SignInBundle = {
      resourceUrl: bundle.resourceUrl,
      issuer: bundle.issuer,
      clientInformation: bundle.clientInformation,
      tokens: refreshed,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
    const saved = yield* writeBundle(target, next).pipe(Effect.result);
    if (saved._tag === "Failure") {
      yield* Effect.logWarning("Could not save a refreshed MCP sign-in.", {
        cause: saved.failure,
      });
    }
    if (expired.delete(keyOf(target))) yield* publish(target);
    return refreshed.access_token;
  });

  const usableBundle = (target: McpSignInTarget) =>
    readBundle(target).pipe(
      Effect.map((bundle) => (bundle?.resourceUrl === target.url ? bundle : undefined)),
    );

  const bearer: McpSignIn["Service"]["bearer"] = Effect.fn("McpSignIn.bearer")(function* (target) {
    const bundle = yield* usableBundle(target);
    if (bundle === undefined) return undefined;
    const stale = expired.has(keyOf(target));
    const nearExpiry =
      bundle.expiresAt !== undefined && bundle.expiresAt - Date.now() < REFRESH_SKEW_MS;
    if (!stale && !nearExpiry) return bundle.tokens.access_token;
    return yield* refreshAfterUnauthorizedOrExpiry(target, bundle.tokens.access_token);
  });

  const refreshAfterUnauthorizedOrExpiry = (target: McpSignInTarget, rejected: string) =>
    refreshLock.withPermits(1)(
      Effect.gen(function* () {
        const bundle = yield* usableBundle(target);
        if (bundle === undefined) return undefined;
        // Someone refreshed while this call waited.
        if (bundle.tokens.access_token !== rejected && !expired.has(keyOf(target))) {
          return bundle.tokens.access_token;
        }
        if (bundle.tokens.refresh_token === undefined) {
          yield* markExpired(target);
          return undefined;
        }
        return yield* refresh(target, bundle);
      }),
    );

  const refreshAfterUnauthorized: McpSignIn["Service"]["refreshAfterUnauthorized"] = Effect.fn(
    "McpSignIn.refreshAfterUnauthorized",
  )(function* (target, rejected) {
    return yield* refreshAfterUnauthorizedOrExpiry(target, rejected);
  });

  const completeFlow = Effect.fn("McpSignIn.completeFlow")(function* (
    target: McpServerCheckTarget,
    callbackUrl: string,
  ) {
    const flow = pending.get(keyOf(target));
    if (flow === undefined || flow.used) {
      return yield* signInError("There is no sign-in in progress for this server.");
    }
    // An edit or removal since the flow started owns the entry now.
    const current = yield* currentSettings;
    if (current === undefined || JSON.stringify(httpEntryOf(current, target)) !== flow.entryJson) {
      yield* abortPending(target);
      return yield* signInError("The server was changed during sign-in. Start again.");
    }
    let callback: URL;
    try {
      callback = new URL(callbackUrl.trim());
    } catch {
      return yield* signInError(
        "That is not a valid URL. Paste the full address from the browser.",
      );
    }
    const params = callback.searchParams;
    const failure = params.get("error");
    if (failure !== null) {
      yield* abortPending(target);
      return yield* signInError(
        `The authorization server refused the sign-in: ${params.get("error_description") ?? failure}.`,
      );
    }
    if (params.get("state") !== flow.session.state) {
      return yield* signInError(
        "The sign-in response does not belong to this sign-in (state mismatch).",
      );
    }
    const issuer = issuerOf(flow.session.discovery);
    const issuerSent = params.get("iss");
    const issuerRequired =
      (
        flow.session.discovery?.authorizationServerMetadata as
          | { readonly authorization_response_iss_parameter_supported?: boolean }
          | undefined
      )?.authorization_response_iss_parameter_supported === true;
    if ((issuerSent !== null && issuerSent !== issuer) || (issuerSent === null && issuerRequired)) {
      return yield* signInError(
        "The sign-in response came from a different issuer (iss mismatch).",
      );
    }
    const code = params.get("code");
    if (code === null || code === "") {
      return yield* signInError("The sign-in response has no authorization code.");
    }
    flow.used = true;
    const exchanged = yield* Effect.tryPromise({
      try: () => auth(providerFor(flow.session), { serverUrl: flow.url, authorizationCode: code }),
      catch: toError,
    }).pipe(Effect.result);
    const tokens = flow.session.tokens;
    const information = flow.session.clientInformation;
    if (
      exchanged._tag === "Failure" ||
      exchanged.success !== "AUTHORIZED" ||
      tokens === undefined ||
      information === undefined ||
      issuer === undefined
    ) {
      flow.used = false;
      return yield* signInError(
        exchanged._tag === "Failure"
          ? `Could not finish the sign-in: ${errorText(exchanged.failure)}`
          : "Could not finish the sign-in.",
      );
    }
    // The entry may have been edited or removed while the browser was open.
    if (pending.get(keyOf(target)) !== flow) {
      return yield* signInError("The server was changed during sign-in. Start again.");
    }
    const expiresAt = expiresAtOf(tokens);
    yield* writeBundle(target, {
      resourceUrl: flow.url,
      issuer,
      clientInformation: information,
      tokens,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }).pipe(
      Effect.mapError((cause) => signInError(`Could not save the sign-in: ${errorText(cause)}`)),
    );
    expired.delete(keyOf(target));
    yield* abortPending(target);
    yield* publish(target);
  });

  /** Listens on a free loopback port for the browser's redirect and finishes the flow. */
  const listenForRedirect = (target: McpServerCheckTarget) =>
    Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeHttp.Server>((resolve, reject) => {
            const server = NodeHttp.createServer((request, response) => {
              const url = new URL(request.url ?? "/", "http://127.0.0.1");
              if (url.pathname !== "/callback") {
                response.writeHead(404).end();
                return;
              }
              const address = server.address() as NodeNet.AddressInfo;
              void Effect.runPromise(
                completeFlow(target, `http://127.0.0.1:${address.port}${request.url}`).pipe(
                  Effect.result,
                ),
              ).then((result) => {
                const ok = result._tag === "Success";
                response.writeHead(ok ? 200 : 400, {
                  "content-type": "text/html; charset=utf-8",
                  connection: "close",
                });
                response.end(
                  `<!doctype html><meta charset="utf-8"><title>T3 Code</title><body style="font-family:system-ui;padding:2rem"><p>${
                    ok
                      ? "Signed in. You can close this tab and return to T3 Code."
                      : "Sign-in failed. Return to T3 Code and try again."
                  }</p></body>`,
                );
              });
            });
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      // Not awaited: the request that finished the flow is still answering through this server.
      (server) =>
        Effect.sync(() => {
          server.close();
          server.closeIdleConnections();
        }),
    );

  const start: McpSignIn["Service"]["start"] = Effect.fn("McpSignIn.start")(function* (target) {
    const current = yield* currentSettings;
    const config = current === undefined ? undefined : httpEntryOf(current, target);
    if (config === undefined) return yield* signInError("That is not an HTTP MCP server.");
    if (hasAuthorizationHeader(config)) {
      return yield* signInError("Remove the Authorization header to sign in.");
    }
    yield* abortPending(target);

    // The flow outlives this call, so it owns a scope: the listener and the
    // timeout both live in it, and closing it ends the flow.
    const flowScope = yield* Scope.make();
    const close = Scope.close(flowScope, Exit.void);
    const outcome = yield* Effect.gen(function* () {
      const server = yield* listenForRedirect(target).pipe(Scope.provide(flowScope));
      const redirectUrl = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/callback`;
      const session = newSession(redirectUrl);
      const oauth = config.oauth;
      if (oauth !== undefined) {
        const secret = oauth.clientSecret?.value ?? "";
        session.clientInformation = {
          client_id: oauth.clientId,
          ...(secret === "" ? {} : { client_secret: secret }),
        };
      }
      const result = yield* Effect.tryPromise({
        try: () => auth(providerFor(session), { serverUrl: config.url }),
        catch: (cause) => signInError(`Could not start the sign-in: ${errorText(cause)}`),
      });
      if (result !== "REDIRECT" || session.authorizationUrl === undefined) {
        return yield* signInError("This server did not ask for a sign-in.");
      }
      return { session, authorizationUrl: session.authorizationUrl.toString() };
    }).pipe(
      Effect.tapError(() => close),
      Effect.result,
    );
    if (outcome._tag === "Failure") return yield* outcome.failure;

    const timer = setTimeout(() => void Effect.runFork(abortPending(target)), PENDING_FLOW_TTL_MS);
    timer.unref();
    yield* Scope.addFinalizer(
      flowScope,
      Effect.sync(() => clearTimeout(timer)),
    );
    // A concurrent start for the same entry is replaced by this one.
    yield* abortPending(target);
    pending.set(keyOf(target), {
      session: outcome.success.session,
      url: config.url,
      entryJson: JSON.stringify(config),
      close,
      used: false,
    });
    return { authorizationUrl: outcome.success.authorizationUrl };
  });

  return McpSignIn.of({
    authState,
    bearer,
    refreshAfterUnauthorized,
    start,
    complete: (target, callbackUrl) => completeFlow(target, callbackUrl),
    signOut: Effect.fn("McpSignIn.signOut")(function* (target) {
      yield* abortPending(target);
      expired.delete(keyOf(target));
      yield* store
        .remove(storeKeyOf(target))
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not delete an MCP sign-in.", { ...target, cause }),
          ),
        );
      yield* publish(target);
    }),
    isPending: (target) => Effect.sync(() => pending.has(keyOf(target))),
    changes: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(McpSignIn, make);
