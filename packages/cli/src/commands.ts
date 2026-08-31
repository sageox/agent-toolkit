import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  generateKeypair,
  npubFor,
  publishDirectory,
  toHexPubkey,
} from "@sageox/agent-toolkit-adapter-buzz";
import {
  upsertEnv,
  writeIfAbsent,
  AGENT_YAML,
  SETTINGS_JSON,
  AGENTS_MD,
  PROFILE_JSON,
  AVATAR_MD,
  AVATAR_SVG,
  DEFAULT_AVATAR_VISUAL,
  DEFAULT_AGENT_INPUTS,
  DEFAULT_AGENT_SUCCESS,
  DEFAULT_AGENT_BOUNDARY,
  DEFAULT_AGENT_VOICE,
  DEFAULT_AVATAR_METAPHOR,
  DEFAULT_AVATAR_PALETTE,
  DEFAULT_AVATAR_BACKGROUND,
  DEFAULT_AVATAR_EXPRESSION,
  DEFAULT_AVATAR_JOKE,
  type AgentDesign,
} from "./init.ts";
import {
  addBuzzSurface,
  addOwnerId,
  addSlackSurface,
  allowTools,
  ensureSettingsFile,
  hasSurface,
  readAuthorGate,
  setBrainModel,
  setBrainProvider,
  setRespondTo,
} from "./edit-config.ts";
import {
  publishSlackProfile,
  WebSlackApi,
  WebSlackProfileApi,
} from "@sageox/agent-toolkit-adapter-slack";
import {
  ANTHROPIC_KEY_SPEC,
  requireCredential,
  readEnvFileValue,
  readEnvValue,
  slackAppTokenSpec,
  slackBotTokenSpec,
} from "./credentials.ts";
import { flag, optionValue, positional } from "./args.ts";
import {
  isInteractive,
  promptConfirm,
  promptLine,
  promptMultiSelect,
  promptSecret,
  promptSelect,
  SetupCancelled,
} from "./prompt.ts";
import {
  addBotToChannel,
  directoryFor,
  listChannels,
  channelBotCommand,
  isRelayMembershipError,
  relayMembershipHandoff,
  prepareAvatarForUpload,
  registerAgent,
  sameRelay,
  toHttpBase,
  type BuzzChannel,
  type BuzzSurfaceChannels,
} from "./register.ts";
import { agentDir, agentPaths, ensureAgentDir, listAgents, selectedPaths } from "./home.ts";
import { serverNameFor } from "./brains.ts";
import {
  SURFACE_EGRESS_TOOL,
  Vault,
  errorText,
  loadManifest,
  resolveSecret,
  type ChannelDecl,
} from "@sageox/agent-toolkit-core";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AVATAR_MODEL, generateAvatarCandidates } from "./avatar.ts";

const out = (s: string) => process.stdout.write(s);
const CREATE_VALUE_FLAGS = new Set([
  "--name", "--display-name", "--about", "--inputs", "--success", "--boundary", "--voice",
  "--metaphor", "--visual", "--palette", "--expression", "--joke", "--avatar-candidates",
]);

/** Guided-only recovery: report the real failure, then let the human retry or skip. */
export async function retryGuidedStep(
  question: string,
  action: () => Promise<void>,
): Promise<boolean> {
  for (;;) {
    try {
      await action();
      return true;
    } catch (error) {
      if (error instanceof SetupCancelled) throw error;
      out(`\n  ${errorText(error)}\n`);
      if (!await promptConfirm(question)) return false;
    }
  }
}

/**
 * Where a guided `create` had got to, so a second one can pick it up.
 *
 * `retryGuidedStep` recovers from a step that *fails*; this recovers from a `create` that
 * never returns at all — a closed terminal, a killed process — which no in-process handler
 * can catch. The two compose: a failed step is offered again in the same sitting, and what
 * the sitting completed survives losing the sitting.
 */
export type CreateStage =
  | "avatar"
  | "brain"
  | "surfaces"
  | "memory"
  | "mcp"
  | "repos"
  | "preflight";

export interface CreateProgress {
  version: 1;
  stage: CreateStage;
  avatar?: "generate" | "starter";
  brain?: "mock" | "claude";
  surfaces?: Array<"buzz" | "slack">;
  configuredSurfaces?: Array<"buzz" | "slack">;
  registerSurfaces?: Partial<Record<"buzz" | "slack", boolean>>;
  completedSurfaces?: Array<"buzz" | "slack">;
  buzzIdentity?: "create" | "attach";
  memories?: Array<"local" | "shared" | "team" | "private">;
  completedMemories?: Array<"local" | "shared" | "team" | "private">;
}

export function loadCreateProgress(name: string): CreateProgress | undefined {
  const path = agentPaths(name).creation;
  if (!existsSync(path)) return undefined;
  const progress = JSON.parse(readFileSync(path, "utf8")) as CreateProgress;
  if (progress.version !== 1 || !progress.stage) {
    throw new Error(`${path} is not a supported creation checkpoint`);
  }
  return progress;
}

