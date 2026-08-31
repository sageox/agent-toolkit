import { BUZZ_DEFAULTS, type ProbeReport } from "@sageox/agent-toolkit-adapter-buzz";

export function formatProbe(report: ProbeReport, relayUrl: string): string {
  const lines: string[] = [`\nrelay ${relayUrl}`];

  const authLine: Record<ProbeReport["auth"], string> = {
    authenticated: "challenged, and the relay accepted what we signed",
    refused: `REFUSED — the relay would not serve this key${
      report.authRefusal ? ` (${report.authRefusal})` : ""
    }`,
    "required-no-identity": "REQUIRED — and we had no identity to answer with",
    "not-required": "never requested",
  };

  lines.push(`  connected            yes`);
  lines.push(`  NIP-42 auth          ${authLine[report.auth]}`);
  lines.push(`  events seen          ${report.events}`);

  lines.push(`\n  queries:`);
  for (const q of report.queries) {
    const answered = q.eose ? "answered" : q.closed ? `closed: ${q.closed}` : "no EOSE (dropped?)";
    lines.push(`    ${q.label.padEnd(22)} ${String(q.events).padStart(3)} events   ${answered}`);
  }

  for (const notice of report.notices) lines.push(`  relay said           ${notice}`);

  if (report.auth === "refused") {
    lines.push(`
  The relay verified this signature and still refused the key, so it will serve
  nothing here. Ask whoever runs ${relayUrl} to allowlist the pubkey.`);
    return lines.join("\n") + "\n";
  }

  if (report.auth === "required-no-identity") {
    lines.push(`
  This relay serves nothing until you authenticate, so the probe learned nothing
  about its conventions. Create an identity and probe again:

    sageox-agent identity create
    sageox-agent probe --relay ${relayUrl}

  The relay may also need that pubkey allowlisted before it will serve you.`);
    return lines.join("\n") + "\n";
  }

  if (report.events === 0) {
    const answered = report.queries.filter((q) => q.eose).length;
    lines.push(
      answered === report.queries.length
        ? `
  Every query was accepted and answered, and every one was empty. The relay is
  not withholding events from a rejected request — it is serving none to this
  pubkey. Either the relay holds nothing, or this identity is not yet allowed
  to read: register the npub and add it to the channels it should see.`
        : `
  ${report.queries.length - answered} of ${report.queries.length} queries never got an EOSE, so they may have been
  dropped rather than answered. That points at the relay's filter handling
  rather than at permissions.`,
    );
    return lines.join("\n") + "\n";
  }

  const kinds = Object.entries(report.kinds)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}(${n})`)
    .join(" ");
  const tags = Object.entries(report.tagNames)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}(${n})`)
    .join(" ");

  lines.push(`  kinds present        ${kinds}`);
  lines.push(`  tag names present    ${tags}`);
  lines.push(`  channels (${BUZZ_DEFAULTS.channelTag} tag)     ${report.channelsSeen.join(", ") || "none"}`);
  lines.push(`  mentions of you      ${report.mentionsOfMe}`);

  lines.push(`\n  against the pinned conventions:`);
  lines.push(
    `    kind ${BUZZ_DEFAULTS.kind}   ${
      report.matchingPinnedKind > 0
        ? `matched ${report.matchingPinnedKind} event(s)`
        : "MATCHED NOTHING — the agent would hear silence"
    }`,
  );
  lines.push(
    `    tag "${BUZZ_DEFAULTS.channelTag}"    ${
      report.tagNames[BUZZ_DEFAULTS.channelTag] ? "present" : "ABSENT — channels would not resolve"
    }`,
  );

  if (!report.matchingPinnedKind || !report.tagNames[BUZZ_DEFAULTS.channelTag]) {
    lines.push(`
  Fix this in packages/adapter-buzz/src/normalize.ts (BUZZ_DEFAULTS) using the
  kinds and tags listed above, then re-run this probe.`);
  }

  return lines.join("\n") + "\n";
}
