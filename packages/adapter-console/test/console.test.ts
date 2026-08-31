import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { ConsoleAdapter } from "../src/console.ts";
import type { InboundEvent } from "@sageox/agent-toolkit-core";

describe("ConsoleAdapter", () => {
  it("emits a line as an InboundEvent and writes sends", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const got: InboundEvent[] = [];
    const a = new ConsoleAdapter({ input, output });
    await a.start((e) => got.push(e));
    input.write("hello there\n");
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toHaveLength(1);
    expect(got[0].text).toBe("hello there");
    expect(got[0].mentionsMe).toBe(true);

    const out: string[] = [];
    output.on("data", (c) => out.push(c.toString()));
    await a.send(got[0].channel, { text: "hi back" });
    expect(out.join("")).toContain("hi back");
    await a.stop();
  });
});
