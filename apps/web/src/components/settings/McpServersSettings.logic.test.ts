import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import {
  configFromDraft,
  draftFromConfig,
  emptyDraft,
  providersWithoutMcpSupport,
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
