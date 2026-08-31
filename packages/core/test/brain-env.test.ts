import { describe, it, expect } from "vitest";
import { brainEnv } from "../src/brain-env.ts";

/** A gateway-zone environment: surface identities, MCP auth, context creds. */
const gatewayEnv = {
  PATH: "/usr/bin",
  HOME: "/home/agent",
  ANTHROPIC_API_KEY: "sk-ant-brain",
  BUZZ_NSEC: "nsec1supersecret",
  SLACK_BOT_TOKEN: "xoxb-secret",
  DISCORD_TOKEN: "discord-secret",
  MCP_GITHUB_TOKEN: "ghp-secret",
  OX_AUTH_JSON: "{}",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
};

describe("brainEnv", () => {
  it("passes the Anthropic key through — the brain's only secret", () => {
    expect(brainEnv(gatewayEnv).ANTHROPIC_API_KEY).toBe("sk-ant-brain");
  });

  it("drops every surface, MCP, and context credential", () => {
    const env = brainEnv(gatewayEnv);
    for (const leaked of [
      "BUZZ_NSEC",
      "SLACK_BOT_TOKEN",
      "DISCORD_TOKEN",
      "MCP_GITHUB_TOKEN",
      "OX_AUTH_JSON",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      expect(env[leaked]).toBeUndefined();
    }
  });

  it("leaks no secret VALUE under any key (allowlist, not denylist)", () => {
    const values = Object.values(brainEnv(gatewayEnv));
    for (const secret of ["nsec1supersecret", "xoxb-secret", "ghp-secret", "aws-secret"]) {
      expect(values).not.toContain(secret);
    }
  });

  it("keeps the minimal runtime env the subprocess needs", () => {
    const env = brainEnv(gatewayEnv);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/agent");
  });

  it("takes an explicit api key over the ambient one", () => {
    expect(brainEnv(gatewayEnv, { apiKey: "sk-ant-explicit" }).ANTHROPIC_API_KEY).toBe(
      "sk-ant-explicit",
    );
  });

  it("omits the key entirely when there is none, rather than setting empty", () => {
    const env = brainEnv({ PATH: "/usr/bin" });
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
  });

  it("pins the model when the manifest names one", () => {
    expect(brainEnv(gatewayEnv, { model: "claude-opus-5" }).ANTHROPIC_MODEL).toBe(
      "claude-opus-5",
    );
  });

  it("leaves the brain on its own default when no model is pinned", () => {
    expect("ANTHROPIC_MODEL" in brainEnv(gatewayEnv)).toBe(false);
  });

  it("ignores an ambient model, which would repin every agent on the host", () => {
    const env = brainEnv({ ...gatewayEnv, ANTHROPIC_MODEL: "claude-haiku-4-5" });
    expect("ANTHROPIC_MODEL" in env).toBe(false);
  });
});
