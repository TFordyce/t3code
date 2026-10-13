import {
  cancelLoopbackOAuthCallback,
  receiveLoopbackOAuthCallback,
} from "@t3tools/shared/loopbackOAuthCallback";

const INVALID = "Invalid MCP sign-in request.";

/**
 * An MCP server's authorization URL as the environment host built it. The host
 * registers a bare `http://127.0.0.1:<port>/callback` redirect, which is the
 * only thing this computer will listen on.
 */
export function mcpAuthorizationRequest(value: string) {
  const url = new URL(value);
  if (
    value.length > 16_384 ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error(INVALID);
  const single = (key: string) => {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || !values[0]) throw new Error(INVALID);
    return values[0];
  };
  const redirectUri = single("redirect_uri");
  const state = single("state");
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/callback$/u.test(redirectUri) ||
    Number(new URL(redirectUri).port) > 65_535 ||
    !/^[\w-]{16,128}$/u.test(state) ||
    single("response_type") !== "code"
  )
    throw new Error(INVALID);
  return { authorizationUrl: url.toString(), redirectUri, state };
}

/** A redirect for the active sign-in: its state, and exactly one of a code or an error. */
export function mcpCallbackUrl(value: string, redirectUri: string, state: string) {
  const callback = new URL(value);
  const expected = new URL(redirectUri);
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  const states = callback.searchParams.getAll("state");
  if (
    value.length > 16_384 ||
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username ||
    callback.password ||
    callback.hash ||
    states.length !== 1 ||
    states[0] !== state ||
    !(
      (codes.length === 1 && Boolean(codes[0]) && errors.length === 0) ||
      (errors.length === 1 && Boolean(errors[0]) && codes.length === 0)
    )
  )
    throw new Error("This redirect URL does not belong to the current sign-in.");
  return callback;
}

export function cancelMcpSignInCallback(authorizationUrl: string) {
  cancelLoopbackOAuthCallback(mcpAuthorizationRequest(authorizationUrl).state);
}

/** Catch an MCP sign-in redirect on this computer for a remote environment host. */
export function receiveMcpSignInCallback(
  authorizationUrl: string,
  openBrowser: (url: string) => Promise<boolean>,
  signal?: AbortSignal,
) {
  return receiveLoopbackOAuthCallback(
    {
      request: mcpAuthorizationRequest(authorizationUrl),
      callbackUrl: (value, request) => mcpCallbackUrl(value, request.redirectUri, request.state),
      portInUseMessage:
        "The sign-in callback port is in use on this computer. Close the other sign-in and try again, or paste the redirect URL in T3 Code.",
    },
    openBrowser,
    undefined,
    signal,
  );
}
