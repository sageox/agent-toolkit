import { confirm, isCancel, multiselect, password, select, text } from "@clack/prompts";
import type { Option } from "@clack/prompts";

/**
 * Whether there is a human on the other end.
 *
 * Every prompt is guarded by this. Under launchd, cron, or CI there is no terminal, and
 * a prompt there would block the process forever on a read that never completes — a
 * service that hangs at startup is worse than one that exits with a clear error.
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Ctrl-C at a prompt. A type rather than a message the retry loops string-match, or a
 * reword turns "the user left" into a loop that re-asks forever.
 */
export class SetupCancelled extends Error {
  constructor() {
    super("Setup cancelled.");
    this.name = "SetupCancelled";
  }
}

function completed<T>(result: T | symbol): T {
  if (!isCancel(result)) return result as T;
  throw new SetupCancelled();
}

export async function promptLine(question: string): Promise<string> {
  return completed(await text({ message: question.trim() })).trim();
}

type SelectValue = string | number | boolean;

export type SelectOption<T extends SelectValue> = Option<T>;

export async function promptSelect<T extends SelectValue>(
  question: string,
  options: SelectOption<T>[],
  initialValue?: T,
): Promise<T> {
  return completed(await select({ message: question, options, initialValue }));
}

export async function promptConfirm(question: string, initialValue = true): Promise<boolean> {
  return completed(await confirm({ message: question, initialValue }));
}

export async function promptMultiSelect<T extends SelectValue>(
  question: string,
  options: SelectOption<T>[],
): Promise<T[]> {
  return completed(await multiselect({ message: question, options, required: false }));
}

/** Reads a secret using Clack's masked password prompt. */
export async function promptSecret(question: string): Promise<string> {
  return completed(await password({ message: question.trim() })).trim();
}
