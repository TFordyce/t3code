import { render } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ toggle: vi.fn(), allowed: true }));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      setClaudeMcpServerEnabled: {
        ...actual.serverEnvironment.setClaudeMcpServerEnabled,
        permissionAtom: () => Atom.make(state.allowed),
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.toggle) as never,
}));

import { ClaudeMcpToggleButton } from "./ClaudeMcpToggleButton";

const environmentId = EnvironmentId.make("env");

it("offers Enable for a disabled server and Disable for a running one", async () => {
  state.allowed = true;
  await using disabled = await render(
    <RegistryProvider>
      <ClaudeMcpToggleButton environmentId={environmentId} name="docs" status="disabled" />
    </RegistryProvider>,
  );
  expect(disabled.container.querySelector("button")!.textContent).toBe("Enable");
  await using running = await render(
    <RegistryProvider>
      <ClaudeMcpToggleButton environmentId={environmentId} name="docs" status="connected" />
    </RegistryProvider>,
  );
  expect(running.container.querySelector("button")!.textContent).toBe("Disable");
});

it("hides the control without the providers-manage grant", async () => {
  state.allowed = false;
  await using screen = await render(
    <RegistryProvider>
      <ClaudeMcpToggleButton environmentId={environmentId} name="docs" status="disabled" />
    </RegistryProvider>,
  );
  expect(screen.container.querySelector("button")).toBeNull();
});
