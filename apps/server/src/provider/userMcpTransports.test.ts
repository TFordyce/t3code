import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { withUserMcpTransports } from "./userMcpTransports.ts";

const provider = (id: string) => ({ instanceId: ProviderInstanceId.make(id) }) as ServerProvider;

const instance = (
  id: string,
  capabilities: Effect.Effect<{ tools: { userMcpTransports: ReadonlyArray<string> } }, string>,
) =>
  ({
    instanceId: ProviderInstanceId.make(id),
    orchestrationAdapter: { getCapabilities: () => capabilities },
  }) as unknown as ProviderInstance;

it.effect("labels each provider with the user MCP transports its adapter declares", () =>
  Effect.gen(function* () {
    const providers = yield* withUserMcpTransports(
      [provider("codex"), provider("grok"), provider("broken"), provider("unregistered")],
      [
        instance("codex", Effect.succeed({ tools: { userMcpTransports: ["stdio"] } })),
        instance("grok", Effect.succeed({ tools: { userMcpTransports: [] } })),
        instance("broken", Effect.fail("no capabilities")),
      ],
    );

    assert.deepStrictEqual(
      Object.fromEntries(providers.map((entry) => [entry.instanceId, entry.userMcpTransports])),
      {
        codex: ["stdio"],
        grok: [],
        // Unknown support is left unknown rather than reported as none.
        broken: undefined,
        unregistered: undefined,
      },
    );
  }),
);
