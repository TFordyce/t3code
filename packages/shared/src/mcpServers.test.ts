import { DEFAULT_SERVER_SETTINGS, ProjectId, type McpServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMcpServers } from "./mcpServers.ts";
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
    const current = withServers({ a: { ...stdio("a"), args: ["--old"] } });
    const next = applyServerSettingsPatch(current, { mcpServers: { a: stdio("a") } });
    expect(next.mcpServers.a).toEqual(stdio("a"));
  });
});
