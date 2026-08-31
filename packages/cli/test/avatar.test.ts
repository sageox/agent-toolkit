import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  AVATAR_MODEL,
  avatarPrompt,
  generateAvatarCandidates,
  optimizeAvatarPng,
} from "../src/avatar.ts";
import { AVATAR_MD } from "../src/init.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/** A small multi-color image with a transparent half, for exercising palette + alpha. */
async function swatchPng(width = 40, height = 40): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Four flat color bands, left half opaque and right half transparent — enough
      // distinct colors to prove quantization ran, and enough alpha spread to prove it
      // survived.
      const band = Math.floor((x / width) * 4);
      raw[i] = [200, 40, 90, 20][band];
      raw[i + 1] = [90, 160, 40, 60][band];
      raw[i + 2] = [40, 90, 160, 200][band];
      raw[i + 3] = x < width / 2 ? 255 : 0;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

describe("generated avatars", () => {
  it("keeps the character brief separate from the shared house style", () => {
    const prompt = avatarPrompt("A patient camp guide with an oversized compass.");
    expect(prompt).toContain("A patient camp guide with an oversized compass.");
    expect(prompt).toContain("HOUSE STYLE");
    expect(prompt).toContain("32px circle");
  });

  it("sends the model the character, not the notes addressed to whoever edits the file", () => {
    const prompt = avatarPrompt(AVATAR_MD("Harry", "Guides the team.", "An oversized compass."));
    expect(prompt).toContain("An oversized compass.");
    expect(prompt).not.toContain("This file owns who Harry is visually");
    expect(prompt).not.toContain("## Current artwork");
  });

  it("asks every character brief to pick a background hue distinct from the rest of the roster", () => {
    const brief = AVATAR_MD("Harry", "Guides the team.", "An oversized compass.");
    expect(brief).toContain("## Background color");
    expect(brief).toContain("no other agent in the roster already uses");
    // It has to reach the model, not just live in the brief file, or two agents can still
    // converge on the same muted green.
    expect(avatarPrompt(brief)).toContain("no other agent in the roster already uses");
  });

  it("requests one PNG from the current image model and returns it optimized to chat-icon scale", async () => {
    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({
      data: [{ b64_json: ONE_PIXEL_PNG.toString("base64") }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const [image] = await generateAvatarCandidates("character brief", "sk-test", 1, request);

    const meta = await sharp(image).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: AVATAR_MODEL,
      size: "1024x1024",
      quality: "high",
      output_format: "png",
      n: 1,
    });
  });

  it("requests and canonicalizes several candidates in one call", async () => {
    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: Array.from({ length: 3 }, () => ({
          b64_json: ONE_PIXEL_PNG.toString("base64"),
        })),
      }), { status: 200 }));

    const images = await generateAvatarCandidates("character brief", "sk-test", 3, request);

    expect(images).toHaveLength(3);
    for (const image of images) {
      const meta = await sharp(image).metadata();
      expect(meta.width).toBe(512);
      expect(meta.height).toBe(512);
    }
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).n).toBe(3);
  });

  it("refuses a partial candidate response", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: ONE_PIXEL_PNG.toString("base64") }],
    }), { status: 200 }));

    await expect(generateAvatarCandidates("brief", "sk-test", 3, request)).rejects.toThrow(
      /returned 1 of 3 requested images/,
    );
  });

  it("surfaces the API's useful error without exposing the key", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "image generation is unavailable" },
    }), { status: 429 }));

    await expect(generateAvatarCandidates("brief", "sk-secret", 1, request)).rejects.toThrow(
      /429.*image generation is unavailable/,
    );
  });
});

describe("optimizeAvatarPng", () => {
  it("resizes to chat-icon scale", async () => {
    const optimized = await optimizeAvatarPng(await swatchPng());
    const meta = await sharp(optimized).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it("quantizes to a small indexed palette", async () => {
    const optimized = await optimizeAvatarPng(await swatchPng());
    const meta = await sharp(optimized).metadata();
    // Flat cel-shaded art (a handful of bands, not a gradient) needs far fewer than the
    // 64-color cap — this is the property that makes quantization near-lossless for this
    // style rather than a visible downgrade.
    expect(meta.isPalette).toBe(true);
  });

  it("keeps the alpha channel, including the fully transparent half", async () => {
    const optimized = await optimizeAvatarPng(await swatchPng());
    const meta = await sharp(optimized).metadata();
    expect(meta.hasAlpha).toBe(true);

    const { data, info } = await sharp(optimized)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const leftAlpha = data[(Math.floor(info.height / 2) * info.width + 4) * info.channels + 3];
    const rightAlpha = data[(Math.floor(info.height / 2) * info.width + info.width - 4) * info.channels + 3];
    expect(leftAlpha).toBeGreaterThan(200); // opaque half survived
    expect(rightAlpha).toBeLessThan(50); // transparent half survived, not flattened opaque
  });

  it("strips ancillary chunks the same way canonicalPng does", async () => {
    const optimized = await optimizeAvatarPng(await swatchPng());
    // canonicalPng throws on anything it wouldn't accept — running it again here proves
    // sharp's output is itself already canonical, not merely close.
    const { canonicalPng } = await import("../src/register.ts");
    expect(canonicalPng(optimized)).toEqual(optimized);
  });

  it("shrinks a synthetic 1024px source by roughly the size this feature exists for", async () => {
    const large = await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: { r: 90, g: 130, b: 100, alpha: 1 } },
    }).composite([{ input: await swatchPng(400, 400), left: 300, top: 300 }]).png().toBuffer();

    const optimized = await optimizeAvatarPng(large);
    expect(optimized.length).toBeLessThan(large.length / 4);
  });
});
