/**
 * Talks to a user's HTTP MCP server from the host.
 *
 * Every consumer that reaches a user server (the loopback proxy today, server
 * checks and sign-in later) goes through here, so the entry's headers are
 * materialized in one place and always from the current settings. Providers
 * never see them.
 *
 * @module McpUpstream
 */
import type { ProjectId } from "@t3tools/contracts";
import { upstreamUrlFingerprint } from "@t3tools/provider-core/server/mcpSession";
import { resolveMcpServers } from "@t3tools/shared/mcpServers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse,
} from "effect/http";

import * as ServerSettings from "../serverSettings.ts";

/** An HTTP user server as currently configured, with real header values. */
export interface McpUpstreamEntry {
  readonly url: string;
  /** Compare with a session's `upstreamUrlFingerprint` to see whether the URL changed. */
  readonly urlFingerprint: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface McpUpstreamRequest {
  readonly method: string;
  /** Sent as is, then overridden by the entry's own headers. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export class McpUpstream extends Context.Service<
  McpUpstream,
  {
    /**
     * The enabled HTTP server `name` for a project, read from live settings on
     * every call. Undefined when it is gone, disabled, not HTTP, or one of its
     * secrets cannot be read.
     */
    readonly resolve: (
      name: string,
      projectId: ProjectId | null,
    ) => Effect.Effect<McpUpstreamEntry | undefined>;
    /**
     * Sends one request upstream (the response body lives as long as the caller's scope) with the entry's headers applied. Redirects
     * are not followed, so headers never travel to a host the user did not
     * configure; the response, whatever its status, is returned unchanged.
     */
    readonly send: (
      entry: McpUpstreamEntry,
      request: McpUpstreamRequest,
    ) => Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      HttpClientError.HttpClientError,
      Scope.Scope
    >;
  }
>()("t3/mcp/McpUpstream") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);

  const resolve: McpUpstream["Service"]["resolve"] = Effect.fn("McpUpstream.resolve")(
    function* (name, projectId) {
      const current = yield* settings.getSettings.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not read settings for a user MCP server.", {
            name,
            cause,
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (current === undefined) return undefined;
      const resolved = resolveMcpServers(current, projectId).find((server) => server.name === name);
      const config = resolved?.config;
      if (config?.transport !== "http") return undefined;
      // A redacted row that materialized to nothing has no secret in the store.
      if (
        config.headers.some(
          (row) => row.sensitive && row.valueRedacted === true && row.value === "",
        )
      ) {
        return undefined;
      }
      return {
        url: config.url,
        urlFingerprint: upstreamUrlFingerprint(config.url),
        headers: Object.fromEntries(config.headers.map((row) => [row.name, row.value])),
      } satisfies McpUpstreamEntry;
    },
  );

  const send: McpUpstream["Service"]["send"] = (entry, request) => {
    const base = HttpClientRequest.make(request.method as "POST")(entry.url).pipe(
      HttpClientRequest.setHeaders({ ...request.headers, ...entry.headers }),
    );
    return httpClient
      .execute(
        request.body === undefined ? base : HttpClientRequest.bodyUint8Array(base, request.body),
      )
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  };

  return McpUpstream.of({ resolve, send });
});

export const layer = Layer.effect(McpUpstream, make);
