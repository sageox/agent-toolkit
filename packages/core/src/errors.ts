/** What an unknown thrown value says. `catch` binds `unknown`, so every printer needs this. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** First line only, for a failure going into a line-oriented `key=value` log record. */
export function errorLine(error: unknown): string {
  return errorText(error).split("\n")[0];
}
