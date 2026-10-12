import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AuthProvidersManageScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";
import {
  requiredScopesForServerSettingsPatch,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

const stdio = { transport: "stdio", command: "npx", args: ["-y", "server"], env: [] } as const;

describe("ServerSettings mcpServers", () => {
  it("defaults to no servers", () => {
    expect(decodeServerSettings({}).mcpServers).toEqual({});
  });

  it("decodes a stdio server with defaults", () => {
    const settings = decodeServerSettings({
      mcpServers: { github: { transport: "stdio", command: "gh-mcp" } },
    });
    expect(settings.mcpServers.github).toEqual({
      transport: "stdio",
      command: "gh-mcp",
      args: [],
      env: [],
    });
  });

  it("drops invalid stored entries instead of failing the decode", () => {
    const settings = decodeServerSettings({
      mcpServers: {
        ok: stdio,
        "Bad Name": stdio,
        "t3-code-extra": stdio,
        broken: { transport: "stdio" },
      },
      worktreesDirectory: "keep-me",
    });
    expect(Object.keys(settings.mcpServers)).toEqual(["ok"]);
    expect(settings.worktreesDirectory).toBe("keep-me");
  });
});

describe("ServerSettingsPatch mcpServers", () => {
  it.each(["a", "0abc", "my_server-1", "a".repeat(32)])("accepts name %s", (name) => {
    expect(() => decodeServerSettingsPatch({ mcpServers: { [name]: stdio } })).not.toThrow();
  });

  it.each(["", "Upper", "_lead", "-lead", "a".repeat(33), "has space", "t3-code", "t3-code-x"])(
    "rejects name %j",
    (name) => {
      expect(() => decodeServerSettingsPatch({ mcpServers: { [name]: stdio } })).toThrow();
    },
  );

  it("carries null to remove an entry", () => {
    expect(decodeServerSettingsPatch({ mcpServers: { github: null } })).toEqual({
      mcpServers: { github: null },
    });
  });

  it("requires providers-manage and not settings-write", () => {
    expect(
      requiredScopesForServerSettingsPatch({ mcpServers: { a: { ...stdio, args: [] } } }),
    ).toEqual([AuthProvidersManageScope]);
  });
});

describe("http MCP server config", () => {
  it("decodes an http server with defaults and header rows", () => {
    const settings = decodeServerSettings({
      mcpServers: {
        docs: {
          transport: "http",
          url: "https://mcp.example.com/mcp",
          headers: [{ name: "X-Api-Key", value: "k", sensitive: true }],
        },
        bare: { transport: "http", url: "https://mcp.example.com/bare" },
      },
    });
    expect(settings.mcpServers.docs).toEqual({
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: [{ name: "X-Api-Key", value: "k", sensitive: true }],
    });
    expect(settings.mcpServers.bare).toEqual({
      transport: "http",
      url: "https://mcp.example.com/bare",
      headers: [],
    });
  });

  it("drops http entries with a bad header name or a non-http url", () => {
    const settings = decodeServerSettings({
      mcpServers: {
        ok: { transport: "http", url: "https://a.example/mcp" },
        spaced: {
          transport: "http",
          url: "https://a.example/mcp",
          headers: [{ name: "Bad Header", value: "x" }],
        },
        ftp: { transport: "http", url: "ftp://a.example/mcp" },
        junk: { transport: "http", url: "not a url" },
      },
    });
    expect(Object.keys(settings.mcpServers)).toEqual(["ok"]);
  });
});

describe("client permission for mcpServers patches", () => {
  it("guards a settings update that changes MCP servers with providers-manage", () => {
    expect(
      clientRpcRequiredScopes(WS_METHODS.serverUpdateSettings, {
        patch: { mcpServers: { docs: null } },
      }),
    ).toEqual([AuthProvidersManageScope]);
  });

  it("leaves other settings updates to their existing checks", () => {
    expect(
      clientRpcRequiredScopes(WS_METHODS.serverUpdateSettings, {
        patch: { worktreesDirectory: "x" },
      }),
    ).toEqual([]);
    expect(clientRpcRequiredScopes(WS_METHODS.serverUpdateSettings, undefined)).toEqual([]);
  });
});
