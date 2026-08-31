import { describe, it, expect } from "vitest";
import { chooseTeam } from "../src/cli.ts";

/**
 * Someone reaching team memory with no teams listed may have no SageOx account at all —
 * `ox kb list` returns nothing either way. The old copy sent them to find an id in an app
 * they cannot open, which is a dead end, and this stage is the only one that asks for a
 * team. So the offer to register lives in exactly that branch.
 */
describe("the team memory stage, for someone with no account", () => {
  const scripted = (answers: string[]) => {
    const asked: string[] = [];
    const said: string[] = [];
    let i = 0;
    return {
      asked,
      said,
      io: {
        teams: async () => [],
        ask: async (question: string) => {
          asked.push(question);
          return answers[i++] ?? "";
        },
        say: (line: string) => said.push(line),
      },
    };
  };

  it("offers an account, points at the register page, and still asks for the id", async () => {
    const { asked, said, io } = scripted(["y", "", "team_jihjpfkt8b"]);

    expect(await chooseTeam(io)).toBe("team_jihjpfkt8b");
    expect(said.join("")).toContain("https://sageox.ai/register");
    // Asked after the registration, not before: the id does not exist until the team does.
    expect(asked.at(-1)).toMatch(/team id/);
  });

  it("does not send someone who already has an account to the register page", async () => {
    const { said, io } = scripted(["n", "team_jihjpfkt8b"]);

    expect(await chooseTeam(io)).toBe("team_jihjpfkt8b");
    expect(said.join("")).not.toContain("register");
    expect(said.join("")).toMatch(/ox login/);
  });

  it("offers the same route from the picker, without a question of its own", async () => {
    const asked: string[] = [];
    const said: string[] = [];
    const answers = ["new", "", "team_new0000"];
    let i = 0;
    const id = await chooseTeam({
      teams: async () => [{ id: "team_jihjpfkt8b", name: "SageOx", named: true }],
      ask: async (question: string) => {
        asked.push(question);
        return answers[i++] ?? "";
      },
      say: (line: string) => said.push(line),
    });

    // The route is on the line already being printed, so someone who has a team pays
    // nothing for it and someone who does not can still reach it here.
    expect(asked[0]).toContain("new SageOx account");
    expect(said.join("")).toContain("https://sageox.ai/register");
    expect(id).toBe("team_new0000");
  });

  it("still picks a listed team by number", async () => {
    const id = await chooseTeam({
      teams: async () => [
        { id: "team_jihjpfkt8b", name: "SageOx", named: true },
        { id: "team_xlcr6yzpec", name: "SageOx Internal", named: true },
      ],
      ask: async () => "2",
      say: () => {},
    });

    expect(id).toBe("team_xlcr6yzpec");
  });
});

/**
 * `n` answers a `[y/N]` question in one branch and would ask for a new account in the
 * other. One key cannot mean both — the collision surfaces as a wrong answer nobody
 * reports, because both readings look like the person got what they asked for.
 */
describe("the two answer vocabularies", () => {
  it("reads a bare n at the y/N question as no, not as a new account", async () => {
    const said: string[] = [];
    const answers = ["n", "team_jihjpfkt8b"];
    let i = 0;
    const id = await chooseTeam({
      teams: async () => [],
      ask: async () => answers[i++] ?? "",
      say: (line: string) => said.push(line),
    });

    expect(said.join("")).not.toContain("register");
    expect(id).toBe("team_jihjpfkt8b");
  });

  it("does not read a team named n as a request to register", async () => {
    const id = await chooseTeam({
      teams: async () => [{ id: "team_jihjpfkt8b", name: "SageOx", named: true }],
      ask: async () => "1",
      say: () => {},
    });

    expect(id).toBe("team_jihjpfkt8b");
  });
});
