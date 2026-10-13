import type {
  McpServerCheck,
  McpServerConfig,
  ProjectId,
  ServerConfig,
  ServerConfigStreamEvent,
} from "@t3tools/contracts";
import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { applyServerConfigProjection } from "./serverConfigProjection.ts";
import {
  describeMcpServerCheck,
  mcpServerListRows,
  mcpThreadFallback,
  mcpSignInControl,
  selectMcpServerCheck,
  threadMcpRows,
} from "./mcpServerChecks.ts";

const check = (overrides: Partial<McpServerCheck> = {}): McpServerCheck => ({
  scope: "global",
  name: "docs",
  status: "connected",
  checkedAt: "2026-10-12T10:00:00.000Z",
  toolCount: 41,
  ...overrides,
});

describe("describeMcpServerCheck", () => {
  it("words each state for the panel", () => {
    expect(describeMcpServerCheck(check())).toBe("Connected · 41 tools");
    expect(describeMcpServerCheck(check({ toolCount: 1 }))).toBe("Connected · 1 tool");
    expect(describeMcpServerCheck(check({ status: "needs-auth" }))).toBe("Needs sign-in");
    expect(describeMcpServerCheck(check({ status: "checking" }))).toBe("Checking...");
    expect(describeMcpServerCheck(check({ status: "failed", error: "spawn ENOENT" }))).toBe(
      "Failed · spawn ENOENT",
    );
    expect(describeMcpServerCheck(check({ status: "failed" }))).toBe("Failed");
  });

  it("says so when nothing has been checked", () => {
    expect(describeMcpServerCheck(undefined)).toBe("Not checked yet");
  });
});

describe("selectMcpServerCheck", () => {
  it("finds the result by scope and name", () => {
    const config = { mcpServerChecks: [check(), check({ scope: "p1", status: "failed" })] };
    expect(selectMcpServerCheck(config, "global", "docs")?.status).toBe("connected");
    expect(selectMcpServerCheck(config, "p1", "docs")?.status).toBe("failed");
    expect(selectMcpServerCheck(config, "global", "other")).toBeUndefined();
    expect(selectMcpServerCheck(null, "global", "docs")).toBeUndefined();
    expect(selectMcpServerCheck({}, "global", "docs")).toBeUndefined();
  });
});

describe("server config projection", () => {
  it("replaces the whole check set on each event", () => {
    const snapshot = {
      version: 1,
      type: "snapshot",
      config: {
        environment: { capabilities: {} },
        mcpServerChecks: [check()],
      } as unknown as ServerConfig,
    } satisfies ServerConfigStreamEvent;
    const next = applyServerConfigProjection(Option.none(), snapshot);
    const updated = applyServerConfigProjection(next, {
      version: 1,
      type: "mcpServerChecksUpdated",
      payload: { checks: [check({ name: "other", status: "needs-auth" })] },
    });
    expect(Option.getOrThrow(updated).config.mcpServerChecks?.map((c) => c.name)).toEqual([
      "other",
    ]);
  });
});

