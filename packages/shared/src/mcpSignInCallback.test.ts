// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Tests exercise the real native loopback listener.
import * as NodeHttp from "node:http";
import { describe, expect, it } from "vite-plus/test";
import {
  cancelMcpSignInCallback,
  mcpAuthorizationRequest,
  mcpCallbackUrl,
  receiveMcpSignInCallback,
} from "./mcpSignInCallback.ts";

async function freePort() {
  const server = NodeHttp.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
function authorize(port: number, state = "s".repeat(32)) {
  const url = new URL("https://auth.example.com/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "client-one",
    redirect_uri: `http://127.0.0.1:${port}/callback`,
    state,
    code_challenge_method: "S256",
    code_challenge: "c".repeat(43),
  }).toString();
  return url.toString();
}
function redirect(authorizationUrl: string, extra: Record<string, string> = { code: "the-code" }) {
  const request = new URL(authorizationUrl);
  const url = new URL(request.searchParams.get("redirect_uri")!);
  url.search = new URLSearchParams({
    state: request.searchParams.get("state")!,
    ...extra,
  }).toString();
  return url.toString();
}

describe("mcpAuthorizationRequest", () => {
  it("reads the loopback redirect port and state from an https authorization URL", () => {
    const url = authorize(4567);
    expect(mcpAuthorizationRequest(url)).toMatchObject({
      redirectUri: "http://127.0.0.1:4567/callback",
      state: "s".repeat(32),
    });
  });
  it("rejects a redirect that is not a bare loopback listener", () => {
    for (const bad of [
      authorize(4567).replace("127.0.0.1", "evil.example.com"),
      authorize(4567).replace("%2Fcallback", "%2Fother%2Fpath"),
      authorize(4567).replace("4567", "80%40evil.com"),
      authorize(4567).replace("https:", "ftp:"),
      authorize(4567).replace("state=", "state=x&state="),
    ]) {
      expect(() => mcpAuthorizationRequest(bad)).toThrow();
    }
  });
});

describe("mcpCallbackUrl", () => {
  it("accepts a code or an error for the active state and rejects anything else", () => {
    const request = mcpAuthorizationRequest(authorize(4567));
    const ok = (extra: Record<string, string>) =>
      mcpCallbackUrl(redirect(authorize(4567), extra), request.redirectUri, request.state);
    expect(ok({ code: "x" }).searchParams.get("code")).toBe("x");
    expect(ok({ code: "x", iss: "https://auth.example.com" }).searchParams.get("iss")).toBeTruthy();
    expect(ok({ error: "access_denied" }).searchParams.get("error")).toBe("access_denied");
    expect(() => ok({})).toThrow();
    expect(() => ok({ code: "x", error: "y" })).toThrow();
    expect(() =>
      mcpCallbackUrl(
        redirect(authorize(4567)).replace(`state=${request.state}`, "state=foreign"),
        request.redirectUri,
        request.state,
      ),
    ).toThrow();
  });
});

describe("receiveMcpSignInCallback", () => {
  it("binds before opening the browser, ignores a foreign response and returns the code redirect", async () => {
    const authorizationUrl = authorize(await freePort());
    const expected = redirect(authorizationUrl);
    const received = await receiveMcpSignInCallback(authorizationUrl, async (opened) => {
      expect(opened).toBe(authorizationUrl);
      const foreign = new URL(expected);
      foreign.searchParams.set("state", "foreign");
      expect((await fetch(foreign)).status).toBe(400);
      const response = await fetch(expected);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("the-code");
      return true;
    });
    expect(received).toBe(expected);
  });
  it("reports a busy port so the caller can fall back to pasting", async () => {
    const blocker = NodeHttp.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    let opened = false;
    try {
      await expect(
        receiveMcpSignInCallback(authorize(port), async () => {
          opened = true;
          return true;
        }),
      ).rejects.toThrow(/in use/);
      expect(opened).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
  it("cancels and releases the port", async () => {
    const authorizationUrl = authorize(await freePort());
    await expect(
      receiveMcpSignInCallback(authorizationUrl, async () => {
        cancelMcpSignInCallback(authorizationUrl);
        return true;
      }),
    ).rejects.toThrow("cancelled");
    expect(
      await receiveMcpSignInCallback(authorizationUrl, async () => {
        await fetch(redirect(authorizationUrl));
        return true;
      }),
    ).toBe(redirect(authorizationUrl));
  });
});
