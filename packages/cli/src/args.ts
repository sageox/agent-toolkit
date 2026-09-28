/**
 * Every option a command reads. `flag`, `optionValue` and `hasFlag` accept only these
 * names, so reading an option through them means listing it here, and
 * `refuseUnknownOptions` refuses whatever is not listed.
 */
const VALUED = [
  "about", "age-identity", "age-recipient", "agent", "app-id", "args", "avatar",
  "avatar-candidates", "boundary", "brain", "bundle", "channel", "channels", "command",
  "context", "display-name", "expression", "inputs", "job-secrets", "joke", "metaphor",
  "model", "name", "namespace", "nip05", "owner", "owner-id", "palette", "param", "path",
  "private-channels", "profiles", "query", "relay", "run-id", "scope", "secret-refs",
  "secrets", "seconds", "success", "team", "trigger", "vault", "visual", "voice", "with",
  "write-scope",
] as const;
const SWITCHES = [
  "add-as-bot", "allow-public", "generate-avatar", "non-interactive", "output", "private",
  "replace-avatar", "starter-avatar",
] as const;

type Valued = (typeof VALUED)[number];

/** The options that take a value, as they are written. `flag` reads the next word as the value. */
export const VALUED_OPTIONS: ReadonlySet<string> = new Set(VALUED.map((name) => `--${name}`));
const SWITCH_OPTIONS: ReadonlySet<string> = new Set(SWITCHES.map((name) => `--${name}`));

/** `--name value` → the value, or the fallback when the flag is absent. */
export function flag(argv: string[], name: Valued, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

/** Whether `--name` is on the line, with or without a value after it. */
export function hasFlag(argv: string[], name: Valued | (typeof SWITCHES)[number]): boolean {
  return argv.includes(`--${name}`);
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
export function optionValue(argv: string[], name: Valued, wants: string): string | undefined {
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

/**
 * Refuses an option no command reads.
 *
 * No command refuses an option it does not read, so without this a guessed `--dry-run` runs
 * the command it was meant to preview. The check is against every command's options at
 * once: an option that only another command reads still passes.
 *
 * So a word starting with `-` is checked even right after an option that takes a value: an
 * option the command never reads would otherwise hide it, and `memory add local --args
 * --dry-run` would add the memory. `handsArgsOn` is the exception, for a command that hands
 * the value of `--args` to another program unread, as `mcp add --command <program> --args
 * --stdio` does.
 */
export function refuseUnknownOptions(argv: string[], handsArgsOn = false): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUED_OPTIONS.has(arg)) {
      if (!argv[i + 1]?.startsWith("-") || (arg === "--args" && handsArgsOn)) i++; // skip its value
    } else if (arg.startsWith("-") && !SWITCH_OPTIONS.has(arg)) {
      const [name] = arg.split("=", 1);
      throw new Error(
        VALUED_OPTIONS.has(name)
          ? `write ${name} ${arg.slice(name.length + 1)}, not ${arg}`
          : `unknown option: ${arg} (see \`sageox-agent help\`)`,
      );
    }
  }
}
