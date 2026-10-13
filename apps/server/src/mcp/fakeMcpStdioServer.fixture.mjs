// A stdio MCP server with three tools, for server check tests. It refuses to
// start when FIXTURE_REQUIRED is set to anything but "yes", which proves the
// materialized env reaches the child.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

if (process.env.FIXTURE_REQUIRED !== undefined && process.env.FIXTURE_REQUIRED !== "yes") {
  process.exit(3);
}
const server = new McpServer({ name: "fixture", version: "1.0.0" });
for (const name of ["one", "two", "three"]) {
  server.registerTool(name, { description: name }, async () => ({ content: [] }));
}
await server.connect(new StdioServerTransport());
