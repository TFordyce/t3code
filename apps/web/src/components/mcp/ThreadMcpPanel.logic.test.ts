import { describe, expect, it } from "vite-plus/test";

import { threadMcpRows } from "./ThreadMcpPanel.logic";

describe("threadMcpRows", () => {
  it("lists what the provider session reported, with errors and tool counts as detail", () => {
    expect(
      threadMcpRows({
        sessionServers: [
          { name: "docs", status: "connected", toolCount: 3 },
          { name: "crm", status: "needs-auth" },
          { name: "vault", status: "failed", error: "secret unavailable" },
          { name: "wide", status: "unsupported" },
        ],
        configuredNames: ["docs", "crm", "vault", "wide", "extra"],
      }),
    ).toEqual([
      { name: "docs", status: "connected", detail: "3 tools" },
      { name: "crm", status: "needs-auth" },
      { name: "vault", status: "failed", detail: "secret unavailable" },
      { name: "wide", status: "unsupported" },
    ]);
  });

  it("says one tool in the singular", () => {
    expect(
      threadMcpRows({
        sessionServers: [{ name: "docs", status: "connected", toolCount: 1 }],
        configuredNames: [],
      }),
    ).toEqual([{ name: "docs", status: "connected", detail: "1 tool" }]);
  });

  it("falls back to unknown for configured servers when the provider reports nothing", () => {
    expect(threadMcpRows({ sessionServers: null, configuredNames: ["docs", "crm"] })).toEqual([
      { name: "crm", status: "unknown" },
      { name: "docs", status: "unknown" },
    ]);
  });

  it("shows the server check beside unknown when one exists", () => {
    expect(
      threadMcpRows({
        sessionServers: null,
        configuredNames: ["docs", "crm"],
        serverCheckFor: (name) =>
          name === "docs" ? { status: "connected", toolCount: 41 } : undefined,
      }),
    ).toEqual([
      { name: "crm", status: "unknown" },
      { name: "docs", status: "unknown", check: { status: "connected", detail: "41 tools" } },
    ]);
  });
});
