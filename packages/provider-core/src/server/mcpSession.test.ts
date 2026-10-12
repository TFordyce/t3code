import { describe, expect, it } from "vite-plus/test";
import { sessionMcpStatuses, withAgentDeviceEnvironment } from "./mcpSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

describe("sessionMcpStatuses", () => {
  const docs = {
    name: "docs",
    transport: "stdio" as const,
    command: "docs-mcp",
    args: [],
    env: {},
  };

  it("lists nothing when the session carries no user servers", () => {
    expect(sessionMcpStatuses({ config: undefined, transports: ["stdio"] })).toBeUndefined();
    expect(
      sessionMcpStatuses({
        config: { userMcp: { servers: [], skipped: [] } },
        transports: ["stdio"],
      }),
    ).toBeUndefined();
  });

  it("shows configured servers as unknown until the provider reports them", () => {
    expect(
      sessionMcpStatuses({
        config: { userMcp: { servers: [docs], skipped: [] } },
        transports: ["stdio"],
      }),
    ).toEqual([{ name: "docs", status: "unknown" }]);
  });

  it("uses the provider report and never lists t3-code or unconfigured servers", () => {
    expect(
      sessionMcpStatuses({
        config: { userMcp: { servers: [docs], skipped: [] } },
        transports: ["stdio"],
        reported: [
          { name: "t3-code", status: "connected" },
          { name: "native", status: "connected" },
          { name: "docs", status: "connected", toolCount: 3 },
        ],
      }),
    ).toEqual([{ name: "docs", status: "connected", toolCount: 3 }]);
  });

  it("marks transports the adapter does not carry as unsupported and unreadable secrets as failed", () => {
    expect(
      sessionMcpStatuses({
        config: {
          userMcp: {
            servers: [{ ...docs, name: "other", transport: "sse" } as never],
            skipped: [
              { name: "vault", reason: "secret-unavailable" },
              { name: "legacy", reason: "unsupported" },
            ],
          },
        },
        transports: ["stdio"],
      }),
    ).toEqual([
      { name: "other", status: "unsupported" },
      { name: "vault", status: "failed", error: "secret unavailable" },
      { name: "legacy", status: "unsupported" },
    ]);
  });
});
