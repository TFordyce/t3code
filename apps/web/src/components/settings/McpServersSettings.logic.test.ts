import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type McpServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  configFromDraft,
  draftFromConfig,
  emptyDraft,
  overrideDraftFromEnvironment,
  projectMcpPatch,
  projectMcpRows,
  providersWithoutMcpSupport,
  saveNotice,
  selectProjectMcpCheck,
  urlQueryTokenWarning,
  validateDraft,
} from "./McpServersSettings.logic";

describe("validateDraft", () => {
  const draft = (overrides: Partial<ReturnType<typeof emptyDraft>>) => ({
    ...emptyDraft(),
    command: "npx",
    ...overrides,
  });

  it("accepts a valid new server", () => {
    expect(validateDraft(draft({ name: "github" }), { existingNames: [], isNew: true })).toEqual(
      {},
    );
  });

  it.each(["", "Upper", "has space", "-lead", "a".repeat(33)])("flags name %j", (name) => {
    expect(validateDraft(draft({ name }), { existingNames: [], isNew: true }).name).toBeDefined();
  });

  it("flags the reserved t3-code prefix", () => {
    expect(
      validateDraft(draft({ name: "t3-code-extra" }), { existingNames: [], isNew: true }).name,
    ).toMatch(/reserved/);
  });

  it("flags a new name that is already taken but not the saved server itself", () => {
    expect(
      validateDraft(draft({ name: "github" }), { existingNames: ["github"], isNew: true }).name,
    ).toMatch(/already/);
    expect(
      validateDraft(draft({ name: "github" }), { existingNames: ["github"], isNew: false }),
    ).toEqual({});
  });

  it("requires a command", () => {
    expect(
      validateDraft(draft({ name: "ok", command: "  " }), { existingNames: [], isNew: true })
        .command,
    ).toBeDefined();
  });

  it("flags invalid and repeated environment variable names", () => {
    const errors = validateDraft(
      draft({
        name: "ok",
        env: [
          { name: "1BAD", value: "x", sensitive: false, redacted: false },
          { name: "TOKEN", value: "x", sensitive: false, redacted: false },
          { name: "TOKEN", value: "y", sensitive: false, redacted: false },
        ],
      }),
      { existingNames: [], isNew: true },
    );
    expect(errors.env).toBeDefined();
  });
});

const stdioEnv = (config: ReturnType<typeof configFromDraft>) =>
  config.transport === "stdio" ? config.env : [];

describe("config round trip", () => {
  it("keeps a stored secret redacted unless a new value is typed", () => {
    const draft = draftFromConfig("gh", {
      transport: "stdio",
      command: "gh-mcp",
      args: ["--read-only", "serve"],
      env: [
        { name: "TOKEN", value: "", sensitive: true, valueRedacted: true },
        { name: "MODE", value: "fast", sensitive: false },
      ],
    });
    expect(draft.args).toBe("--read-only\nserve");
    expect(draft.env[0]).toEqual({ name: "TOKEN", value: "", sensitive: true, redacted: true });

    expect(stdioEnv(configFromDraft(draft))).toEqual([
      { name: "TOKEN", value: "", sensitive: true, valueRedacted: true },
      { name: "MODE", value: "fast", sensitive: false },
    ]);

    const retyped = {
      ...draft,
      env: [{ ...draft.env[0]!, value: "new", redacted: false }, draft.env[1]!],
    };
    expect(stdioEnv(configFromDraft(retyped))[0]).toEqual({
      name: "TOKEN",
      value: "new",
      sensitive: true,
    });
  });

  it("trims, drops blank args and blank env rows, and keeps the enabled flag", () => {
    expect(
      configFromDraft({
        ...emptyDraft(),
        name: "x",
        command: "  run  ",
        args: "a\n\n  b  \n",
        env: [{ name: " ", value: "", sensitive: false, redacted: false }],
        enabled: false,
      }),
    ).toEqual({ transport: "stdio", command: "run", args: ["a", "b"], env: [], enabled: false });
  });
});