export function saveCreateProgress(name: string, progress: CreateProgress): void {
  const path = agentPaths(name).creation;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(progress, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Removes the checkpoint, reporting whether there was one to remove. */
function finishCreateProgress(name: string): boolean {
  const path = agentPaths(name).creation;
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

function designFrom(argv: string[]): AgentDesign {
  return {
    inputs: flag(argv, "inputs") ?? DEFAULT_AGENT_INPUTS,
    success: flag(argv, "success") ?? DEFAULT_AGENT_SUCCESS,
    boundary: flag(argv, "boundary") ?? DEFAULT_AGENT_BOUNDARY,
    voice: flag(argv, "voice") ?? DEFAULT_AGENT_VOICE,
    metaphor: flag(argv, "metaphor") ?? DEFAULT_AVATAR_METAPHOR,
    palette: flag(argv, "palette") ?? DEFAULT_AVATAR_PALETTE,
    // No `--background` flag (yet): this is a hand-edited convention today, matching how
    // an operator fills in the actual hex after scaffolding. See design-system.md.
    background: DEFAULT_AVATAR_BACKGROUND,
    expression: flag(argv, "expression") ?? DEFAULT_AVATAR_EXPRESSION,
    joke: flag(argv, "joke") ?? DEFAULT_AVATAR_JOKE,
  };
}

/**
 * Step 1 — a working agent. No credentials, because a console agent needs none.
 *
 * `design` is a parameter so guided `create`, which collects the same answers through
 * prompts, hands over the object it already built instead of serializing eight fields
 * back into argv for this to parse again.
 */
export function initCmd(
  argv: string[],
  printNextSteps = true,
  design: AgentDesign = designFrom(argv),
): void {
  const name = flag(argv, "name") ?? positional(argv, CREATE_VALUE_FLAGS) ?? "my-agent";
  const displayName = flag(argv, "display-name") ?? name;
  const about = flag(argv, "about") ?? `${displayName}, a member of this team's chat.`;
  const visual = flag(argv, "visual") ?? DEFAULT_AVATAR_VISUAL;
  assertPortableProfile(displayName, about);
  const dir = ensureAgentDir(name);
  const paths = agentPaths(name);
  out(`  agent home  ${dir}\n`);

  const scaffold: Array<[path: string, file: string, contents: string, note: string]> = [
    [paths.config, "agent.yaml", AGENT_YAML(name), ""],
    [paths.tools, "settings.json", SETTINGS_JSON, ""],
    [paths.persona, "AGENTS.md", AGENTS_MD(displayName, about, design), "its persona — edit this"],
    [paths.profile, "profile.json", PROFILE_JSON(displayName, about), "its public profile"],
    [
      paths.avatarBrief,
      "avatar.md",
      AVATAR_MD(displayName, about, visual, design),
      "its character brief — edit this",
    ],
    [paths.avatar, "avatar.svg", AVATAR_SVG(displayName), "its starter badge"],
  ];
  for (const [path, file, contents, note] of scaffold) {
    const written = writeIfAbsent(path, contents) === "written";
    const suffix = written ? note : "already existed";
    const verb = (written ? "created" : "kept").padEnd(7);
    out(`  ${verb}  ${suffix ? `${file.padEnd(17)}(${suffix})` : file}\n`);
  }

  if (!printNextSteps) return;

  out(`
Your agent runs right now, from anywhere:

  sageox-agent run ${name}

Running that console agent uses no account, key, or model spend.
When you want more, each step is separate and optional:

  sageox-agent brain claude      use the real Claude brain   (needs ANTHROPIC_API_KEY)
  sageox-agent identity create   create a new Nostr identity (only for the Buzz surface)
  sageox-agent identity attach   attach an existing identity (private key input is hidden)
  sageox-agent identity register  publish profile.json       (Buzz or Slack)
  sageox-agent surface buzz      add the Buzz surface        (needs a relay URL)
  sageox-agent surface slack     add Slack via Socket Mode   (needs xoxb + xapp tokens)
`);
}

function agentNameFromDisplayName(displayName: string): string {
  return displayName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "my-agent";
}

function nextAvailableAgentName(base: string): string {
  let suffix = 2;
  while (existsSync(agentDir(`${base}-${suffix}`))) suffix++;
  return `${base}-${suffix}`;
}

/** Guided creation asks for public identity once, then derives its internal name and files. */
export async function createCmd(
  argv: string[],
  finishSetup?: (
    name: string,
  ) => Promise<string | { checkCommand: string } | undefined>,
): Promise<string> {
  if (argv.includes("--generate-avatar") && argv.includes("--starter-avatar")) {
    throw new Error("choose either --generate-avatar or --starter-avatar, not both");
  }
  if (flag(argv, "avatar-candidates") && !argv.includes("--generate-avatar")) {
    throw new Error("--avatar-candidates requires --generate-avatar");
  }
  const interactive = isInteractive() && !argv.includes("--non-interactive");
  // Choosing either avatar path is how the existing scripted create flow opts out of
  // questions. With neither choice, a human gets the whole journey; --non-interactive is
  // the explicit escape hatch for scripts that want defaults while attached to a TTY.
  const guided =
    interactive &&
    !argv.includes("--generate-avatar") &&
    !argv.includes("--starter-avatar");

  let name = flag(argv, "name") ?? positional(argv, CREATE_VALUE_FLAGS);
  const explicitName = Boolean(name);
  let progress = guided && name ? loadCreateProgress(name) : undefined;

  // `create` with no arguments is the natural thing to try after a terminal or process
  // disappears. Resume the only unfinished journey without making the person remember
  // the derived internal name. With several unfinished agents, require a name rather
  // than guessing which one's configuration should be changed.
  if (guided && !name && !argv.some((arg) => CREATE_VALUE_FLAGS.has(arg))) {
    // This scan reads every agent's checkpoint, so one unreadable file must not be able to
    // refuse the command to all of them — including someone who only wanted a new agent.
    // Report it and move on; naming that agent still raises the real error.
    const unfinished = listAgents().filter((agent) => {
      try {
        return loadCreateProgress(agent);
      } catch (error) {
        out(`  skipped  ${agent} — ${errorText(error)}\n`);
        return false;
      }
    });
    if (unfinished.length === 1) {
      name = unfinished[0];
      progress = loadCreateProgress(name);
    } else if (unfinished.length > 1) {
      throw new Error(
        `unfinished agent setups: ${unfinished.join(", ")}\n` +
          `Resume one with \`sageox-agent create --name ${unfinished[0]}\`.`,
      );
    }
  }

  // A checkpoint is only ever loaded against a name, so one implies the other.
  if (progress) out(`  resuming  ${name}             (from ${progress.stage})\n`);

  let displayName = flag(argv, "display-name");
  if (!progress && !displayName && interactive) {
    displayName = await promptLine(`Public display name [${name ?? "My Agent"}]: `);
  }
  displayName ||= name ?? "My Agent";

  name ||= agentNameFromDisplayName(displayName);
  while (!progress && !explicitName && interactive && existsSync(agentDir(name))) {
    const available = nextAvailableAgentName(name);
    const answer = await promptLine(
      `An agent already uses the internal name "${name}". Choose another [${available}]: `,
    );
    name = agentNameFromDisplayName(answer || available);
  }
  // A derived name nobody typed must not land on an agent that already exists. Under a
  // service manager or in CI there is no one to ask, and continuing would generate over
  // that agent's avatar and repoint its profile — files it was never asked about.
  // `--name` is how automation says it means this agent.
  if (!progress && !explicitName && existsSync(agentDir(name))) {
    throw new Error(
      `an agent already uses the internal name "${name}" — pass ` +
        `\`--name ${nextAvailableAgentName(name)}\` to create another, or name it explicitly ` +
        `to work on the existing one`,
    );
  }

  const defaultAbout = `${displayName}, a member of this team's chat.`;
  let about = flag(argv, "about");
  if (!progress && !about && interactive) {
    about = await promptLine(`One-line purpose [${defaultAbout}]: `);
  }
  about ||= defaultAbout;

  let visual = flag(argv, "visual");
  if (!progress && !visual && interactive) {
    visual = await promptLine(`Signature prop or visual hook [let the model infer it]: `);
  }
  visual ||= DEFAULT_AVATAR_VISUAL;

  const design = designFrom(argv);
  // A resumed run already wrote every one of these into AGENTS.md and avatar.md.
  if (guided && !progress) {
    design.inputs =
      (await promptLine(`What should it pay attention to? [${design.inputs}]: `)) || design.inputs;
    design.success =
      (await promptLine(`What does a successful answer or run deliver? [${design.success}]: `)) ||
      design.success;
    design.boundary =
      (await promptLine(`What must it never do without approval? [${design.boundary}]: `)) ||
      design.boundary;
    design.voice =
      (await promptLine(`How should it sound in chat? [${design.voice}]: `)) || design.voice;
    design.metaphor =
      (await promptLine(`Visual role or character metaphor [${design.metaphor}]: `)) ||
      design.metaphor;
    design.palette =
      (await promptLine(`Wardrobe and palette intent [${design.palette}]: `)) || design.palette;
    design.expression =
      (await promptLine(`Expression and posture [${design.expression}]: `)) ||
      design.expression;
    design.joke =
      (await promptLine(`One role-specific visual joke [${design.joke}]: `)) || design.joke;
  }

  if (!progress) {
    initCmd(
      ["--name", name, "--display-name", displayName, "--about", about, "--visual", visual],
      false,
      design,
    );
    if (guided) {
      progress = { version: 1, stage: "avatar" };
      saveCreateProgress(name, progress);
    }
  }

  // Guided creation always asks for three, so one question serves both the first ask and
  // the retry after a failure.
  const avatarQuestion =
    `Generate three ${AVATAR_MODEL} candidates and choose one now? (uses three images)`;
  let shouldGenerate = argv.includes("--generate-avatar");
  const resumingGeneratedAvatar =
    progress?.stage === "avatar" &&
    progress.avatar === "generate" &&
    existsSync(agentPaths(name).generatedAvatar);
  if (progress?.stage === "avatar") {
    if (!progress.avatar) {
      shouldGenerate = await promptConfirm(avatarQuestion);
      progress.avatar = shouldGenerate ? "generate" : "starter";
      saveCreateProgress(name, progress);
    } else {
      shouldGenerate = progress.avatar === "generate";
    }
  }

  if (resumingGeneratedAvatar) {
    setProfileAvatar(agentPaths(name).profile, "avatar.png");
    out("  kept     avatar.png       (generation already completed)\n");
  } else if (shouldGenerate) {
    // The scaffold above kept every file that already existed and said so. The generated
    // image is held to the same rule: replacing it would discard artwork someone chose and
    // paid for, and repoint the profile that names it — in a command that just reported
    // keeping that profile. Asked for by name, before the key prompt and the paid call.
    const generated = agentPaths(name).generatedAvatar;
    if (existsSync(generated) && !argv.includes("--replace-avatar")) {
      throw new Error(
        `${generated} already exists — pass --replace-avatar to generate over it`,
      );
    }

    let apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey && interactive) {
      apiKey = await promptSecret("OpenAI API key (input hidden; Enter to keep the starter SVG): ");
    }
    if (!apiKey) {
      if (!interactive) {
        throw new Error("--generate-avatar needs OPENAI_API_KEY");
      }
      out("  kept     avatar.svg       (no image API key; generate it later)\n");
    } else {
      const paths = agentPaths(name);
      // Validate before the paid call: a broken identity bundle must not consume images.
      assertIdentityBundle(paths);
      const requested = guided ? 3 : Number(flag(argv, "avatar-candidates") ?? "1");
      if (!Number.isInteger(requested) || requested < 1 || requested > 4) {
        throw new Error("--avatar-candidates must be an integer from 1 to 4");
      }
      if (requested > 1 && !interactive) {
        throw new Error("multiple avatar candidates need an interactive terminal for selection");
      }
      while (true) {
        try {
          out(
            `\n  generating ${requested} avatar candidate${requested === 1 ? "" : "s"} ` +
              `with ${AVATAR_MODEL} …\n`,
          );
          const candidates = await generateAvatarCandidates(
            readFileSync(paths.avatarBrief, "utf8"),
            apiKey,
            requested,
          );
          const avatar = candidates.length === 1
            ? candidates[0]
            : await chooseAvatarCandidate(name, candidates);
          if (avatar) {
            writeFileSync(paths.generatedAvatar, avatar);
            setProfileAvatar(paths.profile, "avatar.png");
            out("  created  avatar.png       (profile.json now publishes this image)\n");
          } else {
            out("  kept     current artwork  (no generated candidate selected)\n");
          }
          out("  OpenAI API key was used only for this request and was not saved.\n");
          break;
        } catch (error) {
          // Declining the selection prompt is an answer, not a failure to retry past.
          if (!guided || error instanceof SetupCancelled) throw error;
          out(`\n  ${errorText(error)}\n`);
          if (!await promptConfirm(avatarQuestion)) {
            out("  kept     avatar.svg       (generate a custom avatar later)\n");
            break;
          }
          // The same brief gets the same answer, and a safety refusal is a refusal of what
          // the brief says. Ask for the one part a human wrote rather than re-sending it.
          const retry = await promptLine(
            "Signature prop or visual hook (blank keeps avatar.md as it is): ",
          );
          if (retry) {
            writeFileSync(paths.avatarBrief, AVATAR_MD(displayName, about, retry, design));
            out("  updated  avatar.md        (its character brief)\n");
          }
        }
      }
    }
  }

  let runCommand = `sageox-agent run --agent ${name}`;
  let preflightComplete = false;
  let checkCommand = `sageox-agent doctor --agent ${name}`;
  try {
    // A checkpoint exists for exactly the guided runs: it is written beside the scaffold above.
    if (progress) {
      if (progress.stage === "avatar") {
        progress.stage = "brain";
        saveCreateProgress(name, progress);
      }
      await finishCreateSetup(name, progress);
      const result = await finishSetup?.(name);
      if (typeof result === "string") {
        runCommand = result;
        preflightComplete = true;
      } else if (result) {
        checkCommand = result.checkCommand;
      }
    }
    // Every question has been answered and written by this point, including when preflight
    // was deferred with a `checkCommand` — there is nothing left for a resume to ask. Also
    // on the scripted paths: a checkpoint left behind would send the next bare `create` into
    // this agent instead of the new one it was asked for. Said out loud there, because it
    // drops answers someone already gave.
    if (finishCreateProgress(name) && !progress) {
      out("  dropped  the resume checkpoint (guided setup starts over for this agent)\n");
    }
  } catch (error) {
    out(`\nSetup paused. Resume it with \`sageox-agent create --name ${name}\`.\n`);
    throw error;
  }

  const preflightIncomplete = guided && Boolean(finishSetup) && !preflightComplete;
  let status = guided ? "Setup complete" : "Agent created";
  let next = `  run it     sageox-agent run --agent ${name}\n` +
    `  check it   sageox-agent doctor --agent ${name}`;
  if (preflightComplete) {
    status = "Setup and preflight complete";
    next = `  run it     ${runCommand}`;
  } else if (preflightIncomplete) {
    status = "Setup saved; preflight incomplete";
    next = `  fix it     ${checkCommand}`;
  }
  out(`
${status}: ${name}

${next}

Add or change any capability later with \`sageox-agent brain\`, \`sageox-agent surface\`,
\`sageox-agent memory add\`, or \`sageox-agent mcp add\`.
`);
  return name;
}

async function chooseAvatarCandidate(
  name: string,
  candidates: Buffer[],
): Promise<Buffer | undefined> {
  const dir = mkdtempSync(join(tmpdir(), `sageox-agent-${name}-avatars-`));
  try {
    const options = candidates.map((candidate, index) => {
      const path = join(dir, `candidate-${index + 1}.png`);
      writeFileSync(path, candidate);
      out(`  candidate ${index + 1}  ${path}\n`);
      return { value: index + 1, label: `Candidate ${index + 1}`, hint: path };
    });
    out("\nOpen the candidates and inspect them at full size and as a 32px circle.\n");
    const selected = await promptSelect(
      "Which avatar should this agent use?",
      [
        ...options,
        { value: 0, label: "None", hint: "keep the current starter or selected artwork" },
      ],
      1,
    );
    return selected === 0 ? undefined : candidates[selected - 1];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The human path: broad choices first, then the existing capability-specific prompts. */
async function finishCreateSetup(name: string, progress: CreateProgress): Promise<void> {
  if (progress.stage === "brain") {
    for (;;) {
      if (!progress.brain) {
        progress.brain = await promptSelect("How should this agent think?", [
          { value: "mock" as const, label: "Mock brain", hint: "free and ready now" },
          { value: "claude" as const, label: "Claude", hint: "real responses; needs an API key" },
        ], "mock");
        saveCreateProgress(name, progress);
      }
      try {
        await brainCmd([progress.brain, "--agent", name]);
        break;
      } catch (error) {
        if (error instanceof SetupCancelled) throw error;
        out(`\n  ${errorText(error)}\n`);
        // The recorded answer is what failed — a brain whose key is not there. Forget it, so
        // the loop asks again instead of replaying the same choice against the same wall.
        progress.brain = undefined;
        saveCreateProgress(name, progress);
      }
    }
    progress.stage = "surfaces";
    saveCreateProgress(name, progress);
  }

  if (progress.stage !== "surfaces") return;
  if (!progress.surfaces) {
    out("\nThe local Console surface is always included.\n");
    progress.surfaces = await promptMultiSelect("Select any additional chat surfaces:", [
      { value: "buzz" as const, label: "Buzz", hint: "creates or attaches an identity; asks for relay and channels" },
      { value: "slack" as const, label: "Slack", hint: "asks for Socket Mode tokens and channel IDs" },
    ]);
    saveCreateProgress(name, progress);
  }

  const configured = new Set(progress.configuredSurfaces ?? []);
  const completed = new Set(progress.completedSurfaces ?? []);
  progress.registerSurfaces ??= {};
  // Declining a retry is an answer too: the surface is done being asked about, so record it
  // as such rather than offering it again on the next run.
  const finish = (surface: "buzz" | "slack") => {
    completed.add(surface);
    progress.completedSurfaces = [...completed];
    saveCreateProgress(name, progress);
  };
  // Ending the question is not the same as delivering the surface. Without this, a declined
  // retry leaves `create` announcing a finished agent that has no Buzz — say what is missing
  // and how to add it, so the gap is visible at the point it is created.
  const skipped = (surface: "buzz" | "slack", why: string) => {
    finish(surface);
    out(
      `\n  skipped  ${surface}  (${why})\n  add it later with ` +
        (surface === "buzz"
          ? "`sageox-agent identity attach` or `identity create`, then `surface buzz`\n"
          : "`sageox-agent surface slack`\n"),
    );
  };

  for (const surface of progress.surfaces) {
    if (completed.has(surface)) continue;

    if (!configured.has(surface)) {
      if (surface === "buzz") {
        if (!progress.buzzIdentity) {
          progress.buzzIdentity = await promptSelect("Which Buzz identity should this agent use?", [
            { value: "create" as const, label: "Create a new identity" },
            {
              value: "attach" as const,
              label: "Attach an existing identity",
              hint: "asks for its private key with hidden input",
            },
          ], "create");
          saveCreateProgress(name, progress);
        }
        const identityAction = progress.buzzIdentity;
        const identityReady = await retryGuidedStep(
          identityAction === "attach"
            ? "Try attaching the Buzz identity again?"
            : "Try creating the Buzz identity again?",
          () => identityCmd([identityAction, "--agent", name]),
        );
        if (!identityReady) {
          skipped(surface, "no identity, so no Buzz surface either");
          continue;
        }
      }
      // Resuming can land here with the surface already in agent.yaml, which `surface`
      // refuses — so ask the config, not the checkpoint, whether there is work to do.
      const added =
        hasSurface(readFileSync(agentPaths(name).config, "utf8"), surface) ||
        (await retryGuidedStep(
          surface === "buzz"
            ? "Try adding the Buzz surface again?"
            : "Try adding the Slack surface again?",
          () => surfaceCmd([surface, "--agent", name]),
        ));
      if (!added) {
        skipped(surface, "the surface was not added");
        continue;
      }
      configured.add(surface);
      progress.configuredSurfaces = [...configured];
      saveCreateProgress(name, progress);
    }

    const publishQuestion =
      surface === "buzz"
        ? "Publish its profile and join a Buzz channel now?"
        : "Publish its name and avatar to Slack now?";
    if (progress.registerSurfaces[surface] === undefined) {
      progress.registerSurfaces[surface] = await promptConfirm(publishQuestion);
      saveCreateProgress(name, progress);
    }
    if (progress.registerSurfaces[surface]) {
      await retryGuidedStep(
        publishQuestion,
        () => identityCmd(["register", surface, "--agent", name]),
      );
    }
    finish(surface);
  }

  progress.stage = "memory";
  saveCreateProgress(name, progress);
}

/** One scaffold should be publishable on both supported surfaces without later renaming. */
function assertPortableProfile(displayName: string, about: string): void {
  if (!displayName.trim()) throw new Error("public display name cannot be empty");
  if (displayName.length > 35) throw new Error("public display name may be at most 35 characters");
  if (about.length > 140) throw new Error("one-line purpose may be at most 140 characters");
}

function setProfileAvatar(path: string, avatar: string): void {
  const profile = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  profile.avatar = avatar;
  writeFileSync(path, JSON.stringify(profile, null, 2) + "\n");
}

/**
 * Refuses to spend an image or publish a profile whose editable identity files have
 * drifted apart. A profile-only legacy workflow remains valid; once either identity file
 * exists, the bundle is treated as declarative and must be complete.
 */
function assertIdentityBundle(
  paths: ReturnType<typeof agentPaths>,
  knownProfile?: ProfileFile,
): void {
  const profile = knownProfile ?? readProfile(paths.profile);
  if (!profile) throw new Error(`no profile.json at ${paths.profile}`);

  for (const [label, path] of [
    ["agent persona", paths.persona],
    ["avatar character brief", paths.avatarBrief],
  ] as const) {
    if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  }

  // A manifest written before `persona` existed simply has no key. That is an agent this
  // toolkit already scaffolded, not drift, and refusing to publish it would strand every
  // agent created before the key did. Pointing the key at some other file is drift.
  const manifest = loadManifest(readFileSync(paths.config, "utf8"));
  if (manifest.persona && resolve(paths.dir, manifest.persona) !== resolve(paths.persona)) {
    throw new Error(`agent.yaml must point persona at ${paths.persona}`);
  }

  const persona = readFileSync(paths.persona, "utf8");
  const brief = readFileSync(paths.avatarBrief, "utf8");
  if (!persona.includes(profile.display_name)) {
    throw new Error(`AGENTS.md does not identify the profile name "${profile.display_name}"`);
  }
  if (!brief.includes(profile.display_name)) {
    throw new Error(`avatar.md does not identify the profile name "${profile.display_name}"`);
  }
  // Only the sections every version of the brief template has written. `## Recognition
  // tests` is new here, and requiring it would reject briefs this toolkit itself produced.
  for (const section of [
    "## Role and visual metaphor",
    "## Silhouette and signature prop",
    "## The joke",
  ]) {
    if (!brief.includes(section)) throw new Error(`avatar.md needs a ${section} section`);
  }
  if (!profile.avatar) throw new Error(`profile ${paths.profile} needs an avatar`);
  const artwork = resolve(paths.dir, profile.avatar);
  if (!existsSync(artwork)) throw new Error(`profile avatar is missing: ${artwork}`);
}

function assertIdentityBundleIfPresent(
  paths: ReturnType<typeof agentPaths>,
  profile: ProfileFile | undefined,
): void {
  if (profile && (existsSync(paths.persona) || existsSync(paths.avatarBrief))) {
    assertIdentityBundle(paths, profile);
  }
}

function npubForExistingPrivateKey(secret: string, source = "the existing Buzz private key"): string {
  try {
    if (!secret.startsWith("nsec") && !/^[0-9a-f]{64}$/i.test(secret)) throw new Error();
    return npubFor(secret);
  } catch {
    throw new Error(`${source} is not a valid nsec or 64-character hex key`);
  }
}

/**
 * Step 2 (optional) — the identity a networked surface needs.
 *
 * Deliberately separate from `init`: a console agent has no use for a signing key, and
 * generating one it will never use is how a scaffold ends up full of credentials nobody
 * can account for.
 */
export async function identityCmd(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "register") return registerIdentity(argv);
  if (sub !== "create" && sub !== "attach" && sub !== "show") {
    throw new Error("usage: sageox-agent identity create | attach | show | register [buzz|slack]");
  }
  const paths = await selectedPaths(argv);

  if (sub === "show") {
    const existing = readEnvValue("BUZZ_NSEC", paths.env);
    if (!existing) throw new Error("no BUZZ_NSEC in .env — run `sageox-agent identity create`");
    out(`  npub  ${npubFor(existing)}\n`);
    return;
  }

  if (sub === "attach") {
    // An exported BUZZ_NSEC outranks the saved .env in every later command, so it — not the
    // file — is what the agent will sign with. Resolve it before anything else: a malformed
    // one is refused here rather than left for run to reject, and it decides whether the
    // rest of this command is even describing the effective identity. The `buzz` CLI's own
    // BUZZ_PRIVATE_KEY is deliberately not read — it usually holds the operator's personal
    // identity, and silently signing an agent's events with that is the mistake this
    // command exists to avoid.
    const ambient = process.env.BUZZ_NSEC?.trim();
    const ambientNpub = ambient ? npubForExistingPrivateKey(ambient, "BUZZ_NSEC") : undefined;

    const stored = readEnvFileValue("BUZZ_NSEC", paths.env);
    if (stored) {
      const storedNpub = npubFor(stored);
      // Reporting the saved key while a different one is exported would name an identity
      // this agent never signs as. Refusing is the only answer that stays true: which of
      // the two to keep is the operator's call, and both are still where they were.
      if (ambientNpub && ambientNpub !== storedNpub) {
        throw new Error(
          `an exported BUZZ_NSEC would shadow the identity already in ${paths.env} — ` +
            "unset it to keep the saved one, or clear that line to attach the exported one",
        );
      }
      out(`  an identity is already attached — keeping it\n  npub  ${storedNpub}\n`);
      return;
    }

    let secret = ambient;
    if (!secret) {
      if (!isInteractive()) {
        throw new Error(
          "BUZZ_NSEC is not set. Export the existing identity in this shell, " +
            `or run this command in a terminal to save it to ${paths.env}`,
        );
      }
      secret = (await promptSecret(
        "Paste the existing Buzz private key (nsec or 64-character hex; input hidden): ",
      )).trim();
      if (!secret) throw new Error("no private key given — no identity was attached");
    }

    const npub = ambientNpub ?? npubForExistingPrivateKey(secret);

    upsertEnv(paths.env, "BUZZ_NSEC", secret);
    out(`  attached  .env   (BUZZ_NSEC, mode 600)\n  npub      ${npub}\n`);
    return;
  }

  // This agent's own key, not whatever the shell is carrying. Asking about the ambient one
  // here would answer "an identity already exists" to someone who explicitly asked for a
  // new one, and leave the bundle with no key of its own.
  const existing = readEnvFileValue("BUZZ_NSEC", paths.env);
  if (existing) {
    out(`  an identity already exists — keeping it\n  npub  ${npubFor(existing)}\n`);
    return;
  }
  // Generating under an exported BUZZ_NSEC would write a key that same variable outranks in
  // every later command — a new identity the agent would never sign as.
  if (process.env.BUZZ_NSEC?.trim()) {
    throw new Error(
      "an exported BUZZ_NSEC would shadow a newly created identity — unset it to create " +
        "one, or run `sageox-agent identity attach` to keep using the exported key",
    );
  }

  const kp = generateKeypair();
  upsertEnv(paths.env, "BUZZ_NSEC", kp.nsec);
  out(`  created  .env   (BUZZ_NSEC, mode 600)

Register this public key with your relay. A channel owner or admin must then add it
to every channel it should read. Until both happen, the agent hears nothing.

  npub  ${kp.npub}
  hex   ${kp.hex}

The secret key stays in .env and never leaves this machine.
`);
}

/** Step 3 (optional) — attach a networked surface to the identity. */
export async function surfaceCmd(argv: string[]): Promise<void> {
  const kind = argv[0];
  if (kind !== "buzz" && kind !== "slack") {
    throw new Error(
      "usage: sageox-agent surface buzz --relay wss://… | surface slack --channels C123,G456",
    );
  }
  const paths = await selectedPaths(argv);

  if (!existsSync(paths.config)) throw new Error(`no agent.yaml — run \`sageox-agent init --name <name>\` first`);

  if (kind === "slack") {
    // Before the prompts, not after. `addSlackSurface` refuses a duplicate, but reaching
    // that refusal by way of two credential prompts writes tokens to .env and spends an
    // authenticated Slack call for a command that was never going to succeed.
    if (hasSurface(readFileSync(paths.config, "utf8"), "slack")) {
      throw new Error("config already has a slack surface — edit it by hand");
    }

    const channelsValue = optionValue(argv, "channels", CHANNEL_IDS) ??
      (isInteractive()
        ? await promptLine("Slack channel IDs (comma-separated, blank for DMs only): ")
        : undefined);
    const channels = splitIds(channelsValue);
    // Checked here rather than only against the written file: a typo should surface
    // before two hidden-input prompts, not at `sageox-agent run` as a schema error.
    const privateChannels = splitIds(optionValue(argv, "private-channels", CHANNEL_IDS));
    const unlisted = privateChannels.filter((id) => !channels.includes(id));
    if (unlisted.length) {
      throw new Error(`--private-channels must also appear in --channels: ${unlisted.join(", ")}`);
    }

    const botToken = await requireCredential(slackBotTokenSpec("SLACK_BOT_TOKEN"), {
      envPath: paths.env,
    });
    await requireCredential(slackAppTokenSpec("SLACK_APP_TOKEN"), { envPath: paths.env });

    // Ask Slack which of these are private rather than making the human assert it. The
    // answer decides whether the default guard lets the agent reply at all, and getting
    // it wrong is invisible until a mention is answered with silence.
    const { confirmedPrivate, publicChannels, unknown } = await classifyChannels(
      new WebSlackApi(botToken),
      channels,
    );
    const { privateChannels: settledPrivate, disputed } = reconcilePrivateChannels(privateChannels, {
      confirmedPrivate,
      publicChannels,
    });
    if (disputed.length) {
      out(
        `  note: --private-channels named ${disputed.join(", ")}, but Slack reports\n` +
          `        ${disputed.length > 1 ? "them" : "it"} public. Dropped the assertion — Slack is the authority on\n` +
          `        its own channels, and keeping it would silently bypass the guard.\n`,
      );
    }

    if (unknown.length) {
      out(
        `  note: could not classify ${unknown.join(", ")} — the bot may not be in the\n` +
          `        channel, or the app lacks channels:read / groups:read. The adapter\n` +
          `        asks again at startup; until it gets an answer these count as public.\n`,
      );
    }
    if (confirmedPrivate.length) {
      out(`  private per Slack: ${confirmedPrivate.join(", ")} — the guard allows replies there\n`);
    }

    // Every edit is composed in memory and written once. Writing the surface before the
    // questions below would mean a Ctrl-C at a prompt leaves a config that `surface
    // slack` then refuses as a duplicate — hand-editing, which is what this is here to
    // spare. addSlackSurface also raises that duplicate now, before anything is asked.
    const listed = await settleChannelReplies(
      channels.map((id) => ({ id, reply: settledPrivate.includes(id) ? "private" : "public" })),
      unknown,
      argv,
    );
    let config = addSlackSurface(readFileSync(paths.config, "utf8"), listed);
    config = await settleAuthorGate(config, argv, SLACK_AUTHOR_GATE);
    writeSurfaceConfig(paths, config);

    out(`  added a slack surface to ${paths.config}

Slack app checklist:
  Socket Mode       enabled; app token has connections:write
  Bot events        app_mention, message.im
  Bot scopes        app_mentions:read, chat:write, reactions:write, plus channels:history
                    / groups:history / im:history / mpim:history and matching :read scopes
  Membership        invite the bot to every configured channel

DMs need no channel ID — the message.im subscription is what opens that path, and inside
a DM the agent answers without being tagged.

  sageox-agent doctor
`);
    return;
  }

  if (!readEnvValue("BUZZ_NSEC", paths.env))
    throw new Error("no identity yet — run `sageox-agent identity create` first");

  let relayUrl = flag(argv, "relay");
  if (!relayUrl && isInteractive()) {
    relayUrl = await promptLine("Relay URL (wss://…): ");
  }
  if (!relayUrl) throw new Error("a relay URL is required: --relay wss://your-relay.example");
  if (!/^wss?:\/\//.test(relayUrl))
    throw new Error(`"${relayUrl}" is not a relay URL — it should start with wss://`);

  // A channel id is a uuid, so asking a human to type one is asking for the typo that
  // makes an agent look configured and hear nothing. The relay can list them, so offer
  // the list — and remember the names, which is what a person says out loud later.
  // Either flag opts out of the menu entirely: offering one and then ignoring what was
  // typed on the command line would be worse than never offering it.
  const offered =
    argv.includes("--channels") || argv.includes("--private-channels")
      ? []
      : await offerRelayChannels(relayUrl, paths.env);
  const picked = offered.length ? await pickChannels(offered) : undefined;

  // Unlike Slack, a relay has no endpoint that reports whether a channel is private, so
  // the operator's assertion is the only evidence there is. Asked for explicitly rather
  // than defaulted either way: assuming private would bypass the guard on their behalf,
  // and assuming public makes the agent deaf in the channels they just named.
  const channels =
    picked?.channels ??
    splitIds(
      optionValue(argv, "channels", CHANNEL_IDS) ??
        (isInteractive()
          ? await promptLine(
              "Buzz channel IDs to listen and reply in — the ids `identity register` lists,\n" +
                "not the display names (comma-separated, blank for mentions only): ",
            )
          : undefined),
    );
  const privateChannels =
    picked?.privateChannels ??
    splitIds(
      optionValue(argv, "private-channels", CHANNEL_IDS) ??
        (channels.length && isInteractive()
          ? await promptLine("  Which of those are private? (comma-separated, blank for none): ")
          : undefined),
    );
  const channelNames = picked?.names ?? {};
  const unlisted = privateChannels.filter((id) => !channels.includes(id));
  if (unlisted.length) {
    throw new Error(`--private-channels must also appear in --channels: ${unlisted.join(", ")}`);
  }

  // Every public channel is passed as unconfirmed rather than public. Slack can
  // distinguish the two because it has an endpoint to ask; a relay does not, so "public"
  // here would only ever mean "you did not say otherwise" — and a consent prompt is the
  // last place to state something firmer than what is known.
  const listed = await settleChannelReplies(
    channels.map((id) => ({
      id,
      ...(channelNames[id] ? { name: channelNames[id] } : {}),
      reply: privateChannels.includes(id) ? "private" : "public",
    })),
    channels.filter((id) => !privateChannels.includes(id)),
    argv,
  );

  // Composed in memory and written once, so a Ctrl-C at the consent prompt leaves no
  // half-configured surface that `surface buzz` would then refuse as a duplicate.
  let config = addBuzzSurface(readFileSync(paths.config, "utf8"), relayUrl, listed);
  config = await settleAuthorGate(config, argv, BUZZ_AUTHOR_GATE);
  writeSurfaceConfig(paths, config);

  const open = listed.filter((channel) => channel.reply === "public").map((c) => c.id);
  const listening = listed.length
    ? `  listening in ${listed.map((c) => c.id).join(", ")}` +
      (open.length ? ` — answering publicly in ${open.join(", ")}` : " — all private")
    : "  no channels named — it will hear mentions and answer none of them, because a\n" +
      "  channel no entry lists counts as public. Add the channels it should answer in\n" +
      "  before running it; `sageox-agent doctor` reports this until you do";

  // Only worth saying while it is still true: `settleAuthorGate` may just have narrowed
  // the gate, and telling someone to fix what they were walked through reads as a bug.
  const stillOpen =
    readAuthorGate(config).respondTo === "anyone"
      ? `\nOne thing to check before running:\n\n` +
        `  respondTo   is still \`anyone\`, which was fine for a local console but not for a\n` +
        `              relay. Set it to owner-only (and set \`owner\`) or allowlist.\n`
      : "";

  out(`  added a buzz surface to ${paths.config}
${listening}
${stillOpen}
  sageox-agent doctor
`);
}

function splitIds(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
}

/**
 * The relay's channels, or nothing at all.
 *
 * Best-effort on purpose. Listing shells out to the `buzz` CLI, which is a hard
 * requirement of `identity register` but has never been one of `surface buzz` — so a
 * missing client, an unreachable relay, or a relay with no channels falls back to typing
 * ids by hand rather than turning a working command into a broken one.
 *
 * The exception is a membership refusal, which is offered the grant and the wait. This is
 * where a guided `create` meets a gated relay *first*, one step before registration, and
 * the fallback it would otherwise take is asking someone to type ids the relay has just
 * refused to show them. Declining the wait still falls back, so nothing is turned into a
 * hard failure.
 */
async function offerRelayChannels(relayUrl: string, envPath: string): Promise<BuzzChannel[]> {
  const nsec = readEnvValue("BUZZ_NSEC", envPath);
  if (!nsec || !isInteractive()) return [];
  try {
    const channels = await withRelayMembership({ relayUrl, nsec }, () =>
      listChannels(relayUrl, nsec),
    );
    return channels ?? [];
  } catch {
    return [];
  }
}

/**
 * Both channel questions, off one menu.
 *
 * The privacy question is asked by number over the channels just picked, rather than by
 * id: showing someone a numbered list and then asking them to type uuids back is how a
 * channel they chose becomes one the guard has never heard of.
 */
async function pickChannels(offered: BuzzChannel[]): Promise<{
  channels: string[];
  privateChannels: string[];
  names: Record<string, string>;
}> {
  out("\n  channels on this relay:\n");
  offered.forEach((c, i) => out(`   ${String(i + 1).padStart(2)}. ${c.name}  (${c.channel_id})\n`));
  const chosen = channelsByNumber(
    offered,
    splitIds(
      await promptLine("\nWhich should the agent listen and reply in? (numbers, blank for none): "),
    ),
  );
  if (!chosen.length) return { channels: [], privateChannels: [], names: {} };

  out(
    "\n  Which of those are private? A relay cannot tell us, and anything left out is\n" +
      "  treated as public — which you will be asked to consent to, one channel at a time.\n",
  );
  chosen.forEach((c, i) => out(`   ${String(i + 1).padStart(2)}. ${c.name}\n`));
  const priv = channelsByNumber(
    chosen,
    splitIds(await promptLine("\n  Numbers, blank for none: ")),
  );

  return {
    channels: chosen.map((c) => c.channel_id),
    privateChannels: priv.map((c) => c.channel_id),
    names: Object.fromEntries(chosen.map((c) => [c.channel_id, c.name])),
  };
}

/**
 * The channels behind a list of menu numbers.
 *
 * Refuses the whole selection when any number is out of range rather than dropping it:
 * silently configuring three of the four channels someone asked for is the kind of
 * mistake they would only find by noticing an agent ignoring one of them.
 */
export function channelsByNumber(offered: BuzzChannel[], picked: string[]): BuzzChannel[] {
  const bad = picked.filter((n) => !/^\d+$/.test(n) || !offered[Number(n) - 1]);
  if (bad.length) throw new Error(`no channel numbered ${bad.join(", ")}`);
  const chosen = new Map(picked.map((n) => [offered[Number(n) - 1].channel_id, offered[Number(n) - 1]]));
  return [...chosen.values()];
}


const CHANNEL_IDS = "a comma-separated list of channel ids";

export const MODEL_ID = "a model id, e.g. claude-opus-5";

/** Slack member ids: `U…` for a person, `W…` on Enterprise Grid. Never an npub. */
const SLACK_MEMBER_ID = /^[UW][A-Z0-9]{2,}$/;

/**
 * Sorts configured channels into what the guard will do with them.
 *
 * `unknown` is its own bucket rather than being folded into public: "Slack says this is
 * public" and "we could not ask" call for different words to a human, even though both
 * fail closed.
 */
export async function classifyChannels(
  api: { channelIsPrivate(channel: string): Promise<boolean | undefined> },
  channels: string[],
): Promise<{ confirmedPrivate: string[]; publicChannels: string[]; unknown: string[] }> {
  const confirmedPrivate: string[] = [];
  const publicChannels: string[] = [];
  const unknown: string[] = [];

  for (const id of channels) {
    try {
      const isPrivate = await api.channelIsPrivate(id);
      if (isPrivate === true) confirmedPrivate.push(id);
      else if (isPrivate === false) publicChannels.push(id);
      else unknown.push(id);
    } catch {
      // A missing scope, a channel the bot was never invited to, and a typo all land
      // here, and none of them should lose the tokens already staged.
      unknown.push(id);
    }
  }
  return { confirmedPrivate, publicChannels, unknown };
}

/**
 * Reconciles what a human asserted about channel privacy against what Slack said.
 *
 * Slack wins, in both directions. A confirmed-private channel becomes a `reply: private`
 * entry; a channel asserted private that Slack calls public is **dropped**, because the
 * adapter seeds its private set from the entries and thereafter only ever adds to it
 * (`slack.ts`), so a stale assertion is never revoked at runtime. Normalization would then
 * report a public channel as private and the guard would never see a public destination to
 * refuse — consent declined at setup, egress allowed anyway.
 */
export function reconcilePrivateChannels(
  asserted: string[],
  slack: { confirmedPrivate: string[]; publicChannels: string[] },
): { privateChannels: string[]; disputed: string[] } {
  const disputed = asserted.filter((id) => slack.publicChannels.includes(id));
  const privateChannels = [
    ...asserted.filter((id) => !disputed.includes(id)),
    ...slack.confirmedPrivate.filter((id) => !asserted.includes(id)),
  ];
  return { privateChannels, disputed };
}

/**
 * Settles the one question a public channel raises, before the channel is written down.
 *
 * A `reply: public` entry is the consent the egress guard reads, so this is where it is
 * given: the agent will answer in front of everyone who can read that channel, including
 * what it read from its brains. Configuring a channel says where the agent should listen;
 * it does not say the guard standing between a vault read and a workspace-wide audience
 * should come down, and that rule is the chokepoint every other rule sits behind.
 *
 * Declined, the channel is left out of the list rather than listed and left mute. A
 * listed channel the agent may not answer in is advertised as mentionable, wakes it,
 * spends a turn, and says nothing — the failure this single list exists to prevent.
 */
export async function settleChannelReplies(
  candidates: readonly ChannelDecl[],
  unconfirmed: readonly string[],
  argv: string[],
): Promise<ChannelDecl[]> {
  const publicIds = candidates.filter((channel) => channel.reply === "public").map((c) => c.id);
  if (!publicIds.length) return [...candidates];

  // Worded off what the surface actually said. Calling an unclassified channel "public"
  // would be asserting the thing we just failed to establish.
  const confirmed = publicIds.filter((id) => !unconfirmed.includes(id));
  const subject = confirmed.length
    ? `${confirmed.join(", ")} ${confirmed.length > 1 ? "are" : "is"} public`
    : `${publicIds.join(", ")} could not be confirmed private`;

  const allow =
    argv.includes("--allow-public") ||
    (isInteractive() &&
      /^y(es)?$/i.test(
        await promptLine(
          `\n  ${subject} — the agent would answer there in front of everyone who can\n` +
            `  read it, including what it reads from its brains. Only ${publicIds.join(", ")}\n` +
            `  would be listed that way; every other public channel stays refused.\n\n` +
            `  Answer publicly in ${publicIds.length > 1 ? "these channels" : "this channel"}? [y/N] `,
        ),
      ));

  if (!allow) {
    // Not "re-run with --allow-public": the surface is written at the end of this command
    // and `surface <kind>` refuses a second one, so the way back is the file itself — one
    // line, in the one place that decides this.
    out(
      `  left ${publicIds.join(", ")} out of channels — the agent would hear mentions there\n` +
        `  and never answer. To change that, add ${publicIds.length > 1 ? "these entries" : "this entry"} under the surface's channels:\n` +
        publicIds.map((id) => `    - { id: ${id}, reply: public }\n`).join(""),
    );
    return candidates.filter((channel) => channel.reply !== "public");
  }

  out(`  listed ${publicIds.join(", ")} as reply: public — the agent may answer there\n`);
  return [...candidates];
}

/**
 * Settles who may address the agent on the surface being added.
 *
 * `owner` is per surface: the same person is an npub on Buzz and a `U…` on Slack, and an
 * id is only ever matched against the surface it arrived from. Asking here is what keeps
 * a second surface from being added that answers nobody.
 */
/**
 * What an author id looks like on one surface, and what to call it when asking.
 *
 * The gate itself is the same question everywhere — `owner-only` with no id for *this*
 * surface answers nobody — so the surfaces differ only in identifiers and wording. Held
 * as data for the same reason `CredentialSpec` is: the alternative is two copies of the
 * flow that drift the first time the question changes.
 */
interface AuthorGateSurface {
  label: string;
  /** Whether an existing `owner` entry belongs to this surface. */
  looksLikeId: (id: string) => boolean;
  /** What the id is called, its shape for the mismatch note, and one to show in usage. */
  idLabel: string;
  idShape: string;
  idExample: string;
  /** Where the human finds theirs. */
  where: string;
  /** Who `respondTo: anyone` would admit here. */
  audience: string;
}

export const SLACK_AUTHOR_GATE: AuthorGateSurface = {
  label: "Slack",
  looksLikeId: (id) => SLACK_MEMBER_ID.test(id),
  idLabel: "Slack member ID",
  idShape: "a Slack member ID (U… or W…)",
  idExample: "U…",
  where: "Slack profile → ⋮ → Copy member ID",
  audience: "every workspace member",
};

/**
 * `npub…` or the 64-char hex the manifest normalizes it to — never an `nsec`.
 *
 * Deliberately shape-only, like `SLACK_MEMBER_ID`. This answers "whose surface is this
 * id?", not "is it valid": a malformed npub is caught loudly by `normalizeActorId` at
 * load, and rejecting one here would only mean silently re-asking for an owner that is
 * already named.
 */
const NOSTR_ACTOR_ID = /^(npub1[a-z0-9]+|[0-9a-f]{64})$/i;

export const BUZZ_AUTHOR_GATE: AuthorGateSurface = {
  label: "Buzz",
  looksLikeId: (id) => NOSTR_ACTOR_ID.test(id),
  idLabel: "npub",
  idShape: "an npub or 64-character hex pubkey",
  idExample: "npub1…",
  where: "not the agent's — `identity show` prints that one",
  audience: "anyone who can reach the relay",
};

export async function settleAuthorGate(
  config: string,
  argv: string[],
  surface: AuthorGateSurface,
): Promise<string> {
  const gate = readAuthorGate(config);
  if (gate.respondTo !== "owner-only") return config;
  // An id of this surface's shape among them means it already has an owner.
  if (gate.owner.some(surface.looksLikeId)) return config;

  let id = optionValue(argv, "owner-id", `a member id, e.g. ${surface.idExample}`);
  if (!id && isInteractive()) {
    out(
      `\n  respondTo is \`owner-only\` and \`owner\` names no ${surface.label} id, so the agent\n` +
        `  would answer nobody on ${surface.label}.\n\n` +
        `    1) just me — I will paste my ${surface.idLabel}\n` +
        `    2) ${surface.audience}\n\n`,
    );
    if ((await promptLine("  Choice [1]: ")) === "2") {
      out(
        `  set respondTo: anyone — ${surface.audience} may address the agent and\n` +
          `  spend your model key. Rate limits under \`limits:\` are what rations that,\n` +
          `  and \`doctor\` will keep warning until you narrow it.\n`,
      );
      return setRespondTo(config, "anyone").yaml;
    }
    id = await promptLine(`  Your ${surface.idLabel} (${surface.where}): `);
  }

  if (!id) {
    out(
      `  note: \`owner\` names no ${surface.label} id — the agent will answer nobody there.\n` +
        `        Re-run with --owner-id ${surface.idExample} , or set \`respondTo\` by hand.\n`,
    );
    return config;
  }
  if (!surface.looksLikeId(id)) {
    out(`  note: "${id}" does not look like ${surface.idShape}, saving it anyway\n`);
  }

  out(`  added ${id} to \`owner\` — it answers you on ${surface.label}\n`);
  return addOwnerId(config, id).yaml;
}

/**
 * Saves a surface addition and applies defaults that only make sense with several
 * networked surfaces. This is data-driven setup policy, not a feature-specific command:
 * the runtime still exposes each capability as an ordinary MCP server.
 */
function writeSurfaceConfig(paths: ReturnType<typeof agentPaths>, config: string): void {
  const manifest = loadManifest(config);
  const networkedKinds = new Set(
    manifest.surfaces.filter((surface) => surface.kind !== "console").map((surface) => surface.kind),
  );
  if (networkedKinds.size < 2) {
    writeFileSync(paths.config, config);
    return;
  }

  const ensured = ensureSettingsFile(paths.dir, config);
  // Parse and prepare both files before changing either: a settings.json that does not
  // parse must abort with agent.yaml untouched, or the rerun hits the duplicate-surface
  // refusal with the egress grant never written.
  const { json, added } = allowTools(readFileSync(ensured.settingsFile, "utf8"), [
    SURFACE_EGRESS_TOOL,
  ]);
  writeFileSync(paths.config, ensured.yaml);
  writeFileSync(ensured.settingsFile, json);
  if (added.length) {
    out(`  enabled ${SURFACE_EGRESS_TOOL} (default for multiple networked surfaces)\n`);
  }
}

/** Flips the brain between mock and the real thing, without hand-editing YAML. */
export async function brainCmd(argv: string[]): Promise<void> {
  const which = argv[0];
  if (which !== "claude" && which !== "mock") {
    throw new Error("usage: sageox-agent brain claude [--model <id>] | brain mock");
  }
  const model = optionValue(argv, "model", MODEL_ID);
  // Refused rather than written and ignored: the mock brain answers from a canned script
  // and runs no model at all, so a pin recorded here would read as one that is in force.
  if (model && which === "mock") {
    throw new Error("the mock brain runs no model — --model applies to `brain claude`");
  }
  const paths = await selectedPaths(argv);
  if (!existsSync(paths.config)) throw new Error(`no agent.yaml — run \`sageox-agent init --name <name>\` first`);

  const provider = which === "claude" ? "claude-acp" : "mock";
  const config = setBrainProvider(readFileSync(paths.config, "utf8"), provider);
  // Both edits prepared before either is written, so a rejected model does not leave the
  // provider switched behind it.
  //
  // Switching to `mock` clears the pin rather than leaving it dormant: the manifest
  // refuses that pairing at load, and a `model:` line surviving the round trip would come
  // back in force on the next `brain claude` as though it had been chosen again.
  let pinned = { yaml: config.yaml, changed: false };
  if (which === "mock") pinned = setBrainModel(config.yaml, undefined);
  else if (model) pinned = setBrainModel(config.yaml, model);
  if (which === "claude") {
    // Validate above, ask next, and write last: neither a bad config nor a missing key
    // should leave behind half of a Claude setup.
    await requireCredential(ANTHROPIC_KEY_SPEC, { envPath: paths.env });
  }
  if (config.changed || pinned.changed) writeFileSync(paths.config, pinned.yaml);

  out(
    config.changed
      ? `  brain.provider is now ${provider}\n`
      : `  brain.provider is already ${provider}\n`,
  );
  if (model) {
    out(pinned.changed ? `  brain.model is now ${model}\n` : `  brain.model is already ${model}\n`);
  } else if (pinned.changed) {
    out("  brain.model removed — the mock brain runs no model\n");
  }

  if (which === "claude") {
    out("\n  sageox-agent run\n");
  }
}

/**
 * Registers the agent's profile on the relay.
 *
 * Profile publication is performed by the real `buzz` client and signed with the agent's
 * own key. Channel membership stays a separate human owner/admin action.
 */
async function registerIdentity(argv: string[]): Promise<void> {
  const surface = argv[1]?.startsWith("--") ? "buzz" : (argv[1] ?? "buzz");
  if (surface === "slack") return registerSlackIdentity(argv);
  if (surface !== "buzz") {
    throw new Error("usage: sageox-agent identity register [buzz|slack]");
  }

  const paths = await selectedPaths(argv);
  process.chdir(paths.dir);
  const nsec = readEnvValue("BUZZ_NSEC", paths.env);
  if (!nsec) throw new Error("no identity yet — run `sageox-agent identity create` first");

  const configuredRelay = relayFromConfig(paths.config);
  let relayUrl = flag(argv, "relay");
  if (!relayUrl && isInteractive()) {
    const answer = await promptLine(
      configuredRelay ? `Relay URL [${configuredRelay}]: ` : "Relay URL (wss://…): ",
    );
    relayUrl = answer || configuredRelay;
  }
  relayUrl ??= configuredRelay;
  if (!relayUrl) throw new Error("which relay? pass --relay wss://…");

  const profile = readProfile(paths.profile);
  assertIdentityBundleIfPresent(paths, profile);
  const name =
    flag(argv, "name") ??
    profile?.display_name ??
    (isInteractive() ? await promptLine("Agent name: ") : "");
  if (!name) throw new Error("what should it be called? pass --name <name>");

  let channel = flag(argv, "channel");
  if (!channel) {
    const channels = await withRelayMembership({ relayUrl, nsec }, () =>
      listChannels(relayUrl, nsec),
    );
    if (!channels) return;
    if (!isInteractive()) {
      throw new Error(
        `which channel? pass --channel <uuid>. Available:\n` +
          channels.map((c) => `  ${c.channel_id}  ${c.name}`).join("\n"),
      );
    }
    out("\n  channels on this relay:\n");
    channels.forEach((c, i) => out(`   ${String(i + 1).padStart(2)}. ${c.name}\n`));
    const pick = await promptLine("\nWhich channel should the agent answer in? (number): ");
    const chosen = channels[Number(pick) - 1];
    if (!chosen) throw new Error(`no channel numbered ${pick}`);
    channel = chosen.channel_id;
    out(`  chose ${chosen.name}\n`);
  }

  // Asked before anything is published, so a key that cannot work is refused while the
  // registration can still be abandoned cheaply.
  let channelOwnerNsec = argv.includes("--add-as-bot")
    ? await promptChannelOwnerKey(nsec)
    : undefined;

  const avatarSource = flag(argv, "avatar") ?? profile?.avatar;
  const prepared = avatarSource
    ? await prepareAvatarForUpload(resolve(paths.dir, avatarSource))
    : undefined;

  out(`\n  registering via the buzz CLI at ${toHttpBase(relayUrl)} …\n`);
  let registered: true | undefined;
  try {
    registered = await withRelayMembership({ relayUrl, nsec, channel }, async () => {
      await registerAgent({
        relayUrl,
        nsec,
        name,
        about: flag(argv, "about") ?? profile?.about,
        nip05: flag(argv, "nip05") ?? profile?.nip05,
        avatar: prepared?.path,
      });
      return true as const;
    });
  } finally {
    prepared?.cleanup();
  }
  if (!registered) return;

  // Offered rather than only printed: the fallback below is a command with a private key
  // pasted into it, and a hidden prompt is the same grant without one reaching a shell
  // history. Asked here, not with the flag above, because it is the first moment the grant
  // can actually land — the relay has just accepted this identity.
  if (!channelOwnerNsec && isInteractive()) {
    const now = await promptConfirm(
      `Add it to channel ${channel} now? Needs a channel owner or admin key, used once`,
      true,
    );
    if (now) channelOwnerNsec = await promptChannelOwnerKey(nsec);
  }

  // Outside `withRelayMembership`: this call is signed with the owner/admin key, so a
  // membership refusal here is about that key. Reporting the agent's npub as the one to
  // admit would send the operator after the wrong key.
  let addedToChannel = false;
  if (channelOwnerNsec) {
    try {
      await addBotToChannel({ relayUrl, agentNsec: nsec, channelOwnerNsec, channel });
      addedToChannel = true;
    } catch (error) {
      // Not thrown: the profile is already published, and the command printed below is
      // exactly what someone whose key was refused needs next.
      out(`\n  adding it to the channel failed: ${errorText(error)}\n`);
    }
  }

  const pubkey = toHexPubkey(npubFor(nsec));
  out(`  profile set to "${name}"${avatarSource ? " with its avatar" : ""}\n`);
  await publishAgentDirectory({ configPath: paths.config, relayUrl, nsec, name, channel });
  if (addedToChannel) {
    out(`  added to channel ${channel} as a bot
  channel owner/admin key was used once and not saved
`);
  } else {
    out(`

Human action required: from a terminal holding a channel owner or admin key, run:

  ${channelBotCommand(relayUrl, channel, pubkey)}

Or rerun this registration with --add-as-bot to enter the owner/admin key through a hidden,
one-time prompt. The bot key cannot grant its own channel role.
`);
  }
  out(`
After the channel membership succeeds, add the channel to privateChannels in
${paths.config} so the guard lets it reply there, then:

  sageox-agent doctor
  sageox-agent run
`);
}

/**
 * Publishes the directory record that makes the agent mentionable, alongside its profile.
 *
 * The channel being registered is unioned in because it is usually not in the manifest
 * yet — this command runs before the operator adds it to `privateChannels`, and a record
 * that omits the channel is the same as no record at all.
 *
 * A failure here warns rather than throws: the profile is already published, and an
 * exception would leave the operator with a half-registered agent and no obvious retry.
 */
async function publishAgentDirectory(opts: {
  configPath: string;
  relayUrl: string;
  nsec: string;
  name: string;
  channel: string;
}): Promise<void> {
  if (!existsSync(opts.configPath)) return;

  const manifest = loadManifest(readFileSync(opts.configPath, "utf8"));
  // The surface for the relay being registered, not merely the first Buzz one: a manifest
  // may declare several, and another's channels would tell this relay the agent answers
  // where it does not.
  const relayOf = (s: { kind: string }): string | undefined => {
    const url = (s as { relayUrl?: unknown }).relayUrl;
    return s.kind === "buzz" && typeof url === "string" ? url : undefined;
  };
  const surface = manifest.surfaces.find((s) => {
    const url = relayOf(s);
    return url !== undefined && sameRelay(url, opts.relayUrl);
  });

  if (!surface) {
    // Silence here would be the failure this whole record exists to prevent, reported as
    // success: the profile is already published, so registration looks like it worked.
    const configured = manifest.surfaces.map(relayOf).filter((url) => url !== undefined);
    out(`
  WARNING: no Buzz surface in ${opts.configPath} names ${opts.relayUrl}${
    configured.length ? `\n  (it configures ${configured.join(", ")})` : ""
  },
  so no directory record was published and clients will strip mentions of this agent.
  Configure the surface, then rerun this command:

    sageox-agent surface buzz --relay ${opts.relayUrl}
`);
    return;
  }

  const directory = directoryFor(manifest, surface as BuzzSurfaceChannels, opts.name);
  directory.channelIds = [...new Set([...directory.channelIds, opts.channel])];

  try {
    const { published, preserved } = await publishDirectory({
      relayUrl: opts.relayUrl,
      identityRef: "BUZZ_NSEC",
      // The key this command already read out of the bundle; the process environment that
      // `resolveSecret` would otherwise search does not carry it.
      env: { BUZZ_NSEC: opts.nsec },
      directory,
    });
    out(
      `  directory record ${published ? "published" : "already current"} — mentionable in ` +
        `${directory.channelIds.length} channel(s)` +
        (published && preserved.length ? `, kept ${preserved.join(", ")}` : "") +
        "\n",
    );
  } catch (error) {
    out(`
  WARNING: the profile published but the directory record did not:
  ${errorText(error)}

  Without it, clients strip mentions of this agent at send: the message posts, carries no
  mention tag, and the agent never wakes. Rerun once the relay is reachable:

    sageox-agent identity register buzz --relay ${opts.relayUrl}
`);
  }
}

function reportRelayMembershipRequired(relayUrl: string, nsec: string, channel?: string): void {
  out(`
  relay membership required
  ${relayUrl} did not register this identity because it is not a relay member.

${relayMembershipHandoff({ relayUrl, nsec, channel })}

The rest of setup can continue: configure the surface now, and \`sageox-agent doctor\`
will keep reporting the missing relay membership until it is granted. Or rerun
\`sageox-agent identity register buzz --relay ${relayUrl}\` once the grants land.
`);
}

/**
 * The channel owner/admin key, read once from a hidden prompt and never written down.
 *
 * The agent's own key cannot grant its channel role, so this is the one credential setup
 * asks for that is not the agent's. It is used for a single call and dropped with the
 * process.
 */
async function promptChannelOwnerKey(agentNsec: string): Promise<string> {
  if (!isInteractive()) {
    throw new Error("adding the bot to a channel needs an interactive terminal for the hidden owner-key prompt");
  }
  const key = await promptSecret("Channel owner/admin private key (used once; never saved): ");
  // Checked before deriving a pubkey: an npub pasted here — the likelier mix-up — is
  // read as hex by `npubFor` and fails deep in the curve code with nothing to act on.
  if (!key.startsWith("nsec")) {
    throw new Error("the channel owner/admin private key must be an nsec…");
  }
  if (npubFor(key) === npubFor(agentNsec)) {
    throw new Error("the channel owner/admin key must be different from the agent key");
  }
  return key;
}

/**
 * Runs a relay call, handing over the admin commands and retrying when a human says the
 * grant landed. `undefined` means still refused — the caller's cue to stop without
 * failing, because nothing else in setup needs the relay.
 *
 * The retry waits on a keypress, not a timer. What is being waited for is a person in
 * another terminal, so there is nothing to poll faster than they can be asked, and a poll
 * would have to invent a moment to give up at.
 *
 * The refusal is re-read from the relay rather than trusted from the answer: `listChannels`
 * and `registerAgent` are authenticated reads and writes, and a relay can accept the NIP-42
 * handshake from a key it will still not serve — so "the admin says it is done" is not
 * itself evidence that it is.
 *
 * Not `retryGuidedStep`: that offers a retry for *any* failure, and an unreachable relay or
 * a rejected profile is not something a human grant fixes.
 */
async function withRelayMembership<T>(
  opts: { relayUrl: string; nsec: string; channel?: string },
  attempt: () => Promise<T>,
): Promise<T | undefined> {
  let handedOff = false;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!isRelayMembershipError(error)) throw error;
      if (handedOff) out(`\n  ${opts.relayUrl} still does not admit this key.\n`);
      else reportRelayMembershipRequired(opts.relayUrl, opts.nsec, opts.channel);
      handedOff = true;
      if (!isInteractive()) return undefined;
      if (!(await promptConfirm("Has an admin granted relay membership? Check again", true))) {
        return undefined;
      }
    }
  }
}

/** Publishes the same profile through Slack without retaining the app configuration token. */
async function registerSlackIdentity(argv: string[]): Promise<void> {
  const paths = await selectedPaths(argv);
  const profile = readProfile(paths.profile);
  assertIdentityBundleIfPresent(paths, profile);
  const name = flag(argv, "name") ?? profile?.display_name;
  if (!name) throw new Error("what should it be called? add display_name to profile.json");

  let appId = flag(argv, "app-id");
  if (!appId && isInteractive()) appId = await promptLine("Slack app ID (A…): ");
  if (!appId) throw new Error("which Slack app? pass --app-id A…");

  let configToken = process.env.SLACK_CONFIG_TOKEN?.trim();
  if (!configToken && isInteractive()) {
    configToken = await promptSecret("Paste a Slack app configuration token (input hidden): ");
  }
  if (!configToken) {
    throw new Error(
      "Slack profile publication needs a one-time SLACK_CONFIG_TOKEN with app_configurations:write",
    );
  }

  const avatarSource = flag(argv, "avatar") ?? profile?.avatar;
  const prepared = avatarSource
    ? await prepareAvatarForUpload(resolve(paths.dir, avatarSource), 512)
    : undefined;
  try {
    await publishSlackProfile(
      {
        appId,
        name,
        about: flag(argv, "about") ?? profile?.about,
        avatar: prepared ? readFileSync(prepared.path) : undefined,
      },
      new WebSlackProfileApi(configToken),
    );
  } finally {
    prepared?.cleanup();
  }

  out(`  Slack app profile set to "${name}"${avatarSource ? " with its avatar" : ""}\n\n` +
    "The configuration token was used only for this request and was not saved.\n");
}

interface ProfileFile {
  display_name: string;
  about?: string;
  nip05?: string;
  avatar?: string;
}

/** Reads the declarative public profile while preserving the old flag-only workflow. */
function readProfile(path: string): ProfileFile | undefined {
  if (!existsSync(path)) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `profile ${path} is not valid JSON: ${errorText(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`profile ${path} must be a JSON object`);
  }
  const profile = value as Record<string, unknown>;
  if (typeof profile.display_name !== "string" || !profile.display_name.trim()) {
    throw new Error(`profile ${path} needs a non-empty display_name`);
  }
  for (const field of ["about", "nip05", "avatar"] as const) {
    if (profile[field] !== undefined && typeof profile[field] !== "string") {
      throw new Error(`profile ${path}: ${field} must be a string`);
    }
  }
  return {
    display_name: profile.display_name,
    about: profile.about as string | undefined,
    nip05: profile.nip05 as string | undefined,
    avatar: profile.avatar as string | undefined,
  };
}

/** The relay already configured on a buzz surface, so registration need not ask twice. */
function relayFromConfig(configPath: string): string | undefined {
  if (!existsSync(configPath)) return undefined;
  return readFileSync(configPath, "utf8").match(/relayUrl:\s*["']?(wss?:\/\/[^"'\s]+)/)?.[1];
}

/**
 * Reads the agent's brain from outside the agent.
 *
 * Memory you cannot inspect is memory you cannot trust: the point of a plaintext vault is
 * that a human can see what the agent believes and correct a wrong belief before it
 * compounds. This is that, without needing to know where the vault lives.
 */
export async function memoryCmd(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== "list" && sub !== "read" && sub !== "path") {
    throw new Error("usage: sageox-agent memory list | read [--query x] | path [--brain <name>]");
  }

  const paths = await selectedPaths(argv);
  if (!existsSync(paths.config)) throw new Error("no such agent — run `sageox-agent init` first");

  const manifest = loadManifest(readFileSync(paths.config, "utf8"));
  const vaults = manifest.brains
    .map((brain, index) => ({ brain, index }))
    .filter(
      (entry): entry is typeof entry & {
        brain: Extract<(typeof manifest.brains)[number], { preset: "local" | "shared" }>;
      } => entry.brain.preset === "local" || entry.brain.preset === "shared",
    )
    .map(({ brain, index }) => ({
      // The same function the wiring and the tool policy use, so `--brain <name>` can
      // never name a server that the agent does not actually run under that name.
      name: serverNameFor(brain, index)!,
      root: resolve(paths.dir, brain.path),
      age: brain.age,
    }));
  if (!vaults.length) {
    throw new Error("this agent has no inspectable local or shared brain — run `sageox-agent memory add local`");
  }

  const wanted = flag(argv, "brain");
  const selected = wanted ? vaults.filter((vault) => vault.name === wanted) : vaults;
  if (!selected.length) {
    throw new Error(
      `no vault brain named "${wanted}" — have: ${vaults.map((vault) => vault.name).join(", ")}`,
    );
  }

  if (sub === "path") {
    if (selected.length === 1) out(`${selected[0].root}\n`);
    else for (const vault of selected) out(`${vault.name}\t${vault.root}\n`);
    return;
  }

  for (const [index, selectedVault] of selected.entries()) {
    if (selected.length > 1) out(`${index ? "\n" : ""}# ${selectedVault.name}\n`);
    const identity = selectedVault.age
      ? (resolveSecret(selectedVault.age.identitySecret, { dir: flag(argv, "secrets") }) ??
        readEnvValue(selectedVault.age.identitySecret, paths.env))
      : undefined;
    const vault = new Vault(
      selectedVault.root,
      selectedVault.age ? { recipient: selectedVault.age.recipient, identity } : undefined,
    );
    if (sub === "list") {
      const files = vault.list();
      out(files.length ? files.map((f) => `  ${f}\n`).join("") : "  (the brain is empty)\n");
    } else {
      out(vault.read(flag(argv, "query")) + "\n");
    }
  }
}
