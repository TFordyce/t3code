import type { ServerProvider } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";

/**
 * Stamps each provider with the user MCP transports its adapter declares, so
 * clients can say which providers cannot carry a configured server. A provider
 * whose adapter cannot be asked keeps the field absent: unknown is not "none".
 */
export const withUserMcpTransports = (
  providers: ReadonlyArray<ServerProvider>,
  instances: ReadonlyArray<ProviderInstance>,
): Effect.Effect<ReadonlyArray<ServerProvider>> => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance]));
  return Effect.forEach(
    providers,
    (provider) => {
      const instance = byId.get(provider.instanceId);
      if (instance === undefined) return Effect.succeed(provider);
      return instance.orchestrationAdapter.getCapabilities().pipe(
        Effect.map((capabilities): ServerProvider => ({
          ...provider,
          userMcpTransports: [...capabilities.tools.userMcpTransports],
        })),
        Effect.orElseSucceed(() => provider),
      );
    },
    { concurrency: "unbounded" },
  );
};