describe("http servers", () => {
  const http = (overrides: Partial<ReturnType<typeof emptyDraft>>) => ({
    ...emptyDraft(),
    transport: "http" as const,
    name: "docs",
    url: "https://mcp.example.com/mcp",
    ...overrides,
  });

  it("needs a valid http(s) URL and no command", () => {
    expect(validateDraft(http({}), { existingNames: [], isNew: true })).toEqual({});
    expect(validateDraft(http({ url: "" }), { existingNames: [], isNew: true }).url).toBeDefined();
    expect(
      validateDraft(http({ url: "ftp://x.example" }), { existingNames: [], isNew: true }).url,
    ).toBeDefined();
    expect(
      validateDraft(http({ url: "not a url" }), { existingNames: [], isNew: true }).url,
    ).toBeDefined();
  });

  it("flags invalid and repeated header names", () => {
    const row = (name: string) => ({ name, value: "x", sensitive: false, redacted: false });
    expect(
      validateDraft(http({ headers: [row("Bad Header")] }), { existingNames: [], isNew: true })
        .headers,
    ).toBeDefined();
    expect(
      validateDraft(http({ headers: [row("X-A"), row("x-a")] }), {
        existingNames: [],
        isNew: true,
      }).headers,
    ).toBeDefined();
  });

  it("round-trips headers and keeps a stored secret redacted", () => {
    const draft = draftFromConfig("docs", {
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: [
        { name: "Authorization", value: "", sensitive: true, valueRedacted: true },
        { name: "X-Mode", value: "fast", sensitive: false },
      ],
      enabled: false,
    });
    expect(draft.transport).toBe("http");
    expect(draft.headers[0]).toEqual({
      name: "Authorization",
      value: "",
      sensitive: true,
      redacted: true,
    });
    expect(configFromDraft(draft)).toEqual({
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: [
        { name: "Authorization", value: "", sensitive: true, valueRedacted: true },
        { name: "X-Mode", value: "fast", sensitive: false },
      ],
      enabled: false,
    });
  });
});

describe("urlQueryTokenWarning", () => {
  it("warns when a query parameter looks like a credential", () => {
    expect(urlQueryTokenWarning("https://x.example/mcp?api_key=abc")).toMatch(/header/);
    expect(urlQueryTokenWarning("https://x.example/mcp?foo=1&access_token=abc")).toBeDefined();
  });

  it("stays quiet for plain URLs", () => {
    expect(urlQueryTokenWarning("https://x.example/mcp")).toBeUndefined();
    expect(urlQueryTokenWarning("https://x.example/mcp?page=2")).toBeUndefined();
    expect(urlQueryTokenWarning("not a url")).toBeUndefined();
  });
});

describe("providersWithoutMcpSupport", () => {
  const provider = (id: string, userMcpTransports?: Array<"stdio" | "http">, enabled = true) =>
    ({
      instanceId: ProviderInstanceId.make(id),
      driver: ProviderDriverKind.make(id),
      displayName: id.toUpperCase(),
      enabled,
      ...(userMcpTransports ? { userMcpTransports } : {}),
    }) as unknown as ServerProvider;

  it("names enabled providers that declare no support for the transport", () => {
    expect(
      providersWithoutMcpSupport(
        [provider("codex", ["stdio"]), provider("claude", []), provider("grok", ["http"])],
        "stdio",
      ),
    ).toEqual(["CLAUDE", "GROK"]);
  });

  it("does not blame providers whose support is unknown or that are disabled", () => {
    expect(providersWithoutMcpSupport([provider("a"), provider("b", [], false)], "stdio")).toEqual(
      [],
    );
  });
});

describe("saveNotice", () => {
  const provider = (driver: string, enabled = true) =>
    ({
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      enabled,
    }) as unknown as ServerProvider;

  it("says only new sessions are affected when no OpenCode provider is enabled", () => {
    expect(saveNotice([provider("codex"), provider("opencode", false)])).toBe(
      "Applies to new sessions.",
    );
  });

  it("scopes the notice to the project on a project page", () => {
    expect(saveNotice([provider("opencode")], "project")).toBe(
      "Applies to new sessions in this project. OpenCode sessions in this project pick it up now.",
    );
  });

  it("adds the OpenCode caveat, because its shared server applies changes to running sessions", () => {
    expect(saveNotice([provider("codex"), provider("opencode")])).toBe(
      "Applies to new sessions. OpenCode sessions pick it up now.",
    );
  });
});

