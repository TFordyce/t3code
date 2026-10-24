import type { ClaudeMcpServerDetail, ClaudeMcpServerReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { claudeMcpDetailView, claudeMcpView, unreportedProviderNames } from "./claudeMcpRows.ts";

const report = (overrides: Partial<ClaudeMcpServerReport> = {}): ClaudeMcpServerReport => ({
  name: "docs",
  status: "connected",
  toolCount: 3,
  scope: "user",
  ...overrides,
});

describe("claudeMcpView", () => {
  it("merges a Claude server with a T3-configured one of the same name", () => {
    const view = claudeMcpView({
      servers: [report({ name: "docs", toolCount: 7 }), report({ name: "other" })],
      t3Names: ["docs"],
    });
    expect(view.merged.get("docs")).toMatchObject({
      statusText: "Connected · 7 tools",
      tone: "success",
    });
    expect(view.groups.flatMap((group) => group.rows.map((row) => row.name))).toEqual(["other"]);
  });

  it("groups Claude-only servers by scope with claude.ai named for its connectors", () => {
    const view = claudeMcpView({
      servers: [
        report({ name: "figma", scope: "claudeai" }),
        report({ name: "mine", scope: "user" }),
        report({ name: "corp", scope: "managed" }),
        report({ name: "plug", scope: "plugin" }),
      ],
      t3Names: [],
    });
    expect(view.groups.map((group) => [group.label, group.rows.map((row) => row.name)])).toEqual([
      ["User", ["mine"]],
      ["claude.ai", ["figma"]],
      ["Managed", ["corp"]],
      ["Plugins", ["plug"]],
    ]);
  });

  it("keeps project-level servers off the Settings groups and in projectGroups", () => {
    const view = claudeMcpView({
      servers: [
        report({ name: "proj", scope: "project" }),
        report({ name: "loc", scope: "local" }),
        report({ name: "dyn", scope: "dynamic" }),
        report({ name: "ag", scope: "agent" }),
        report({ name: "mine", scope: "user" }),
      ],
      t3Names: [],
    });
    expect(view.groups.flatMap((group) => group.rows.map((row) => row.name))).toEqual(["mine"]);
    expect(
      view.projectGroups.map((group) => [group.label, group.rows.map((row) => row.name)]),
    ).toEqual([
      ["Project", ["proj"]],
      ["Local", ["loc"]],
      ["Dynamic", ["dyn"]],
      ["Agent", ["ag"]],
    ]);
  });

  it("shows servers with no or an unrecognised scope under Other instead of dropping them", () => {
    const view = claudeMcpView({
      servers: [
        report({ name: "bare", scope: undefined }),
        report({ name: "odd", scope: "somethingnew" }),
      ],
      t3Names: [],
    });
    expect(view.groups.map((group) => [group.label, group.rows.map((row) => row.name)])).toEqual([
      ["Other", ["bare", "odd"]],
    ]);
  });

  it("leaves user and org servers out of projectGroups", () => {
    const view = claudeMcpView({
      servers: [
        report({ name: "mine", scope: "user" }),
        report({ name: "figma", scope: "claudeai" }),
      ],
      t3Names: [],
    });
    expect(view.projectGroups).toEqual([]);
  });

  it("tags t3-code as built in instead of listing it in a group", () => {
    const view = claudeMcpView({
      servers: [report({ name: "t3-code", scope: "sdk", toolCount: 12 })],
      t3Names: [],
    });
    expect(view.builtIn).toMatchObject({ name: "t3-code", statusText: "Connected · 12 tools" });
    expect(view.groups).toEqual([]);
  });

  it("points a needs-auth connector at claude.ai", () => {
    const view = claudeMcpView({
      servers: [report({ name: "figma", scope: "claudeai", status: "needs-auth" })],
      t3Names: [],
    });
    expect(view.groups[0]?.rows[0]).toMatchObject({
      statusText: "Needs sign-in",
      tone: "warning",
      guidance: { kind: "link", href: "https://claude.ai/settings/connectors" },
    });
  });

  it("tells a needs-auth server elsewhere to run /mcp in Claude Code", () => {
    const view = claudeMcpView({
      servers: [report({ name: "mine", status: "needs-auth" })],
      t3Names: [],
    });
    expect(view.groups[0]?.rows[0]?.guidance).toEqual({
      kind: "text",
      text: "Run /mcp in Claude Code to sign in.",
    });
  });

  it("gives merged rows no guidance, since T3's own sign-in handles them", () => {
    const view = claudeMcpView({
      servers: [report({ name: "docs", status: "needs-auth" })],
      t3Names: ["docs"],
    });
    expect(view.merged.get("docs")?.guidance).toBeUndefined();
  });

  it("shows failures with their error", () => {
    const view = claudeMcpView({
      servers: [report({ name: "mine", status: "failed", error: "spawn ENOENT" })],
      t3Names: [],
    });
    expect(view.groups[0]?.rows[0]).toMatchObject({
      statusText: "Failed · spawn ENOENT",
      tone: "error",
    });
  });
});

describe("unreportedProviderNames", () => {
  it("names enabled non-Claude providers that support MCP, and skips those that do not", () => {
    const transports = ["stdio", "http"];
    expect(
      unreportedProviderNames([
        {
          driver: "claudeAgent",
          enabled: true,
          displayName: "Claude",
          userMcpTransports: transports,
        },
        { driver: "codex", enabled: true, displayName: "Codex", userMcpTransports: transports },
        { driver: "cursor", enabled: false, userMcpTransports: transports },
        { driver: "opencode", enabled: true, userMcpTransports: transports },
        { driver: "codex", enabled: true, displayName: "Codex", userMcpTransports: transports },
        { driver: "antigravity", enabled: true, displayName: "Antigravity", userMcpTransports: [] },
        { driver: "grok", enabled: true, displayName: "Grok", userMcpTransports: [] },
      ]),
    ).toEqual(["Codex", "opencode"]);
  });
});

const detail = (overrides: Partial<ClaudeMcpServerDetail> = {}): ClaudeMcpServerDetail => ({
  name: "docs",
  status: "connected",
  toolCount: 2,
  scope: "user",
  source: "user",
  transport: "http",
  url: "https://mcp.example.com/mcp",
  serverInfo: { name: "Docs MCP", version: "1.2.0" },
  tools: [],
  ...overrides,
});

const detailResult = (server: ClaudeMcpServerDetail | null) => ({
  server,
  checkedAt: "2026-10-24T10:00:00.000Z",
});

describe("claudeMcpDetailView", () => {
  it("is loading while the first probe runs", () => {
    expect(claudeMcpDetailView({ data: null, isPending: true, error: null })).toEqual({
      kind: "loading",
    });
  });

  it("shows a probe error when there is nothing to show yet", () => {
    expect(
      claudeMcpDetailView({ data: null, isPending: false, error: "Claude could not report" }),
    ).toEqual({ kind: "error", message: "Claude could not report" });
  });

  it("says Claude no longer reports a server that has disappeared", () => {
    expect(
      claudeMcpDetailView({ data: detailResult(null), isPending: false, error: null }),
    ).toEqual({ kind: "missing", message: "Claude no longer reports this server" });
  });

  it("describes a connected remote server with its version, URL, scope and tool count", () => {
    const view = claudeMcpDetailView({
      data: detailResult(detail()),
      isPending: false,
      error: null,
    });
    expect(view).toEqual({
      kind: "server",
      refreshing: false,
      name: "docs",
      status: "connected",
      statusText: "Connected",
      tone: "success",
      serverInfo: "Docs MCP 1.2.0",
      transport: "HTTP",
      target: "https://mcp.example.com/mcp",
      location: "User",
      toolCountText: "2 tools",
      tools: [],
    });
  });

  it("names a stdio server's command and adds the source when it differs from the scope", () => {
    const view = claudeMcpDetailView({
      data: detailResult(
        detail({
          transport: "stdio",
          url: undefined,
          command: "npx",
          scope: "user",
          source: "plugin",
          serverInfo: undefined,
          toolCount: 1,
        }),
      ),
      isPending: false,
      error: null,
    });
    expect(view).toMatchObject({
      transport: "stdio",
      target: "npx",
      location: "User (from Plugin)",
      toolCountText: "1 tool",
    });
    expect(view).not.toHaveProperty("serverInfo");
  });

  it("shows a failed server's error and hides its version", () => {
    const view = claudeMcpDetailView({
      data: detailResult(detail({ status: "failed", error: "401 Unauthorized", toolCount: 0 })),
      isPending: false,
      error: null,
    });
    expect(view).toMatchObject({
      statusText: "Failed",
      tone: "error",
      error: "401 Unauthorized",
      toolCountText: "0 tools",
    });
    expect(view).not.toHaveProperty("serverInfo");
  });

  it("keeps showing the last answer, marked refreshing, while Claude is asked again", () => {
    expect(
      claudeMcpDetailView({ data: detailResult(detail()), isPending: true, error: null }),
    ).toMatchObject({ kind: "server", refreshing: true });
  });

  it("labels a claude.ai connector by transport and scope", () => {
    expect(
      claudeMcpDetailView({
        data: detailResult(
          detail({ transport: "claudeai", scope: "claudeai", source: "claudeai" }),
        ),
        isPending: false,
        error: null,
      }),
    ).toMatchObject({ transport: "claude.ai", location: "claude.ai" });
  });
});
