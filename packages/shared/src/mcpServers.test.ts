import { DEFAULT_SERVER_SETTINGS, ProjectId, type McpServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { patchChangesProjectMcpServers, resolveMcpServers } from "./mcpServers.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectId = ProjectId.make("project-a");

const stdio = (command: string, enabled?: boolean): McpServerConfig => ({
  transport: "stdio",
  command,
  args: [],
  env: [],
  ...(enabled === undefined ? {} : { enabled }),
});

const withServers = (mcpServers: Record<string, McpServerConfig>) => ({
  ...DEFAULT_SERVER_SETTINGS,
  mcpServers,
});

describe("resolveMcpServers", () => {
  it("returns global entries in name order with their source", () => {
    const resolved = resolveMcpServers(
      withServers({ zeta: stdio("z"), alpha: stdio("a", true) }),
      projectId,
    );
    expect(resolved).toEqual([
      { name: "alpha", config: stdio("a", true), source: "global" },
      { name: "zeta", config: stdio("z"), source: "global" },
    ]);
  });

  it("drops disabled entries", () => {
    const resolved = resolveMcpServers(
      withServers({ off: stdio("x", false), on: stdio("y") }),
      projectId,
    );
    expect(resolved.map((server) => server.name)).toEqual(["on"]);
  });

  it("resolves without a project", () => {
    expect(resolveMcpServers(withServers({ a: stdio("a") }), null)).toHaveLength(1);
  });

  it("is empty by default", () => {
    expect(resolveMcpServers(DEFAULT_SERVER_SETTINGS, projectId)).toEqual([]);
  });
});

const withProject = (
  mcpServers: Record<string, McpServerConfig>,
  projectMcpServers: Record<string, McpServerConfig | { enabled: false }>,
  id: ProjectId = projectId,
) => ({
  ...withServers(mcpServers),
  projectSettingsOverrides: { [id]: { mcpServers: projectMcpServers } },
});

describe("resolveMcpServers project overrides", () => {
  it("replaces a global entry with a full project config", () => {
    const resolved = resolveMcpServers(
      withProject({ gh: stdio("global") }, { gh: stdio("project") }),
      projectId,
    );
    expect(resolved).toEqual([{ name: "gh", config: stdio("project"), source: "override" }]);
  });

  it("turns a global entry off with a bare marker, for that project only", () => {
    const settings = withProject({ gh: stdio("g"), db: stdio("d") }, { gh: { enabled: false } });
    expect(resolveMcpServers(settings, projectId).map((s) => s.name)).toEqual(["db"]);
    expect(resolveMcpServers(settings, ProjectId.make("project-b")).map((s) => s.name)).toEqual([
      "db",
      "gh",
    ]);
    expect(resolveMcpServers(settings, null).map((s) => s.name)).toEqual(["db", "gh"]);
  });

  it("adds project-only servers", () => {
    const resolved = resolveMcpServers(
      withProject({ db: stdio("d") }, { local: stdio("l") }),
      projectId,
    );
    expect(resolved.map((s) => [s.name, s.source])).toEqual([
      ["db", "global"],
      ["local", "project"],
    ]);
  });

  it("lets a project override a globally disabled entry", () => {
    const resolved = resolveMcpServers(
      withProject({ gh: stdio("g", false) }, { gh: stdio("p") }),
      projectId,
    );
    expect(resolved.map((s) => [s.name, s.source])).toEqual([["gh", "override"]]);
  });

  it("keeps a globally disabled entry out of the project", () => {
    expect(resolveMcpServers(withProject({ gh: stdio("g", false) }, {}), projectId)).toEqual([]);
  });

  it("drops a disabled project-only config and a marker with no global entry", () => {
    const resolved = resolveMcpServers(
      withProject({}, { off: stdio("x", false), ghost: { enabled: false } }),
      projectId,
    );
    expect(resolved).toEqual([]);
  });
});

describe("applyServerSettingsPatch mcpServers", () => {
  it("adds, replaces and removes one entry at a time", () => {
    const added = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      mcpServers: { a: stdio("a"), b: stdio("b") },
    });
    expect(Object.keys(added.mcpServers)).toEqual(["a", "b"]);

    const replaced = applyServerSettingsPatch(added, { mcpServers: { a: stdio("a2") } });
    expect(replaced.mcpServers.a).toEqual(stdio("a2"));
    expect(replaced.mcpServers.b).toEqual(stdio("b"));

    const removed = applyServerSettingsPatch(replaced, { mcpServers: { a: null } });
    expect(Object.keys(removed.mcpServers)).toEqual(["b"]);
  });

  it("does not leave args from the replaced entry behind", () => {
    const current = withServers({
      a: { transport: "stdio", command: "a", args: ["--old"], env: [] },
    });
    const next = applyServerSettingsPatch(current, { mcpServers: { a: stdio("a") } });
    expect(next.mcpServers.a).toEqual(stdio("a"));
  });
});

describe("patchChangesProjectMcpServers", () => {
  const redactedGh = (extra: Partial<McpServerConfig> = {}): McpServerConfig =>
    ({
      ...stdio("gh"),
      env: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
      ...extra,
    }) as McpServerConfig;
  const current = {
    projectSettingsOverrides: {
      [projectId]: { mcpServers: { gh: redactedGh() }, defaultAutoPull: true },
    },
  };

  it("is false when a client resends the stored entry with an unrelated edit", () => {
    expect(
      patchChangesProjectMcpServers(current, {
        projectSettingsOverrides: {
          [projectId]: { mcpServers: { gh: redactedGh() }, defaultAutoPull: false },
        },
      }),
    ).toBe(false);
  });

  it("ignores patches that do not touch project overrides, and other projects", () => {
    expect(patchChangesProjectMcpServers(current, {})).toBe(false);
    expect(
      patchChangesProjectMcpServers(current, {
        projectSettingsOverrides: { [ProjectId.make("project-b")]: { defaultAutoPull: true } },
      }),
    ).toBe(false);
  });

  it("is true for an added, edited, retyped-secret or marker change", () => {
    const entry = (mcpServers: Record<string, McpServerConfig | { enabled: false }>) => ({
      projectSettingsOverrides: { [projectId]: { mcpServers } },
    });
    expect(
      patchChangesProjectMcpServers(current, entry({ gh: redactedGh(), db: stdio("db") })),
    ).toBe(true);
    expect(
      patchChangesProjectMcpServers(current, entry({ gh: redactedGh({ enabled: false }) })),
    ).toBe(true);
    expect(
      patchChangesProjectMcpServers(
        current,
        entry({
          gh: redactedGh({
            env: [{ name: "TOKEN", value: "new", sensitive: true }],
          } as Partial<McpServerConfig>),
        }),
      ),
    ).toBe(true);
    expect(patchChangesProjectMcpServers(current, entry({ gh: { enabled: false } }))).toBe(true);
  });

  it("is true when the entry is dropped or resent without its servers", () => {
    expect(
      patchChangesProjectMcpServers(current, { projectSettingsOverrides: { [projectId]: null } }),
    ).toBe(true);
    expect(
      patchChangesProjectMcpServers(current, {
        projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
      }),
    ).toBe(true);
  });
});
