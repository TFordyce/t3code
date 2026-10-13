import * as Schema from "effect/Schema";
import { codexAuthorizationRequest, codexCallbackUrl } from "@t3tools/shared/codexAuthHandoff";
import {
  cancelLoopbackOAuthCallback,
  receiveLoopbackOAuthCallback,
} from "@t3tools/shared/loopbackOAuthCallback";

export class CodexAuthCallbackError extends Schema.TaggedError<CodexAuthCallbackError>()(
  "CodexAuthCallbackError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export function cancelCodexAuthCallback(authorizationUrl: string) {
  cancelLoopbackOAuthCallback(codexAuthorizationRequest(authorizationUrl).state);
}

/** Receive an authorization code locally. Credentials and PKCE stay on the target environment. */
export function receiveCodexAuthCallback(
  authorizationUrl: string,
  openBrowser: (url: string) => Promise<boolean>,
  destination?: (callbackUrl: string) => string,
  signal?: AbortSignal,
) {
  return receiveLoopbackOAuthCallback(
    {
      request: codexAuthorizationRequest(authorizationUrl),
      callbackUrl: (value, request) => codexCallbackUrl(value, request.redirectUri, request.state),
      portInUseMessage:
        "The ChatGPT callback port is in use on this computer. Close the other sign-in and try again, or paste the redirect URL in T3 Code.",
    },
    openBrowser,
    destination,
    signal,
  );
}
