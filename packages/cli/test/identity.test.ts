import { describe, expect, it } from "vitest";
import { normalizeActorId } from "../src/identity.ts";

const NPUB = "npub1sn0wdenkukak0d9dfczzeacvhkrgz92ak56egt7vdgzn8pv2wfqqhrjdv9";
const HEX = "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240";

describe("normalizeActorId", () => {
  it("rewrites a Nostr identity into the spelling Buzz events carry", () => {
    expect(normalizeActorId(NPUB)).toBe(HEX);
    expect(normalizeActorId(HEX.toUpperCase())).toBe(HEX);
  });

  it("leaves another surface's id alone, so one agent can be owned on both", () => {
    // A Slack member id is already what its events carry. Putting it through the Nostr
    // decoder threw at load, which took `run`, `doctor`, and `secrets` down with it.
    expect(normalizeActorId("U08ALICE")).toBe("U08ALICE");
    expect(normalizeActorId("W012ANON")).toBe("W012ANON");
  });

  it("still refuses a secret key pasted where a public one belongs", () => {
    expect(() => normalizeActorId("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5")).toThrow(
      /secret key/,
    );
  });
});
