import type { McpServerCheck, ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";
import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { applyServerConfigProjection } from "./serverConfigProjection.ts";
import { describeMcpServerCheck, selectMcpServerCheck } from "./mcpServerChecks.ts";

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