describe("mcpSignInControl", () => {
  const http = (headers: ReadonlyArray<{ name: string }> = []) =>
    ({
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: headers.map((row) => ({ ...row, value: "", sensitive: true })),
    }) as McpServerConfig;

  it("offers sign-in once the server has asked for it, and sign-in again when expired", () => {
    expect(mcpSignInControl(http(), check({ status: "connected" }))).toEqual({ kind: "none" });
    expect(mcpSignInControl(http(), undefined)).toEqual({ kind: "none" });
    expect(mcpSignInControl(http(), check({ status: "needs-auth" }))).toEqual({
      kind: "sign-in",
      label: "Sign in",
    });
    expect(mcpSignInControl(http(), check({ status: "needs-auth", auth: "expired" }))).toEqual({
      kind: "sign-in",
      label: "Sign in again",
    });
    expect(mcpSignInControl(http(), check({ auth: "signed-in" }))).toEqual({ kind: "signed-in" });
  });

  it("is blocked by the entry's own Authorization header", () => {
    expect(
      mcpSignInControl(http([{ name: "authorization" }]), check({ status: "needs-auth" })),
    ).toEqual({ kind: "blocked", message: "Remove the Authorization header to sign in." });
  });

  it("is never offered for a command server", () => {
    expect(
      mcpSignInControl(
        { transport: "stdio", command: "x", args: [], env: [] },
        check({ status: "needs-auth" }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("words an expired sign-in", () => {
    expect(describeMcpServerCheck(check({ status: "needs-auth", auth: "expired" }))).toBe(
      "Sign-in expired",
    );
  });
});

describe("mcpServerListRows", () => {
  const projectId = "project-a" as ProjectId;
  const stdio = (command: string, enabled = true): McpServerConfig => ({
    transport: "stdio",
    command,
    args: [],
    env: [],
    ...(enabled ? {} : { enabled: false }),
  });
  const http = (url: string): McpServerConfig => ({ transport: "http", url, headers: [] });
  const settings = (
    mcpServers: Record<string, McpServerConfig>,
    project?: Record<string, McpServerConfig | { enabled: false }>,
  ) => ({
    mcpServers,
    projectSettingsOverrides: project === undefined ? {} : { [projectId]: { mcpServers: project } },
  });

  it("lists environment servers by name with their check text, tone and target", () => {
    const rows = mcpServerListRows({
      settings: settings({ web: http("https://mcp.example.com/mcp"), db: stdio("psql-mcp") }),
      config: {
        mcpServerChecks: [
          check({ name: "db", toolCount: 2 }),
          check({ name: "web", status: "failed", error: "refused" }),
        ],
      },
      projectId: null,
    });
    expect(rows.map((row) => [row.name, row.source, row.target, row.statusText, row.tone])).toEqual(
      [
        ["db", "environment", "psql-mcp", "Connected · 2 tools", "success"],
        ["web", "environment", "https://mcp.example.com/mcp", "Failed · refused", "error"],
      ],
    );
  });

  it("says Not checked yet with a neutral tone, and Off for a disabled server", () => {
    const rows = mcpServerListRows({
      settings: settings({ a: stdio("a"), b: stdio("b", false) }),
      config: null,
      projectId: null,
    });
    expect(rows.map((row) => [row.name, row.statusText, row.tone, row.enabled])).toEqual([
      ["a", "Not checked yet", "neutral", true],
      ["b", "Off", "neutral", false],
    ]);
  });

  it("points sign-in at desktop or web where the server shows OAuth", () => {
    const rows = mcpServerListRows({
      settings: settings({ a: http("https://a.example/mcp"), b: http("https://b.example/mcp") }),
      config: {
        mcpServerChecks: [
          check({ name: "a", status: "needs-auth", auth: "signed-out" }),
          check({ name: "b", auth: "signed-in" }),
        ],
      },
      projectId: null,
    });
    expect(rows.map((row) => [row.name, row.signInNote, row.tone])).toEqual([
      ["a", "Sign in from desktop or web", "warning"],
      ["b", "Signed in", "success"],
    ]);
  });

  it("splits a project into its own servers, overrides and inherited ones with sources", () => {
    const rows = mcpServerListRows({
      settings: settings(
        { gh: stdio("g"), db: stdio("d"), linear: stdio("l"), paused: stdio("p", false) },
        { local: stdio("x"), gh: stdio("g2"), linear: { enabled: false } },
      ),
      config: {
        mcpServerChecks: [
          check({ scope: projectId, name: "local" }),
          check({ scope: projectId, name: "gh", status: "failed" }),
          check({ scope: "global", name: "gh" }),
          check({ scope: "global", name: "db" }),
        ],
      },
      projectId,
    });
    expect(rows.map((row) => [row.name, row.source, row.statusText])).toEqual([
      ["gh", "override", "Failed"],
      ["local", "project", "Connected · 41 tools"],
      ["db", "environment", "Connected · 41 tools"],
      ["linear", "environment", "Off for this project"],
      ["paused", "environment", "Off on environment"],
    ]);
    expect(rows.filter((row) => row.enabled).map((row) => row.name)).toEqual(["gh", "local", "db"]);
  });
});

describe("mcpThreadFallback", () => {
  it("falls back to enabled servers with their checks, so the view is never empty-handed", () => {
    const stdio = (enabled: boolean): McpServerConfig => ({
      transport: "stdio",
      command: "x",
      args: [],
      env: [],
      ...(enabled ? {} : { enabled: false }),
    });
    const rows = mcpServerListRows({
      settings: {
        mcpServers: { on: stdio(true), off: stdio(false), fresh: stdio(true) },
        projectSettingsOverrides: {},
      },
      config: { mcpServerChecks: [check({ name: "on" }), check({ name: "off" })] },
      projectId: null,
    });
    const fallback = mcpThreadFallback(rows);
    expect(fallback.configuredNames).toEqual(["fresh", "on"]);
    expect(
      threadMcpRows({ sessionServers: null, ...fallback }).map((row) => [row.name, row.check]),
    ).toEqual([
      ["fresh", undefined],
      ["on", { status: "connected", detail: "41 tools" }],
    ]);
  });
});
