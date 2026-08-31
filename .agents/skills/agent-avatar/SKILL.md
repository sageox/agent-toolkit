---
name: agent-avatar
description: Design, generate, replace, and publish an agent avatar with agent-toolkit while preserving the separation between durable character identity and shared house style. Use when creating an agent avatar, editing `avatar.md`, regenerating `avatar.png`, changing an agent's visual identity, reviewing avatar consistency, or publishing profile artwork to Buzz or Slack.
---

# Create an agent avatar

Use the toolkit's existing character brief, shared house style, generator, and profile
publisher. Preserve durable identity separately from rendering so the roster can be
restyled without redesigning every character.

## Inspect the identity first

Read the agent's `AGENTS.md`, `profile.json`, and `avatar.md`. Read
[design-system.md](references/design-system.md) when drafting or substantially revising the
character. Use the real job and persona as evidence; do not design from the name alone.

Keep these layers separate:

- `avatar.md` owns role metaphor, silhouette, signature prop, wardrobe and palette intent,
  background hue, expression, posture, and one role-specific joke.
- `packages/cli/src/avatar-house-style.txt` owns composition, line, lighting, crop, and the
  rest of the shared rendering system.
- `profile.json` selects `avatar.svg` or `avatar.png` for publication.

Do not copy the house style into each brief. Do not reduce identity to hex colors or
model-specific prompt syntax.

## Design for recognition

Make the avatar pass all of these tests:

- The face, silhouette, signature prop, and joke read in a 32 px circular crop.
- Eyes remain open and visible; props route behind or beside the face.
- The expression and posture match the behavioral persona.
- The silhouette remains distinct in grayscale.
- A total art-style swap leaves the character recognizable.
- No text, logo, detailed scenery, or decorative frame is needed for recognition.

Prefer one strong prop and one visual joke over many small clues. Keep humor warm and tied
to the work, not to protected traits or humiliation.

## Generate new artwork

For a new guided agent, the integrated flow is the user's to run in their own terminal:

```bash
./bin/sageox-agent create --name <agent-name>
```

The guided flow generates three candidates and pauses for a human selection. Selecting
between candidates needs a terminal, so more than one candidate is something you hand to the
human to run — asking for several from a tool shell fails with `multiple avatar candidates
need an interactive terminal for selection`.

Generate one candidate yourself:

```bash
./bin/sageox-agent create --name <agent-name> \
  --generate-avatar --avatar-candidates 1 --non-interactive
```

The CLI requests high-quality 1024×1024 PNG output, then resizes it to 512×512 and quantizes
its palette (keeping alpha) before writing `avatar.png` and updating `profile.json` — chat-icon
scale, small enough to commit alongside `avatar.md`. It does not crop the square portrait to a
circle; that stays a chat client's job, deliberately (see `prepareAvatarForUpload` in
`register.ts` for why — an image model draws a visibly different ring on every render, so
that geometry belongs in code, not the prompt, the day this toolkit wants one). Use
`--starter-avatar` for an offline SVG.

Generation needs `OPENAI_API_KEY`, and the key is the user's to supply. `--non-interactive`
reads it only from the environment and fails with `--generate-avatar needs OPENAI_API_KEY`
when it is unset. That error is the handoff: ask the user to export the key in the shell
that runs the command, and rerun. Never ask for the value in chat, never pass it as an
argument or an inline `OPENAI_API_KEY=… ./bin/sageox-agent …` prefix, and never write it to
a file — the CLI deliberately uses it for the one request and does not save it.

## Replace existing artwork

Edit the existing `avatar.md`, then deliberately regenerate:

```bash
./bin/sageox-agent create --name <agent-name> \
  --generate-avatar --avatar-candidates 1 --non-interactive --replace-avatar
```

When the user wants a choice instead, ask them to run `--generate-avatar
--avatar-candidates 3 --replace-avatar` in their own terminal and pick from the prompt.

Do not pass new profile fields when changing only artwork. Do not use `--replace-avatar`
unless the user authorized replacing the selected image. Preserve the existing image when
all candidates fail review.

## Review and publish

Read [review-and-publish.md](references/review-and-publish.md). Review every candidate at
full size, at 32 px, and in a circular crop before selection. A single candidate skips the
prompt and lands directly at `<agents-home>/<agent-name>/avatar.png`, so review that file
and regenerate with `--replace-avatar` rather than publishing artwork you have not looked
at. Fix the durable brief when the identity is wrong; fix the shared style only when the
same rendering failure affects the roster.

Generation is local. Publish only when the user explicitly asks:

```bash
./bin/sageox-agent identity register buzz --agent <agent-name> --relay <wss-url>
./bin/sageox-agent identity register slack --agent <agent-name> --app-id <app-id>
```

Slack publication needs a one-time `SLACK_CONFIG_TOKEN` exported by the user; it is never
saved and never yours to collect.

Verify the published profile on the destination surface. Report whether artwork was only
generated, selected locally, or also uploaded.
