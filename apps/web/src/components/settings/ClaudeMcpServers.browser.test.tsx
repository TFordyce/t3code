import {
  ClaudeMcpAddError,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { render } from "../../../test/render";

const probe = vi.hoisted(() => ({
  claudeMcpStatus: vi.fn((target: unknown) => target),
  claudeMcpServerDetail: vi.fn((target: unknown) => ({ detail: target })),
  detail: null as unknown,
  refresh: vi.fn(),
  fresh: vi.fn((_target: unknown) => Promise.resolve({ _tag: "Success" })),
  command: vi.fn((_target: unknown): Promise<unknown> => Promise.resolve(undefined)),
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
      removeClaudeMcpServer: {
        ...actual.serverEnvironment.removeClaudeMcpServer,
        permissionAtom: () => Atom.make(true),
      },
      addClaudeMcpServer: {
        ...actual.serverEnvironment.addClaudeMcpServer,
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
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => probe.command) as never,
}));

import { ClaudeMcpSection } from "./ClaudeMcpServers";

const environmentId = EnvironmentId.make("environment-1");

// The test page has no stacking CSS, so the modal's inert backdrop sits over
// the popup and swallows pointer clicks; click the element directly instead.
const clickInDialog = (locator: { element: () => Element }) =>
  (locator.element() as HTMLElement).click();

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
    await using screen = await renderSection();

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

  it("asks Claude again from a failed row's Reconnect, and offers Enable for a disabled server", async () => {
    probe.fresh.mockClear();
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
    await using screen = await renderSection();

    await expect.element(screen.getByRole("button", { name: "Enable" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(probe.fresh).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/home/me", fresh: true },
    });
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
    await using screen = await renderSection();

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

  it("disables a server from its dialog, then asks Claude again so the dialog updates", async () => {
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
        tools: [],
      },
      checkedAt: "2026-10-24T10:00:00.000Z",
    };
    probe.fresh.mockClear();
    probe.command.mockReset();
    probe.command.mockResolvedValue(AsyncResult.success(undefined));
    await using screen = await renderSection();

    await userEvent.click(screen.getByRole("button", { name: /docs/ }));
    const dialog = screen.getByRole("dialog");
    await expect
      .element(dialog.getByText("Run /mcp in Claude Code to clear sign-in."))
      .toBeVisible();
    clickInDialog(dialog.getByRole("button", { name: "Disable" }));

    expect(probe.command).toHaveBeenCalledWith({
      environmentId,
      input: { name: "docs", enabled: false },
    });
    await probe.command.mock.results[0]?.value;
    expect(probe.fresh).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/home/me", fresh: true },
    });
  });

  it("asks to confirm Remove before removing, then asks Claude again", async () => {
    probe.view = {
      data: { servers: [{ name: "docs", status: "connected", toolCount: 2, scope: "user" }] },
      error: null,
      isPending: false,
    };
    probe.detail = {
      server: { name: "docs", status: "connected", toolCount: 2, scope: "user", tools: [] },
      checkedAt: "2026-10-24T10:00:00.000Z",
    };
    probe.fresh.mockClear();
    probe.command.mockReset();
    probe.command.mockResolvedValue(AsyncResult.success(undefined));
    await using screen = await renderSection();

    await userEvent.click(screen.getByRole("button", { name: /docs/ }));
    clickInDialog(screen.getByRole("dialog").getByRole("button", { name: "Remove" }));
    const confirm = screen.getByRole("alertdialog");
    await expect.element(confirm.getByText("Remove docs?")).toBeVisible();
    expect(probe.command).not.toHaveBeenCalled();

    clickInDialog(confirm.getByRole("button", { name: "Remove server" }));
    expect(probe.command).toHaveBeenCalledWith({
      environmentId,
      input: { name: "docs", scope: "user", cwd: "/home/me" },
    });
    await probe.command.mock.results[0]?.value;
    await vi.waitFor(() =>
      expect(probe.fresh).toHaveBeenCalledWith({
        environmentId,
        input: { cwd: "/home/me", fresh: true },
      }),
    );
  });

  it("reconnects from the dialog by asking Claude again", async () => {
    probe.view = {
      data: { servers: [{ name: "docs", status: "failed", toolCount: 0, scope: "user" }] },
      error: null,
      isPending: false,
    };
    probe.detail = {
      server: { name: "docs", status: "failed", toolCount: 0, scope: "user", tools: [] },
      checkedAt: "2026-10-24T10:00:00.000Z",
    };
    probe.fresh.mockClear();
    await using screen = await renderSection();

    await userEvent.click(screen.getByRole("button", { name: /docs/ }));
    clickInDialog(screen.getByRole("dialog").getByRole("button", { name: "Reconnect" }));
    expect(probe.fresh).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/home/me", fresh: true },
    });
  });

  it("shows the open dialog probing, with its actions held, until the fresh probe settles", async () => {
    probe.view = {
      data: { servers: [{ name: "docs", status: "failed", toolCount: 0, scope: "user" }] },
      error: null,
      isPending: false,
    };
    probe.detail = {
      server: { name: "docs", status: "failed", toolCount: 0, scope: "user", tools: [] },
      checkedAt: "2026-10-24T10:00:00.000Z",
    };
    let settle: (result: { _tag: "Success" }) => void = () => {};
    probe.fresh.mockImplementationOnce(
      () => new Promise<{ _tag: "Success" }>((resolve) => (settle = resolve)),
    );
    await using screen = await renderSection();

    await userEvent.click(screen.getByRole("button", { name: /docs/ }));
    const dialog = screen.getByRole("dialog");
    clickInDialog(dialog.getByRole("button", { name: "Reconnect" }));

    await expect.element(dialog.getByRole("status")).toBeVisible();
    await expect.element(dialog.getByRole("button", { name: "Reconnect" })).toBeDisabled();
    await expect.element(dialog.getByRole("button", { name: "Disable" })).toBeDisabled();

    settle(AsyncResult.success(undefined));
    await expect.element(dialog.getByRole("button", { name: "Reconnect" })).toBeEnabled();
    await expect.element(dialog.getByRole("status")).not.toBeInTheDocument();
  });

  it("adds a stdio server to Claude from the form, then re-reads the list", async () => {
    probe.view = { data: { servers: [] }, error: null, isPending: false };
    probe.command.mockReset();
    probe.command.mockResolvedValue(AsyncResult.success({}));
    probe.refresh.mockClear();
    probe.fresh.mockClear();
    await using screen = await renderSection();

    await userEvent.click(screen.getByRole("button", { name: "Add server" }));
    await expect
      .element(screen.getByText("Claude saves these as plain text in ~/.claude.json."))
      .toBeVisible();
    await userEvent.fill(screen.getByLabelText("Server name"), "acme");
    await userEvent.fill(screen.getByLabelText("Command"), "npx");
    await userEvent.fill(screen.getByLabelText("Arguments"), "-y\n@acme/mcp\n");
    await userEvent.click(screen.getByRole("button", { name: "Add variable" }));
    await userEvent.fill(screen.getByLabelText("Variable name"), "API_KEY");
    await userEvent.fill(screen.getByLabelText("Variable value"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Add to Claude" }));

    expect(probe.command).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: "/home/me",
        name: "acme",
        scope: "user",
        server: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@acme/mcp"],
          env: { API_KEY: "secret" },
        },
      },
    });
    await expect
      .element(screen.getByText("Added acme. It applies to new Claude sessions."))
      .toBeVisible();
    // The server already re-probed fresh, so the list is only re-read.
    expect(probe.refresh).toHaveBeenCalledOnce();
    expect(probe.fresh).not.toHaveBeenCalled();
  });

  it("shows Claude's error in the form and keeps it open", async () => {
    probe.view = { data: { servers: [] }, error: null, isPending: false };
    probe.command.mockReset();
    probe.command.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(
          new ClaudeMcpAddError({
            reason: "rejected",
            detail: "MCP server acme already exists in user config",
          }),
        ),
      ),
    );
    await using screen = await renderSection();

    await userEvent.click(screen.getByRole("button", { name: "Add server" }));
    await userEvent.fill(screen.getByLabelText("Server name"), "acme");
    await userEvent.fill(screen.getByLabelText("Command"), "npx");
    await userEvent.click(screen.getByRole("button", { name: "Add to Claude" }));

    await expect
      .element(screen.getByText("MCP server acme already exists in user config"))
      .toBeVisible();
    await expect.element(screen.getByLabelText("Server name")).toHaveValue("acme");
  });
  it("with a project, defaults the add to Local scope in the project's root and offers User", async () => {
    probe.view = { data: { servers: [] }, error: null, isPending: false };
    probe.command.mockReset();
    probe.command.mockResolvedValue(AsyncResult.success({}));
    const projectId = ProjectId.make("project-1");
    await using screen = await render(
      <ClaudeMcpSection
        environmentId={environmentId}
        cwd="/work/repo"
        projectId={projectId}
        providers={[provider("claudeAgent", "Claude")]}
        t3Names={[]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add server" }));
    await expect
      .element(screen.getByRole("button", { name: "Local" }))
      .toHaveAttribute("aria-pressed", "true");
    await userEvent.fill(screen.getByLabelText("Server name"), "acme");
    await userEvent.fill(screen.getByLabelText("Command"), "npx");
    await userEvent.click(screen.getByRole("button", { name: "Add to Claude" }));

    expect(probe.command).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        cwd: "/work/repo",
        projectId,
        name: "acme",
        scope: "local",
        server: { type: "stdio", command: "npx", args: [], env: {} },
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Add server" }));
    await userEvent.click(screen.getByRole("button", { name: "User" }));
    await userEvent.fill(screen.getByLabelText("Server name"), "acme");
    await userEvent.fill(screen.getByLabelText("Command"), "npx");
    await userEvent.click(screen.getByRole("button", { name: "Add to Claude" }));

    expect(probe.command).toHaveBeenLastCalledWith({
      environmentId,
      input: expect.objectContaining({ projectId, scope: "user" }),
    });
  });

  it("without a project, offers only User scope", async () => {
    probe.view = { data: { servers: [] }, error: null, isPending: false };
    await using screen = await renderSection();

    await userEvent.click(screen.getByRole("button", { name: "Add server" }));
    await expect.element(screen.getByLabelText("Server name")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Local" })).not.toBeInTheDocument();
  });
});
