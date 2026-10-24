import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const probe = vi.hoisted(() => ({
  claudeMcpStatus: vi.fn((target: unknown) => target),
  claudeMcpServerDetail: vi.fn((target: unknown) => ({ detail: target })),
  detail: null as unknown,
  refresh: vi.fn(),
  fresh: vi.fn((_target: unknown) => Promise.resolve({ _tag: "Success" })),
  view: {
    data: null as unknown,
    error: null as string | null,
    isPending: false,
  },
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      claudeMcpStatus: probe.claudeMcpStatus as never,
      claudeMcpServerDetail: probe.claudeMcpServerDetail as never,
      reconnectClaudeMcpServer: {
        ...actual.serverEnvironment.reconnectClaudeMcpServer,
        permissionAtom: () => Atom.make(true),
      },
      setClaudeMcpServerEnabled: {
        ...actual.serverEnvironment.setClaudeMcpServerEnabled,
        permissionAtom: () => Atom.make(true),
      },
    },
  };
});
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) =>
    atom !== null && typeof atom === "object" && "detail" in atom
      ? { data: probe.detail, error: null, isPending: false, refresh: probe.refresh }
      : {
          ...probe.view,
          data: atom === null ? null : probe.view.data,
          refresh: probe.refresh,
        }) as never,
}));

vi.mock(import("../../state/use-atom-query-runner"), () => ({
  useAtomQueryRunner: (() => probe.fresh) as never,
}));

import { ClaudeMcpSection } from "./ClaudeMcpServers";

const environmentId = EnvironmentId.make("environment-1");

const provider = (driver: string, displayName: string): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    status: "ready",
    userMcpTransports: ["stdio", "http"],
  }) as unknown as ServerProvider;

const renderSection = () =>
  render(
    <ClaudeMcpSection
      environmentId={environmentId}
      cwd="/home/me"
      providers={[provider("claudeAgent", "Claude"), provider("codex", "Codex")]}
      t3Names={[]}
    />,
  );

describe("ClaudeMcpSection", () => {
  it("probes on mount, shows loading, then an error that Retry asks again about", async () => {
    probe.view = { data: null, error: null, isPending: true };
    const screen = await renderSection();

    expect(probe.claudeMcpStatus).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/home/me" },
    });
    await expect
      .element(screen.getByText("Asking Claude which servers it loaded..."))
      .toBeVisible();

    probe.view = {
      data: null,
      error: "Claude could not report its MCP servers.",
      isPending: false,
    };
    await screen.rerender(
      <ClaudeMcpSection
        environmentId={environmentId}
        cwd="/home/me"
        providers={[provider("claudeAgent", "Claude"), provider("codex", "Codex")]}
        t3Names={[]}
      />,
    );
    await expect
      .element(screen.getByText("Claude could not report its MCP servers."))
      .toBeVisible();
    await expect.element(screen.getByText("Codex: not reported by this provider.")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(probe.fresh).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/home/me", fresh: true },
    });
    // The list is re-read once the fresh probe has settled.
    await probe.fresh.mock.results[0]?.value;
    expect(probe.refresh).toHaveBeenCalledOnce();
  });

  it("shows Reconnect disabled with its reason, and Enable for a disabled server", async () => {
    probe.view = {
      data: {
        servers: [
          { name: "broken", status: "failed", toolCount: 0, scope: "user", error: "spawn ENOENT" },
          { name: "off", status: "disabled", toolCount: 0, scope: "user" },
        ],
      },
      error: null,
      isPending: false,
    };
    const screen = await renderSection();

    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    await expect.element(reconnect).toBeDisabled();
    await expect.element(reconnect).toHaveAttribute("title", "No active session");
    await expect.element(screen.getByRole("button", { name: "Enable" })).toBeVisible();
  });

  it("opens a Claude-only server's detail when its row is clicked", async () => {
    probe.view = {
      data: { servers: [{ name: "docs", status: "connected", toolCount: 2, scope: "user" }] },
      error: null,
      isPending: false,
    };
    probe.detail = {
      server: {
        name: "docs",
        status: "connected",
        toolCount: 2,
        scope: "user",
        transport: "http",
        url: "https://mcp.example.com/mcp",
        serverInfo: { name: "Docs MCP", version: "1.2.0" },
        tools: [],
      },
      checkedAt: "2026-10-24T10:00:00.000Z",
    };
    const screen = await renderSection();

    await userEvent.click(screen.getByRole("button", { name: /docs/ }));

    expect(probe.claudeMcpServerDetail).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/home/me", name: "docs" },
    });
    const dialog = screen.getByRole("dialog");
    await expect.element(dialog.getByText("Docs MCP 1.2.0")).toBeVisible();
    await expect.element(dialog.getByText("https://mcp.example.com/mcp")).toBeVisible();
    await expect.element(dialog.getByText("2 tools")).toBeVisible();
  });
});
