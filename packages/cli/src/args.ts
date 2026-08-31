/** `--name value` → the value, or the fallback when the flag is absent. */
export function flag(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

/**
 * A flag's value, refusing to read the next option as one.
 *
 * `--channels --allow-public` hands the following option through as the value, and
 * `--channels` at the end of the line hands through nothing. Both would be written as
 * config that names nothing real — a surface that is configured-looking and deaf, a
 * consented destination called `buzz:--allow-public`, an `owner` nobody matches, or a
 * model pin reading `--agent`. An omitted flag stays valid: that is how a mentions-only
 * agent, an unanswered author gate, or an unpinned model is asked for.
 */
export function optionValue(argv: string[], name: string, wants: string): string | undefined {
  if (!argv.includes(`--${name}`)) return undefined;
  const value = flag(argv, name);
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs ${wants}`);
  return value;
}

/**
 * The first bare word in argv — an agent name, a preset, a subcommand target.
 *
 * `valued` names the options that take a value, so the word after one is never read as
 * the positional: without it, `logs --tail 100 harry` would name "100" and
 * `secrets --dir /tmp x` would name the directory. Which options come first is not
 * something a caller should have to think about.
 */
export function positional(argv: string[], valued: ReadonlySet<string>): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) return arg;
    if (valued.has(arg)) i++; // skip its value
  }
  return undefined;
}
