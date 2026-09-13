import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpToolServer, serveMcp, type HostedMcp } from "../src/mcp-http.ts";
import { ToolPolicy } from "../src/tool-policy.ts";

let hosted: HostedMcp | undefined;
afterEach(async () => {
  await hosted?.close();
});

describe("gateway MCP tool permissions", () => {
  it("lists only allowed tools and refuses direct calls before executing them", async () => {
    const call = vi.fn(async () => "done");
    hosted = await serveMcp(mcpToolServer({
      name: "brain",
      tools: () => [
        { name: "brain_read", inputSchema: { type: "object" } },
        { name: "brain_write", inputSchema: { type: "object" } },
      ],
      call,
    }), {
      toolPolicy: {
        server: "brain",
        policy: new ToolPolicy(
          ["mcp__brain__brain_read", "mcp__brain__brain_write"],
          ["mcp__brain__brain_write"],
        ),
      },
    });
    const request = async (method: string, name?: string) => {
      const response = await fetch(hosted!.url, {
        method: "POST",
        headers: { authorization: `Bearer ${hosted!.token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { name, arguments: {} } }),
      });
      return response.json() as Promise<{
        result?: { tools?: { name: string }[]; content?: { text: string }[] };
        error?: { message: string };
      }>;
    };
    expect((await request("tools/list")).result?.tools?.map((t) => t.name)).toEqual(["brain_read"]);
    expect((await request("tools/call", "brain_write")).error?.message).toMatch(/denied/);
    expect((await request("tools/call", "unlisted")).error?.message).toMatch(/not allowlisted/);
    expect(call).not.toHaveBeenCalled();
    expect((await request("tools/call", "brain_read")).result?.content).toEqual([{ type: "text", text: "done" }]);
    expect(call).toHaveBeenCalledExactlyOnceWith("brain_read", {});
  });
});
