# MCP servers

MCP servers give your agents extra tools, such as GitHub, a database, or your team's docs.
Add one once in T3 Code and every provider that supports it gets it, so you don't have to
edit each provider's own config.

Manage them in **Settings > MCP servers**. T3 Code's built-in `t3-code` server is always
present and shows as built in. For Claude, the page also lists the servers Claude itself has
loaded. See [Servers Claude has loaded](#servers-claude-has-loaded).

## Add a server

Choose **Add server** and pick a transport:

- **Command** runs a local command. Give it a command, optional arguments, and any environment
  variables it needs, for example `npx @modelcontextprotocol/server-github`.
- **HTTP** connects to a hosted server by URL. Add any headers it needs.

Names are lowercase letters, digits, `_` and `-`, up to 32 characters. Names starting with
`t3-code` are reserved. A name can't change after you save the server, because its stored
secrets and sign-in stay attached to it.

Mark an environment variable or header as sensitive to store its value on the environment's
host. A saved secret shows as **Stored securely**, and T3 Code never shows the value again.
When you edit the server, leave that field alone to keep the value. A header value is
saved in plain settings unless you mark it sensitive. A token in the URL's query string is
always saved in plain settings, so send credentials as sensitive headers.

Each server shows a check result, such as **Connected · 41 tools**, **Needs sign-in**, or
**Failed** with the error. T3 Code checks a server when you save it. Use **Re-check** to
run the check again without starting a session. A server that has never been checked says
**Not checked yet**.

To pause a server without deleting it, switch it off. To remove it, choose **Remove**.
Removing a server also removes its stored secrets and sign-in.

## Use servers in a project

Servers you add in Settings apply to every project on that environment. With a project
selected, the page has two sections:

- **This project** holds servers you add for this project only, and any environment server
  you have overridden. A project-only server is not shown in other projects.
- **From <environment>** holds the environment's servers. Each has a switch that turns it off
  for this project, and **Override for project** to give the project its own configuration,
  for example a different token. **Use environment config** removes the override.

A server that is off at environment level shows **Off on environment**. Turn it on in the
environment's settings, because the project switch has no effect while it is off.

## Sign in to a server

Servers that use OAuth show a **Sign in** button. T3 Code runs the sign-in and keeps the
tokens on the environment's host. Providers never receive the token, and you don't need to
sign in again for each provider.

- **Same computer:** the browser returns to T3 Code automatically once you approve access.
- **Desktop, connected to a remote environment:** the desktop app catches the redirect and
  finishes the sign-in on the remote host.
- **Web from another device** (LAN, Tailscale, T3 Connect, or app.t3.codes): the browser
  can't reach the host's localhost, so the page can't finish by itself. After you approve,
  copy the full `http://127.0.0.1...` address from the browser's address bar, paste it into
  **Sign-in redirect URL**, and choose **Finish**.

The panel shows **Signed in**, **Sign-in expired** (choose **Sign in again**), or **Needs
sign-in**. **Sign out** takes effect straight away, including in running sessions. It deletes
T3 Code's copy of the tokens but doesn't revoke them at the provider.

A server with its own `Authorization` header can't use sign-in. Remove the header first.

Each project override has its own sign-in. A project that just inherits a server uses the
environment's sign-in.

## Servers Claude has loaded

With Claude, **Settings > MCP servers** also shows the servers Claude reports as loaded for
you, under **Claude's servers**: `claude.ai` connectors, servers from your `~/.claude`
configuration, and servers added by plugins. Servers with no recognised level are listed
under **Other**. Each row shows the server's name, its status (connected, pending, failed,
needs sign-in, or disabled), and how many tools it offers. The list loads when you open the
page and reuses the last result for a few minutes. Choose **Refresh** to check again after
changing your configuration. If the check fails or times out, the page shows the error with
**Retry**.

A server you added in T3 Code appears as one row with both its settings and Claude's live
status. Servers only Claude knows about are listed under their level with **Disable** or
**Enable**, but T3 Code can't edit them: change their configuration in Claude Code.

Click a Claude-only server's name, in Settings or a thread's **MCP** panel, to see what Claude
reports about it, including why it failed and which tools it offers. Sign-in still happens
outside T3 Code: the details only point you to claude.ai or `/mcp` in Claude Code.

This page shows user-level and organization-level servers. Servers tied to a project, such as
those from the project's `.mcp.json`, appear in the **MCP** panel of a thread in that project
instead, because they only apply there. Other providers that support MCP servers don't report
what they loaded, so the page says so rather than showing a list.

### Turn a server off and on

Choose **Disable** on a Claude-only server to stop sessions from loading it. It stays in the
list as disabled, with **Enable** to turn it back on. This works with no session running,
applies to new sessions straight away, and also takes effect in a running session without a
restart. Disabling is a T3 Code setting and never edits Claude's own configuration files.
Disabling from the **MCP** panel of a thread applies to that thread's project only; disabling
from Settings applies to the whole environment.

### Reconnect a server

If a Claude server has failed, its row shows **Reconnect**; a Claude-only server's details
offer it for any server that isn't disabled. In a
thread's **MCP** panel it reconnects the server in that thread's running session and then
re-checks the list so you can see whether it recovered. On the settings page it asks Claude
again from scratch, which starts the server anew.

### Servers that need sign-in

A Claude server that shows **Needs sign-in** can't be signed in from T3 Code. For a
`claude.ai` connector, follow the link to claude.ai to connect it. For any other server, run
`/mcp` in Claude Code and authenticate there; to sign a connected remote server out, clear its
sign-in from `/mcp` too. T3 Code never reads or changes Claude's stored sign-ins. Servers you
added in T3 Code keep their [sign-in](#sign-in-to-a-server) button.

## When changes apply

Changes to servers you add in T3 Code apply to new sessions. A session that is already running
keeps the servers it started with. The page says so after each save. Disabling or enabling a
Claude server is the exception and applies to running sessions immediately.

OpenCode is the exception. It shares one server per directory, so OpenCode sessions in the
project pick up changes right away.

## Which providers can use servers

| Provider                                          | User MCP servers                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Codex, Claude, Cursor, OpenCode, Muse, ACP agents | Stdio and HTTP                                                               |
| Pi                                                | Stdio and HTTP with Pi 0.99 or newer. Older Pi versions can't carry them.    |
| Grok, Antigravity                                 | Not supported. The server list shows **Not available in Grok, Antigravity**. |

If a provider can't carry a server, the session doesn't get it. Use a supported provider for
work that needs it.

Tool calls to your servers go through each provider's normal approval flow, so a new server
can't run tools without your approval. The built-in `t3-code` server stays auto-approved.

## See what a session has

Open a thread's **MCP** panel to see which servers the running session reports, including any
it skipped and why. For Claude, the panel also lists the project's own servers and offers
**Reconnect**. If the provider doesn't report server status, the panel shows each server
as unknown and falls back to T3 Code's check. **Manage MCP servers** in that panel opens the
settings page.

On mobile, the MCP list and the thread's MCP status are read-only. Edit servers, run checks,
and sign in on desktop or web.
