# Avatar review and publication

Use this checklist after candidates exist and before selecting or publishing artwork.

## Review every candidate

Inspect the full-resolution image for:

- recognizable role metaphor and signature prop;
- open, unobstructed eyes and an expression aligned with the persona;
- clean anatomy, object geometry, and crop-safe composition;
- one legible, kind, role-specific joke;
- absence of text, logos, unwanted frames, and irrelevant scenery;
- consistency with `packages/cli/src/avatar-house-style.txt`.

Then inspect a 32 px circular preview. Reject any candidate whose face, silhouette, prop, or
joke collapses. Compare against existing agent thumbnails to catch near-duplicates.

## Diagnose the layer that failed

- If the wrong person was drawn, revise `avatar.md`: metaphor, prop, palette intent,
  expression, posture, or joke.
- If the right person was drawn in the wrong shared visual language, revise the house style
  only when the same issue should change for the whole roster.
- If a single candidate has malformed anatomy or composition but the brief is sound,
  regenerate without adding brittle exceptions.

Do not select the least-bad candidate merely because generation cost has already been
incurred. Keeping the starter or prior artwork is a valid result.

## Select and preserve provenance

Use the CLI selection prompt so the chosen candidate becomes canonical `avatar.png` and
`profile.json` points to it. A single-candidate run has no prompt: the image is already
`avatar.png`, so review it there and regenerate with `--replace-avatar` if it fails. Keep
`avatar.md` as the source for future redraws. Do not embed base64 output, API keys,
temporary candidate paths, or model chatter into the brief.

## Publish deliberately

Before publication, confirm:

- `profile.json` names the intended display name and selected artwork;
- `AGENTS.md` and `avatar.md` describe the same agent;
- the destination, app/relay identity, and channel are correct;
- the user authorized the external mutation.

Publish through `sageox-agent identity register`, not an ad hoc upload. The command prepares
canonical artwork and uses the same public identity on Buzz and Slack. After publication,
inspect the actual destination at chat size because provider-side cropping can differ from
the local preview.
