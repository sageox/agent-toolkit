import { readFileSync } from "node:fs";
import sharp from "sharp";
import { canonicalPng } from "./register.ts";

export const AVATAR_MODEL = "gpt-image-2";
const AVATAR_HOUSE_STYLE = readFileSync(
  new URL("./avatar-house-style.txt", import.meta.url),
  "utf8",
).trim();

// The API is asked for 1024x1024 (below) because downsampling a large render stays crisp,
// while asking a model to draw small first does not. 512px is the size actually delivered:
// plenty for a chat avatar, and it's what every consuming surface (Buzz, Slack) displays it
// at anyway. `colors` caps an indexed PNG's palette — flat cel shading with two tones per
// color (see avatar-house-style.txt) needs only a few dozen distinct colors, so 64 quantizes
// this specific art style close to losslessly while cutting the raw ~1.5MB API response to
// under 100KB. That's the difference between "avatar.png is a large untracked binary" and
// "avatar.png is small enough to commit alongside avatar.md in the agent's own repo."
const AVATAR_SIZE = 512;
const AVATAR_PALETTE_COLORS = 64;

/**
 * Shrinks a generated avatar to chat-icon scale and quantizes its palette, keeping alpha.
 *
 * This does NOT crop the square portrait to a circle — avatar-house-style.txt already tells
 * the model to leave plain-background margin so a consuming surface can crop it, and that
 * crop is deliberately left to the surface (see the note in register.ts's
 * prepareAvatarForUpload) rather than baked in here.
 */
export async function optimizeAvatarPng(png: Buffer): Promise<Buffer> {
  const optimized = await sharp(png)
    .resize(AVATAR_SIZE, AVATAR_SIZE)
    .png({ palette: true, colors: AVATAR_PALETTE_COLORS })
    .toBuffer();
  return canonicalPng(optimized);
}

export function avatarPrompt(brief: string): string {
  // Everything before the first section — the title and the note explaining what the file
  // is for — addresses whoever edits it, not the model. `## Current artwork` is the same.
  const firstSection = brief.search(/^## /m);
  const character = brief
    .slice(firstSection === -1 ? 0 : firstSection)
    .split("\n## Current artwork", 1)[0]
    .trim();
  return `Create one finished chat avatar from this durable character brief.

CHARACTER — preserve this identity even if the visual style changes:
${character}

HOUSE STYLE — apply this rendering system without changing the character:
${AVATAR_HOUSE_STYLE}

Return one polished 1024x1024 portrait. The face, silhouette, signature prop, and joke must
remain recognizable when the image is displayed as a 32px circle.`;
}

/** Calls the Images API directly so avatar generation adds no SDK dependency. */
export async function generateAvatarCandidates(
  brief: string,
  apiKey: string,
  count: number,
  request: typeof fetch = fetch,
): Promise<Buffer[]> {
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    throw new Error("avatar candidate count must be an integer from 1 to 4");
  }
  const response = await request("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AVATAR_MODEL,
      prompt: avatarPrompt(brief),
      size: "1024x1024",
      quality: "high",
      output_format: "png",
      background: "opaque",
      n: count,
    }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    const body = await response.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      detail = parsed.error?.message ?? body;
    } catch {
      // The HTTP status still makes a non-JSON upstream response actionable.
    }
    throw new Error(`OpenAI avatar generation failed (${response.status}): ${detail}`);
  }

  const body = await response.json() as { data?: Array<{ b64_json?: string }> };
  const encoded = (body.data ?? [])
    .map((item) => item.b64_json)
    .filter((value): value is string => Boolean(value));
  if (!encoded.length) throw new Error("OpenAI avatar generation returned no image");
  if (encoded.length !== count) {
    throw new Error(
      `OpenAI avatar generation returned ${encoded.length} of ${count} requested images`,
    );
  }
  // Optimize before returning, not after selection: candidates are shown to a human for
  // review (see chooseAvatarCandidate in commands.ts), and reviewing anything other than
  // the exact bytes that will be written and published would make the review meaningless.
  return Promise.all(
    encoded.map((value) => optimizeAvatarPng(canonicalPng(Buffer.from(value, "base64")))),
  );
}
