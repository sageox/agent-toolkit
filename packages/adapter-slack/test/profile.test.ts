import { describe, expect, it } from "vitest";
import {
  publishSlackProfile,
  type SlackManifest,
  type SlackProfileApi,
} from "../src/profile.ts";

function png(width = 512, height = width): Buffer {
  const value = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

class FakeProfileApi implements SlackProfileApi {
  updates: Array<{ appId: string; manifest: SlackManifest }> = [];
  icons: Array<{ appId: string; icon: Buffer }> = [];

  constructor(readonly manifest: SlackManifest) {}

  async exportManifest(): Promise<SlackManifest> {
    return this.manifest;
  }

  async updateManifest(appId: string, manifest: SlackManifest): Promise<void> {
    this.updates.push({ appId, manifest });
  }

  async setIcon(appId: string, icon: Buffer): Promise<void> {
    this.icons.push({ appId, icon });
  }
}

describe("publishSlackProfile", () => {
  it("updates the app and bot identity while preserving unrelated manifest settings", async () => {
    const api = new FakeProfileApi({
      display_information: { name: "Old", background_color: "#123456" },
      features: { bot_user: { display_name: "Old", always_online: true } },
      settings: { socket_mode_enabled: true },
    });
    const avatar = png();

    await publishSlackProfile(
      { appId: "A123", name: "harry", about: "The camp guide.", avatar },
      api,
    );

    expect(api.updates).toEqual([{
      appId: "A123",
      manifest: {
        display_information: {
          name: "harry",
          description: "The camp guide.",
          background_color: "#123456",
        },
        features: { bot_user: { display_name: "harry", always_online: true } },
        settings: { socket_mode_enabled: true },
      },
    }]);
    expect(api.icons).toEqual([{ appId: "A123", icon: avatar }]);
  });

  it.each([
    ["an about line removed from the profile", undefined],
    ["an about line emptied on the command line", ""],
  ])("takes the published description off the app for %s", async (_case, about) => {
    const api = new FakeProfileApi({
      display_information: { name: "Old", description: "Stale.", background_color: "#123456" },
    });

    await publishSlackProfile({ appId: "A123", name: "harry", about }, api);

    expect(api.updates[0].manifest).toEqual({
      display_information: { name: "harry", background_color: "#123456" },
      features: { bot_user: { display_name: "harry" } },
    });
  });

  it("rejects an icon Slack cannot use before changing the manifest", async () => {
    const api = new FakeProfileApi({ display_information: { name: "Old" } });

    await expect(
      publishSlackProfile({ appId: "A123", name: "harry", avatar: png(256) }, api),
    ).rejects.toThrow(/between 512 and 2000/);
    expect(api.updates).toHaveLength(0);
  });
});
