import { render } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ reconnect: vi.fn(), allowed: true }));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      reconnectClaudeMcpServer: {
        ...actual.serverEnvironment.reconnectClaudeMcpServer,
        permissionAtom: () => Atom.make(state.allowed),
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.reconnect) as never,
}));

import { ClaudeMcpReconnectButton } from "./ClaudeMcpReconnectButton";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("thread-1");

it("is disabled with its reason when no thread session is attached", async () => {
  state.allowed = true;
  state.reconnect.mockReset();
  await using screen = await render(
    <RegistryProvider>
      <ClaudeMcpReconnectButton environmentId={environmentId} name="docs" />
    </RegistryProvider>,
  );
  const button = screen.container.querySelector("button")!;
  expect(button.disabled).toBe(true);
  expect(button.title).toBe("No active session");
  expect(state.reconnect).not.toHaveBeenCalled();
});

it("is enabled when a thread session is attached", async () => {
  state.allowed = true;
  await using screen = await render(
    <RegistryProvider>
      <ClaudeMcpReconnectButton environmentId={environmentId} threadId={threadId} name="docs" />
    </RegistryProvider>,
  );
  expect(screen.container.querySelector("button")!.disabled).toBe(false);
});

it("hides the control without the providers-manage grant", async () => {
  state.allowed = false;
  await using screen = await render(
    <RegistryProvider>
      <ClaudeMcpReconnectButton environmentId={environmentId} threadId={threadId} name="docs" />
    </RegistryProvider>,
  );
  expect(screen.container.querySelector("button")).toBeNull();
});
