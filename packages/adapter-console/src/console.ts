import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  SurfaceAdapter,
  InboundEvent,
  GuardedMessage,
  ChannelRef,
} from "@sageox/agent-toolkit-core";

const CHANNEL: ChannelRef = { surface: "console", id: "local", isPublic: false };
let seq = 0;

/**
 * A first-class surface, not a mock: `try` runs the real gateway, guard, and egress —
 * only the transport is local.
 */
export class ConsoleAdapter implements SurfaceAdapter {
  readonly kind = "console";
  private rl?: Interface;

  constructor(private io: { input: Readable; output: Writable }) {}

  async start(onEvent?: (e: InboundEvent) => void): Promise<void> {
    // The console is only ever a reply destination, so a caller with nothing to listen for
    // has nothing to connect to either — and taking stdin for it would be worse than idle.
    if (!onEvent) return;
    this.rl = createInterface({ input: this.io.input });
    this.rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      onEvent({
        id: { surface: "console", nativeId: String(++seq) },
        surface: "console",
        channel: CHANNEL,
        author: { surface: "console", id: "local-user", isSelf: false, isAgent: false },
        text,
        mentionsMe: true,
        ts: new Date().toISOString(),
        raw: line,
      });
    });
  }

  async send(_channel: ChannelRef, msg: GuardedMessage): Promise<void> {
    this.io.output.write(`\nagent> ${msg.text}\n`);
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }
}
