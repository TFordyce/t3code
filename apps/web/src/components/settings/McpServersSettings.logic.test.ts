import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import {
  configFromDraft,
  draftFromConfig,
  emptyDraft,
  providersWithoutMcpSupport,
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

    expect(configFromDraft(draft).env).toEqual([
      { name: "TOKEN", value: "", sensitive: true, valueRedacted: true },
      { name: "MODE", value: "fast", sensitive: false },
    ]);

    const retyped = {
      ...draft,
      env: [{ ...draft.env[0]!, value: "new", redacted: false }, draft.env[1]!],
    };
    expect(configFromDraft(retyped).env[0]).toEqual({
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
