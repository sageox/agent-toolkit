import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Shared so seven suites stop each promisifying their own copy. */
export const run = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The checked-in entry point, so these tests exercise what an operator actually runs. */
export const CLI = join(repoRoot, "bin/sageox-agent");

export function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return run(CLI, args, { env: { ...process.env, ...env } });
}

/** `doctor` exits non-zero when it finds problems, so read the report off either path. */
export async function doctorReport(
  home: string,
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  try {
    const { stdout } = await runCli(["doctor", "demo"], { AGENT_TOOLKIT_HOME: home, ...env });
    return stdout;
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? "";
  }
}
