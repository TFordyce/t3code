/**
 * An in-process MCP server and OAuth authorization server for sign-in tests,
 * plus an in-memory secret store. One origin serves both: `/mcp` needs a
 * bearer the authorization server issued, everything else is the OAuth side.
 */
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const layerMemorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = stored.get(name);
        if (existing) return existing;
        const value = new Uint8Array(bytes).fill(7);
        stored.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
});

export interface FakeMcpRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly method: string | undefined;
}

export interface FakeOAuthWorld {
  readonly origin: string;
  /** The protected MCP endpoint. */
  readonly mcpUrl: string;
  readonly registrations: Array<Record<string, unknown>>;
  readonly tokenRequests: Array<Record<string, string>>;
  readonly mcpRequests: Array<FakeMcpRequest>;
  /** Access tokens `/mcp` accepts; delete one to make the server reject it. */
  readonly validTokens: Set<string>;
  /** Seconds a freshly issued access token claims to live. */
  lifetimeSeconds: number;
  /** Makes the next refresh grants fail. */
  refreshFails: boolean;
  /** Whether metadata advertises RFC 9207 `iss` responses. */
  issuerParameterSupported: boolean;
}

const readBody = (req: NodeHttp.IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

const json = (res: NodeHttp.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export const startFakeOAuthWorld = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly server: NodeHttp.Server; readonly world: FakeOAuthWorld }>(
        (resolve) => {
          let issued = 0;
          const world: FakeOAuthWorld = {
            origin: "",
            mcpUrl: "",
            registrations: [],
            tokenRequests: [],
            mcpRequests: [],
            validTokens: new Set(),
            lifetimeSeconds: 3600,
            refreshFails: false,
            issuerParameterSupported: true,
          };
          const server = NodeHttp.createServer((req, res) => {
            void (async () => {
              const body = await readBody(req);
              const path = (req.url ?? "").split("?")[0] ?? "";
              if (path.startsWith("/.well-known/oauth-protected-resource")) {
                return json(res, 200, {
                  resource: world.mcpUrl,
                  authorization_servers: [world.origin],
                });
              }
              if (path.startsWith("/.well-known/oauth-authorization-server")) {
                return json(res, 200, {
                  issuer: world.origin,
                  authorization_endpoint: `${world.origin}/authorize`,
                  token_endpoint: `${world.origin}/token`,
                  registration_endpoint: `${world.origin}/register`,
                  response_types_supported: ["code"],
                  grant_types_supported: ["authorization_code", "refresh_token"],
                  code_challenge_methods_supported: ["S256"],
                  token_endpoint_auth_methods_supported: [
                    "none",
                    "client_secret_post",
                    "client_secret_basic",
                  ],
                  authorization_response_iss_parameter_supported: world.issuerParameterSupported,
                });
              }
              if (path === "/register") {
                const metadata = JSON.parse(body) as Record<string, unknown>;
                world.registrations.push(metadata);
                return json(res, 201, { ...metadata, client_id: "dcr-client" });
              }
              if (path === "/token") {
                const form = Object.fromEntries(new URLSearchParams(body));
                // Clients may authenticate with HTTP Basic instead of body fields.
                const basic = req.headers.authorization?.match(/^Basic (.+)$/)?.[1];
                if (basic !== undefined) {
                  const [id, secret] = Buffer.from(basic, "base64").toString("utf8").split(":");
                  form.client_id ??= decodeURIComponent(id ?? "");
                  form.client_secret ??= decodeURIComponent(secret ?? "");
                }
                world.tokenRequests.push(form);
                if (form.grant_type === "refresh_token" && world.refreshFails) {
                  return json(res, 400, { error: "invalid_grant" });
                }
                if (form.grant_type === "authorization_code" && form.code !== "good-code") {
                  return json(res, 400, { error: "invalid_grant" });
                }
                issued += 1;
                const accessToken = `access-${issued}`;
                world.validTokens.add(accessToken);
                return json(res, 200, {
                  access_token: accessToken,
                  refresh_token: `refresh-${issued}`,
                  token_type: "Bearer",
                  expires_in: world.lifetimeSeconds,
                });
              }
              if (path === "/mcp") {
                world.mcpRequests.push({
                  url: path,
                  authorization: req.headers.authorization,
                  method: req.method,
                });
                const bearer = req.headers.authorization?.replace(/^Bearer /, "");
                if (bearer === undefined || !world.validTokens.has(bearer)) {
                  res.writeHead(401, { "www-authenticate": 'Bearer realm="fake"' });
                  return res.end();
                }
                const message = JSON.parse(body || "{}") as { id?: number; method?: string };
                if (message.method === "initialize") {
                  return json(res, 200, {
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                      protocolVersion: "2025-06-18",
                      capabilities: { tools: {} },
                      serverInfo: { name: "fake", version: "1" },
                    },
                  });
                }
                if (message.method === "tools/list") {
                  return json(res, 200, {
                    jsonrpc: "2.0",
                    id: message.id,
                    result: { tools: [{ name: "one", inputSchema: { type: "object" } }] },
                  });
                }
                res.writeHead(202);
                return res.end();
              }
              res.writeHead(404);
              res.end();
            })();
          });
          server.listen(0, "127.0.0.1", () => {
            const origin = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
            (world as { origin: string }).origin = origin;
            (world as { mcpUrl: string }).mcpUrl = `${origin}/mcp`;
            resolve({ server, world });
          });
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
).pipe(Effect.map(({ world }) => world));

/**
 * What the user's browser does after authorizing: follow the authorization URL's
 * `redirect_uri` with a code. `overrides` replaces or (with `undefined`) drops parameters.
 */
export const authorizationRedirect = (
  authorizationUrl: string,
  overrides: Record<string, string | undefined> = {},
) => {
  const authorize = new URL(authorizationUrl);
  const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
  const params: Record<string, string | undefined> = {
    code: "good-code",
    state: authorize.searchParams.get("state") ?? undefined,
    iss: authorize.origin,
    ...overrides,
  };
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) redirect.searchParams.set(name, value);
  }
  return redirect.toString();
};
