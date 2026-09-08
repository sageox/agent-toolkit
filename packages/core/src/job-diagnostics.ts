import { z } from "zod";

export const DIAGNOSTIC_LIMIT_BYTES = 8192;
export const ExecutionInfoSchema = z.object({
  state: z.enum(["starting", "running", "exited", "not-started", "signalled", "timed-out", "interrupted"]),
  startedAt: z.number().int().positive(),
  endedAt: z.number().int().positive().optional(),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().min(1).max(128).nullable(),
}).strict();
export type ExecutionInfo = z.infer<typeof ExecutionInfoSchema>;

const OutputSchema = z.object({
  text: z.string().refine((text) => Buffer.byteLength(text) <= DIAGNOSTIC_LIMIT_BYTES, "diagnostic tail too large"),
  truncated: z.boolean(),
}).strict();
/** Private worker-to-dispatcher data. Never part of the model-facing status schema. */
export const WorkerDiagnosticsSchema = z.object({
  sequence: z.number().int().nonnegative(),
  execution: ExecutionInfoSchema,
  stdout: OutputSchema,
  stderr: OutputSchema,
  complete: z.boolean(),
}).strict();
export type WorkerDiagnostics = z.infer<typeof WorkerDiagnosticsSchema>;

/** Redact before truncating or forwarding, including secrets split across stream chunks. */
export function diagnosticOutput(secrets: readonly string[], forward: (text: string) => void) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const pattern = values.length ? new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : undefined;
  const lookbehind = Math.max(0, ...values.map((value) => value.length - 1));
  let pending = "", tail = "", truncated = false;

  const clip = (text: string) => {
    // Keep newlines and tabs; discard terminal control sequences' control characters.
    const bytes = Buffer.from(text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""));
    let start = Math.max(0, bytes.length - DIAGNOSTIC_LIMIT_BYTES);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    return { text: bytes.subarray(start).toString("utf8"), truncated: start > 0 };
  };
  const remainder = () => {
    let text = pattern ? pending.replace(pattern, "[REDACTED]") : pending;
    // A checkpoint or killed process may end halfway through a credential.
    for (const value of values) {
      for (let n = Math.min(value.length - 1, text.length); n > 0; n--) {
        if (text.endsWith(value.slice(0, n))) {
          text = text.slice(0, -n) + "[REDACTED]";
          break;
        }
      }
    }
    return text;
  };
  const append = (text: string) => {
    const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    forward(clean);
    const clipped = clip(tail + clean);
    tail = clipped.text;
    truncated ||= clipped.truncated;
  };
  return {
    write(chunk: string) {
      pending += chunk;
      let cutoff = Math.max(0, pending.length - lookbehind);
      // Forwarding encodes strings as UTF-8, so never split a surrogate pair.
      if (cutoff > 0 && /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(pending.slice(cutoff - 1, cutoff + 1))) cutoff--;
      let consumed = 0, output = "";
      if (pattern) {
        pattern.lastIndex = 0;
        for (let match; (match = pattern.exec(pending)) && match.index < cutoff;) {
          output += pending.slice(consumed, match.index) + "[REDACTED]";
          consumed = match.index + match[0].length;
        }
      }
      output += pending.slice(consumed, Math.max(consumed, cutoff));
      pending = pending.slice(Math.max(consumed, cutoff));
      append(output);
    },
    end() { append(remainder()); pending = ""; },
    snapshot() {
      const clipped = clip(tail + remainder());
      return { text: clipped.text, truncated: truncated || clipped.truncated };
    },
  };
}
