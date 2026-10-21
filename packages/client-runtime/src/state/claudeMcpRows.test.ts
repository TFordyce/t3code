import type { ClaudeMcpServerReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { claudeMcpView, unreportedProviderNames } from "./claudeMcpRows.ts";

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

  it("leaves out project-level servers", () => {
    const view = claudeMcpView({
      servers: [
        report({ name: "proj", scope: "project" }),
        report({ name: "loc", scope: "local" }),
        report({ name: "unknown", scope: undefined }),
      ],
      t3Names: [],
    });
    expect(view.groups).toEqual([]);
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
  it("names enabled providers other than Claude", () => {
    expect(
      unreportedProviderNames([
        { driver: "claudeAgent", enabled: true, displayName: "Claude" },
        { driver: "codex", enabled: true, displayName: "Codex" },
        { driver: "cursor", enabled: false },
        { driver: "opencode", enabled: true },
        { driver: "codex", enabled: true, displayName: "Codex" },
      ]),
    ).toEqual(["Codex", "opencode"]);
  });
});
