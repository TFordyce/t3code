import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { AsyncResult } from "effect/reactivity";

import { render } from "../../../test/render";

const probe = vi.hoisted(() => ({
  claudeMcpStatus: vi.fn((target: unknown) => target),
  claudeMcpServerDetail: vi.fn((target: unknown) => ({ detail: target })),
  list: null as unknown,
  detail: null as unknown,
  refresh: vi.fn(),
  fresh: vi.fn((_target: unknown) => Promise.resolve({ _tag: "Success" })),
  command: vi.fn((_target: unknown): Promise<unknown> => Promise.resolve(undefined)),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const claude = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    status: "ready",
    userMcpTransports: ["stdio", "http"],
  } as unknown as ServerProvider;
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: () => Atom.make(null),
      configValueAtom: () => Atom.make(null),
      providersValueAtom: () => Atom.make([claude]),
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
  } as never;
});
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) =>
    atom !== null && typeof atom === "object" && "detail" in atom
      ? { data: probe.detail, error: null, isPending: false, refresh: probe.refresh }
      : {
          data: atom === null ? null : probe.list,
          error: null,
          isPending: false,
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

import { ThreadMcpPanel } from "./ThreadMcpPanel";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

// The test page has no stacking CSS, so the modal's inert backdrop sits over
// the popup and swallows pointer clicks; click the element directly instead.
const clickInDialog = (locator: { element: () => Element }) =>
  (locator.element() as HTMLElement).click();

describe("ThreadMcpPanel", () => {
  it("opens a Claude project server's detail, where Reconnect reconnects the live session then asks Claude again", async () => {
    probe.list = {
      servers: [
        { name: "repo-tools", status: "failed", toolCount: 0, scope: "project", error: "boom" },
      ],
    };
    probe.detail = {
      server: {
        name: "repo-tools",
        status: "failed",
        toolCount: 0,
        scope: "project",
        error: "boom",
        tools: [],
      },
      checkedAt: "2026-10-24T10:00:00.000Z",
    };
    probe.command.mockResolvedValue(AsyncResult.success(undefined));
    await using screen = await render(
      <ThreadMcpPanel
        environmentId={environmentId}
        sessionServers={[]}
        projectId={projectId}
        cwd="/work/repo"
        threadId={threadId}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /repo-tools/ }));

    expect(probe.claudeMcpServerDetail).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/work/repo", projectId, name: "repo-tools" },
    });
    const dialog = screen.getByRole("dialog");
    clickInDialog(dialog.getByRole("button", { name: "Reconnect" }));

    expect(probe.command).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, name: "repo-tools" },
    });
    await probe.command.mock.results[0]?.value;
    expect(probe.fresh).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/work/repo", projectId, fresh: true },
    });
  });
});