describe("project MCP rows", () => {
  const projectId = ProjectId.make("project-a");
  const stdio = (command: string, enabled?: boolean): McpServerConfig => ({
    transport: "stdio",
    command,
    args: [],
    env: [],
    ...(enabled === undefined ? {} : { enabled }),
  });
  const settings = (
    mcpServers: Record<string, McpServerConfig>,
    project: Record<string, McpServerConfig | { enabled: false }> | undefined,
    other: Record<string, McpServerConfig | { enabled: false }> = {},
  ) => ({
    mcpServers,
    projectSettingsOverrides: {
      ...(project === undefined ? {} : { [projectId]: { mcpServers: project } }),
      [ProjectId.make("project-b")]: { mcpServers: other },
    },
  });

  it("splits project-only servers, overrides and inherited rows", () => {
    const rows = projectMcpRows(
      settings(
        { gh: stdio("g"), db: stdio("d"), linear: stdio("l"), paused: stdio("p", false) },
        { local: stdio("x"), gh: stdio("g2"), linear: { enabled: false } },
      ),
      projectId,
    );
    expect(rows.project.map((row) => [row.name, row.kind])).toEqual([
      ["gh", "override"],
      ["local", "project"],
    ]);
    expect(
      rows.inherited.map((row) => [row.name, row.offForProject, row.offOnEnvironment]),
    ).toEqual([
      ["db", false, false],
      ["linear", true, false],
      ["paused", false, true],
    ]);
  });

  it("ignores a marker for a server the environment no longer has", () => {
    const rows = projectMcpRows(settings({}, { ghost: { enabled: false } }), projectId);
    expect(rows).toEqual({ project: [], inherited: [] });
  });

  it("reads other projects' overrides as nothing", () => {
    const rows = projectMcpRows(
      settings({ gh: stdio("g") }, undefined, { gh: stdio("x") }),
      projectId,
    );
    expect(rows.inherited.map((row) => row.name)).toEqual(["gh"]);
    expect(rows.project).toEqual([]);
  });
});

describe("projectMcpPatch", () => {
  const projectId = ProjectId.make("project-a");
  const gh: McpServerConfig = { transport: "stdio", command: "g", args: [], env: [] };

  it("round-trips off, on, override and use-environment-config", () => {
    let current: Record<string, unknown> = {};
    const apply = (patch: ReturnType<typeof projectMcpPatch>) => {
      current = { ...current, ...patch.projectSettingsOverrides };
    };
    const entry = () => (current as Record<string, unknown>)[projectId] ?? null;

    apply(projectMcpPatch({ projectSettingsOverrides: {} }, projectId, "gh", { enabled: false }));
    expect(entry()).toEqual({ mcpServers: { gh: { enabled: false } } });

    apply(projectMcpPatch({ projectSettingsOverrides: current as never }, projectId, "gh", null));
    expect(entry()).toBeNull();

    apply(projectMcpPatch({ projectSettingsOverrides: current as never }, projectId, "gh", gh));
    expect(entry()).toEqual({ mcpServers: { gh } });

    apply(projectMcpPatch({ projectSettingsOverrides: current as never }, projectId, "gh", null));
    expect(entry()).toBeNull();
  });

  it("keeps the project's other overrides and servers", () => {
    const patch = projectMcpPatch(
      {
        projectSettingsOverrides: {
          [projectId]: { defaultAutoPull: true, mcpServers: { db: { enabled: false } } },
        },
      },
      projectId,
      "gh",
      gh,
    );
    expect(patch.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: true,
      mcpServers: { db: { enabled: false }, gh },
    });
    const cleared = projectMcpPatch(
      { projectSettingsOverrides: { [projectId]: { defaultAutoPull: true, mcpServers: { gh } } } },
      projectId,
      "gh",
      null,
    );
    expect(cleared.projectSettingsOverrides[projectId]).toEqual({ defaultAutoPull: true });
  });
});

describe("overrideDraftFromEnvironment", () => {
  it("does not carry stored secrets over, since they belong to the environment entry", () => {
    const draft = overrideDraftFromEnvironment("gh", {
      transport: "stdio",
      command: "g",
      args: ["-y"],
      env: [
        { name: "TOKEN", value: "", sensitive: true, valueRedacted: true },
        { name: "MODE", value: "fast", sensitive: false },
      ],
    });
    expect(draft.env).toEqual([
      { name: "TOKEN", value: "", sensitive: true, redacted: false },
      { name: "MODE", value: "fast", sensitive: false, redacted: false },
    ]);
    expect(draft.command).toBe("g");
    expect(draft.enabled).toBe(true);
  });
});

describe("selectProjectMcpCheck", () => {
  const check = (scope: string, status: "connected" | "failed") => ({
    scope,
    name: "gh",
    status,
    checkedAt: "2026-10-13T00:00:00.000Z",
  });
  const config = { mcpServerChecks: [check("global", "connected"), check("project-a", "failed")] };

  it("shows an override's own result and an inherited row's environment result", () => {
    expect(selectProjectMcpCheck(config, "project-a", "gh", "override")?.status).toBe("failed");
    expect(selectProjectMcpCheck(config, "project-a", "gh", "project")?.status).toBe("failed");
    expect(selectProjectMcpCheck(config, "project-a", "gh", "global")?.status).toBe("connected");
  });
});
