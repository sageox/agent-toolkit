import { z } from "zod";

/** Bounds are serialized UTF-8 bytes, including the versioned envelope. */
export const JOB_OUTPUT_LIMIT_BYTES = 16 * 1024;
export const JOB_ARTIFACT_LIMIT_BYTES = 64 * 1024;
export const JOB_STATUS_LIMIT_BYTES = JOB_OUTPUT_LIMIT_BYTES + 4096;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function isJson(value: unknown, depth = 0): value is Json {
  if (depth > 32 || depth === 32 && value !== null && typeof value === "object") return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    for (const item of value) if (!isJson(item, depth + 1)) return false;
    return true;
  }
  return typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every((item) => isJson(item, depth + 1));
}

const OutputEnvelopeSchema = z.object({ version: z.literal(1), data: z.custom<Json>(isJson) }).strict();
export const JobOutputEnvelopeSchema = OutputEnvelopeSchema.refine(
  (value) => Buffer.byteLength(JSON.stringify(value)) <= JOB_OUTPUT_LIMIT_BYTES,
  "job output exceeds its byte limit",
);
export const FinalJobOutputSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), value: JobOutputEnvelopeSchema }).strict(),
  z.object({ state: z.enum(["missing", "invalid", "oversized", "interrupted", "blocked", "unavailable"]) }).strict(),
]);
export type FinalJobOutput = z.infer<typeof FinalJobOutputSchema>;
export const JobOutputStatusSchema = z.object({
  state: z.enum(["pending", "available", "missing", "invalid", "oversized", "interrupted", "blocked", "unavailable", "expired"]),
  // Present only on an explicitly authorized read. Ordinary status contains availability alone.
  value: JobOutputEnvelopeSchema.optional(),
}).strict().refine((output) => output.value === undefined || output.state === "available");

/** Reject a credential-bearing answer whole: redacting a proposed change could alter its meaning. */
export function collectJobOutput(raw: unknown, secrets: readonly string[]): FinalJobOutput {
  if (raw === undefined) return { state: "missing" };
  const parsed = OutputEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { state: "invalid" };
  const serialized = JSON.stringify(parsed.data);
  if (Buffer.byteLength(serialized) > JOB_OUTPUT_LIMIT_BYTES) return { state: "oversized" };
  const values = secrets.filter(Boolean);
  let blocked = values.some((secret) => serialized.includes(secret));
  // Check decoded keys and strings too, so JSON escapes cannot hide a known credential.
  JSON.stringify(parsed.data, (key, value: unknown) => {
    if (values.some((secret) => key.includes(secret) || typeof value === "string" && value.includes(secret))) blocked = true;
    return value;
  });
  return blocked ? { state: "blocked" } : { state: "available", value: parsed.data };
}
