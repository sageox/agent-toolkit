import { WebClient, type AppsManifestUpdateArguments } from "@slack/web-api";

export type SlackManifest = Record<string, unknown>;

/** Narrow setup seam: tests preserve a manifest without making Slack API calls. */
export interface SlackProfileApi {
  exportManifest(appId: string): Promise<SlackManifest>;
  updateManifest(appId: string, manifest: SlackManifest): Promise<void>;
  setIcon(appId: string, icon: Buffer): Promise<void>;
}

/** Uses a one-time app configuration token; runtime bot and Socket Mode tokens cannot edit an app. */
export class WebSlackProfileApi implements SlackProfileApi {
  private readonly client: WebClient;

  constructor(configToken: string) {
    this.client = new WebClient(configToken);
  }

  async exportManifest(appId: string): Promise<SlackManifest> {
    const response = await this.client.apps.manifest.export({ app_id: appId });
    if (!response.manifest) throw new Error("Slack returned no app manifest");
    return response.manifest as unknown as SlackManifest;
  }

  async updateManifest(appId: string, manifest: SlackManifest): Promise<void> {
    await this.client.apps.manifest.update({
      app_id: appId,
      manifest: manifest as AppsManifestUpdateArguments["manifest"],
    });
  }

  async setIcon(appId: string, icon: Buffer): Promise<void> {
    await this.client.apiCall("apps.icon.set", { app_id: appId, file: icon });
  }
}

export interface SlackPublicProfile {
  appId: string;
  name: string;
  about?: string;
  avatar?: Buffer;
}

/** Publishes the shared agent profile while leaving every unrelated app setting intact. */
export async function publishSlackProfile(
  profile: SlackPublicProfile,
  api: SlackProfileApi,
): Promise<void> {
  if (profile.name.length > 35) {
    throw new Error("Slack app names may be at most 35 characters");
  }
  if (profile.about && profile.about.length > 140) {
    throw new Error("Slack app descriptions may be at most 140 characters");
  }
  if (profile.avatar) assertSlackIcon(profile.avatar);

  const manifest = await api.exportManifest(profile.appId);
  // `description` is one of the three fields this function owns, so it is rebuilt from the
  // profile rather than inherited. Dropping `about` from profile.json has to take the
  // description off the app too, or the declarative file stops describing what Slack shows
  // — the same replace-what-is-omitted contract the Buzz publisher already has.
  const { description: _replaced, ...display } = objectValue(manifest.display_information);
  const features = objectValue(manifest.features);
  const botUser = objectValue(features.bot_user);
  const updated: SlackManifest = {
    ...manifest,
    display_information: {
      ...display,
      name: profile.name,
      ...(profile.about ? { description: profile.about } : {}),
    },
    features: {
      ...features,
      bot_user: { ...botUser, display_name: profile.name },
    },
  };

  await api.updateManifest(profile.appId, updated);
  if (profile.avatar) await api.setIcon(profile.appId, profile.avatar);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** apps.icon.set accepts square PNGs from 512 through 2000 pixels. */
function assertSlackIcon(icon: Buffer): void {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (icon.length < 24 || !icon.subarray(0, 8).equals(png)) {
    throw new Error("Slack avatar must be a PNG");
  }
  const width = icon.readUInt32BE(16);
  const height = icon.readUInt32BE(20);
  if (width !== height || width < 512 || width > 2000) {
    throw new Error("Slack avatar must be square and between 512 and 2000 pixels");
  }
}
