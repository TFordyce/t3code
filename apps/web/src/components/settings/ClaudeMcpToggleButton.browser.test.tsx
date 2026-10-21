import { act, render } from "../../../test/render";
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

it("re-enables a disabled server with no session involved", async () => {
  state.allowed = true;
  state.toggle.mockReset();
  await using screen = await render(
    <RegistryProvider>
      <ClaudeMcpToggleButton environmentId={environmentId} name="docs" status="disabled" />
    </RegistryProvider>,
  );
  const button = screen.container.querySelector("button")!;
  expect(button.textContent).toBe("Enable");
  await act(async () => button.click());
  expect(state.toggle).toHaveBeenCalledWith({
    environmentId,
    input: { name: "docs", enabled: true },
  });
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
