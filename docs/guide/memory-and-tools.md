# Give it memory and tools

<sub>[Setup guide](../../SETUP.md) · 3 of 6 · run these commands from the repository root</sub>

## Step 6 — memory

```bash
./bin/sageox-agent memory add local                    # a markdown vault it owns
./bin/sageox-agent memory add private --owner <org-npub> # encrypted on its Buzz relay
./bin/sageox-agent memory add shared --with ida        # one vault shared by this agent and ida
./bin/sageox-agent memory add team                     # read-only search over team knowledge
```

Each command adds the brain to `agent.yaml` **and writes the matching tool-policy entries**,
which is the point: memory tools arrive namespaced (`mcp__brain__brain_read`), and a
hand-written policy that omits the prefix silently matches nothing. The agent would then
have memory it cannot read, and `doctor` would have agreed with you.

Then read what it has written into inspectable markdown vaults:

```bash
./bin/sageox-agent memory list
./bin/sageox-agent memory read --query deploys
./bin/sageox-agent memory path                           # prints every local/shared vault
./bin/sageox-agent memory list --brain brain-shared-1   # select one when several are configured
```

The **local** brain is a directory of markdown files the agent appends to, with provenance
on every line. The **shared** brain is the same auditable format at a path used by an
explicit pair or squad. Run the command for every participating agent with the same names;
the sorted scope produces the same default vault path. Agents on different hosts need a
shared mount and the same explicit path:

```bash
./bin/sageox-agent memory add shared --with ida --path /mnt/agent-memory/harry-ida
```

The scope must contain this agent and at least one distinct peer, and the same scope cannot
be declared twice. That is an addressing boundary, not OS-level authorization; filesystem
permissions on the shared mount remain the deployment's job.

### Encrypt selected markdown files with age

A local or shared vault may mix inspectable `*.md` files with age-encrypted `*.md.age`
files. Encryption is selected by the filename: ordinary markdown always stays plaintext,
while reads and appends to `*.md.age` are decrypted and re-encrypted transparently. No
plaintext temporary file is created.

Install [`age`](https://age-encryption.org/) on a local runtime that does not use the
project image, create an identity outside the agent bundle, and derive its public recipient:

```bash
mkdir -p /srv/agent-secrets/harry
age-keygen -o /srv/agent-secrets/harry/SHARED_BRAIN_AGE_IDENTITY
chmod 600 /srv/agent-secrets/harry/SHARED_BRAIN_AGE_IDENTITY
AGE_RECIPIENT=$(age-keygen -y /srv/agent-secrets/harry/SHARED_BRAIN_AGE_IDENTITY)
printf '%s\n' "$AGE_RECIPIENT"
```

Pass the printed `age1…` recipient—not the private identity—to the authoring CLI:

```bash
./bin/sageox-agent memory add shared --with ida --path /mnt/agent-memory/harry-ida \
  --age-recipient "$AGE_RECIPIENT" \
  --age-identity SHARED_BRAIN_AGE_IDENTITY

./bin/sageox-agent doctor --agent harry --secrets /srv/agent-secrets/harry
./bin/sageox-agent run --agent harry --secrets /srv/agent-secrets/harry
```

`doctor` checks the age binaries and, when the identity is mounted, confirms that its public
recipient matches the one in the manifest. A missing identity is a warning rather than a startup
failure: plaintext files remain usable while encrypted slices report access denied.

The resulting manifest contains only public and logical values:

```yaml
brains:
  - preset: shared
    path: /mnt/agent-memory/harry-ida
    scope: [harry, ida]
    age:
      recipient: <the age1... value printed above>
      identitySecret: SHARED_BRAIN_AGE_IDENTITY
```

Mount a matching identity secret only for agents allowed to decrypt those slices. An agent
without that identity can still list the encrypted filenames and use accessible plaintext
files; reads report each inaccessible slice as denied. Give every writer that should share
one encrypted slice the same recipient and matching identity: encrypted writes require the
identity too, so an agent that could not read a slice back is refused rather than left
reporting a durable memory it cannot use. A write to an inaccessible encrypted file fails
rather than replacing its ciphertext.

The identity stays in the gateway. The ACP brain receives a capability URL for the vault,
not the key, and neither the manifest nor deployment artifacts contain the private value.
Use the deployment platform's Secret, CSI, SOPS, or equivalent integration to produce the
file named by `identitySecret` under `/mnt/secrets-store`. Decide which facts require encryption
in the agent's instructions, and name those destinations `*.md.age`; the toolkit does not
guess data classification from prose. Keep each decrypted slice below 32 MiB; larger files fail
with an explicit size error instead of being mistaken for an invalid identity.

Either path works under Docker: the Compose deployment adapter reads every supplied bundle
and gives each vault outside that bundle its own bind mount, so the container writes to the
same directory the host does. That makes a vault path a choice about mounts, so it is
checked rather than trusted: a relative one has to stay under the shared vault directory,
and an absolute one has to name a volume the deployment owns — `/mnt`, `/srv` and `/opt`
are free, the directories the image provides are not. The adapter refuses an unsafe path
rather than writing a Compose file that binds a host directory over the container's own
filesystem.

The **private** brain stores NIP-AE `kind:30174` engrams on the agent's configured Buzz
relay. Each value is encrypted with NIP-44 for one `(agent, organization owner)` pair; its
`d` address is an HMAC, so the key name is not exposed in event tags. The gateway hosts
the four MCP tools (`brain_list`, `brain_read`, `brain_write`, `brain_delete`) and retains
the Nostr signer. The model process receives a capability URL, never `BUZZ_NSEC`.

Private memory is deliberately transport-bound: it follows that Buzz relay and agent
identity, so put cross-surface facts in a local/shared/team brain instead. The `--owner`
value is the memory namespace, not the `respondTo: owner-only` gate. Use an organization
identity, not a person's key; offboarding a personal owner makes every engram unreadable.
The command accepts an `npub` or hex public key and stores canonical 64-character hex.

By default the agent may write any key in its own store, which is the right answer when the
memory is its own. An agent trusted to edit one corner of memory and nothing else takes a
`--write-scope`:

```bash
./bin/sageox-agent memory add private --owner <org-npub> --write-scope core,mem/skills/
```

That confines `brain_write` and `brain_delete` to keys under those prefixes; `brain_list`
and `brain_read` still see the whole store, because the bound is on what a turn can change,
not on what it can know. `mem/skills/`, `mem/skills`, and `skills` are the same grant, and
matching is at key-segment boundaries — `mem/skills/rust` is inside `mem/skills`, and
`mem/skills-notes` is not. The scope is stated in the two tool descriptions it constrains,
so the model is told the boundary instead of finding it by being refused, and `doctor`
prints the scope it resolved so a prefix the gateway would reject surfaces before a rollout.

Naming `core` grants rewriting the agent's own profile without granting the rest of the
store, which is the usual shape: curate one subtree, keep your own profile current, touch
nothing else. It never widens deletion — `core` has no tombstone, so `brain_delete` refuses
it whether or not a scope names it.

The cryptographic owner binding is a separate, first-write-wins Buzz registration step.
Read and verify the existing binding before creating one; this toolkit will not overwrite
it. `doctor` performs a read of the private `core` address and distinguishes confirmed
absence from an unreadable record, so a bad key or owner fails loudly instead of looking
like an empty brain. Private values are not exposed by the plaintext `memory read` command;
an owner can inspect them with a NIP-AE client, and the agent can use its MCP tools.

Re-running `memory add` for a brain the agent already has re-checks its tool policy instead
of failing. That is how an agent set up by an older release picks up a brain tool added
since — `doctor` names the missing tool, and re-running the same `memory add` allows it. The
existing entry itself is never rewritten.

The **team** brain reaches your team's own knowledge through `ox`, as one tool:
`team_search` over recorded discussions, decisions, docs and prior sessions. It reads;
nothing here writes to team memory, because an agent that can write to it is an agent whose
worst turn becomes a fact a colleague cites six months later.

One tool, and the reason is the same one that keeps several others out. `ox glance`,
`ox session list` and `ox conversation` all read a local checkout that `ox daemon` keeps in
sync, and this toolkit does not run that daemon (see
[step 7b](#step-7b--repository-context)). Without it `ox session list` answers
`{"sessions": [], "ledger_available": false}` and exits 0 — an empty week and an unsynced
container look identical — so the answer would be confidently wrong rather than merely thin.
`ox conversation` at least fails honestly, with `{"success": false, "error": {"code":
"no_team_context"}}`, but it fails all the same. `team_search` is served because `ox query`
is answered server-side from the token, so it works wherever the agent runs.

Leave `--team` off and it lists the teams this machine can see, by name, so you pick one
rather than typing an id. That listing only works where `ox` has local state — a container
holding nothing but a token cannot enumerate teams — which is why the id is resolved here,
once, and written into the manifest.

**About the SageOx credential.** `memory add team` sorts it out at the time you add it,
rather than leaving you to discover it later:

- If you have run `ox login` on this machine, it says so and asks for nothing — ox uses its
  own credential.
- If not, it asks for a personal access token (hidden input) and saves it to local `.env`.

Either way a **container** needs a token binding of its own, since it has no login to fall
back on. The deployment tool reports the required logical name and the chosen SOPS, CI, or
platform integration supplies its file. See
[The team brain's credential](reference.md#the-team-brains-credential) for why it is a PAT and not the
token from your own login.

## Step 7 — tools

### An MCP server, bounded to what it may be pointed at

```bash
./bin/sageox-agent mcp add --name postgres --command npx \
  --args "-y,@modelcontextprotocol/server-postgres" \
  --secret-refs "DATABASE_URL=PG_URL" \
  --scope "database=analytics"
```

`--secret-refs` maps the server's own env var to a `secretRef` the gateway resolves. The
command starts the server once to ask what tools it offers, so the policy is written from
fact rather than guesswork. Nothing is typed by hand — a bare tool name matches nothing and
produces a policy that looks correct and enforces nothing.

**`--scope` is the one that narrows the credential.** A credential is almost never as narrow
as the job: a GitHub token reaches every repository its owner can see, a Linear key every
team. The tool policy cannot fix that, because it matches on the tool *name* and this is a
fact about an *argument* — `create_issue` is the same tool whichever repository it is aimed
at. So name the argument and the values allowed under it:

```yaml
mcpServers:
  - name: github
    command: node
    args: ["_base/github-mcp.js"]
    secrets: {GITHUB_TOKEN: GITHUB_TOKEN}
    scope:
      repo: [acme/service, acme/tools]
```

Compared as an **exact string**: `https://github.com/acme/service` and `acme/service.git`
are refused, because one spelling checked one way is the only version of this rule that
cannot be argued with. A glob is refused when the config is read — an exact comparison could
only ever match nothing, and a bound that refuses every call should not be something you
discover at 3am.

**It is fail-closed.** A call that names no bound argument at all is refused, not waved
through. That is deliberate and it is the whole design: a server's org-wide tools are
exactly the ones that take no repository, so "check it when present" would admit precisely
the calls that escape the bound. A tool this refuses is a tool you should not be allowing.

**Every argument is scanned** against the `guard.leakPatterns` in `agent.yaml`, on reads as
well as writes. An MCP call is the other way out of the agent, and a credential pasted into
an issue body or a search query has reached a third party either way.

Nothing about this is GitHub-shaped — `scope: {teamId: [ENG]}` and
`scope: {database: [analytics]}` work the same. Reaching GitHub is a server you point at,
not a feature of the toolkit.

**Every MCP server is gateway-hosted**, credential or not. The gateway runs the server as
its own child with the credential in *that* process, and publishes it to the brain over
HTTP behind a per-server capability token. The brain asks for a tool call; it never holds
the means to make one. One path rather than two, because a "credential-free" server that
later gains a credential would otherwise silently become the unsafe case.

Every call to one of those servers passes the broker, which enforces the tool policy, the
bound and the leak scan, and pins each tool's schema on first sight — a server that quietly
redefines an approved tool is held back rather than passed on. Built-in surfaces (the team
brain, cross-posting, the job door) have no subprocess to broker: their tools are compiled
in, so their shape cannot change underneath the policy, and each checks the policy itself
before it acts.

> **Before you allow a write-capable tool.** An allowed write tool *writes* — there is no
> second confirmation. The egress guard does not apply to tool calls; it governs messages
> posted to surfaces. So the only things between a channel message and a pushed commit are
> `respondTo`, the tool allowlist, and the credential's own scopes. Keep `respondTo:
> owner-only` while any write tool is allowed, and scope the token narrowly. Every call is
> recorded either way — see [What the log says about tool calls](reference.md#what-the-log-says-about-tool-calls)
> — but a log is a record after the fact, not a gate in front of one.

## Step 7b — repository context

Give the agent searchable code context without making deployment wait for a clone or index:

```bash
./bin/sageox-agent repos add https://github.com/acme/service
./bin/sageox-agent repos add https://github.com/acme/private-service --private
./bin/sageox-agent repos list
```

The command writes `repos.conf` and allows exactly `mcp__code__code_search` and
`mcp__code__code_status`. On `run`, the agent connects to its surfaces immediately while
the gateway clones or fast-forwards each checkout and runs `ox index code` in the
background. Until an index passes `ox code status`, the turn receives a trusted warming or
failure status and must say that code context is unavailable rather than inventing an
answer. Repositories are warmed sequentially so they never race while updating the same
durable index store.

`repos.conf` is deliberately deployment-neutral: one HTTPS URL per line, with `private `
in front of a private GitHub repository. Private clones use a narrowly scoped read-only
`GITHUB_TOKEN`; `secrets` prompts for it and containers receive it as a mounted file. A
credential embedded in a URL is rejected, and the token is never stored in the checkout's
remote URL.

Checkouts and indexes live under the agent's `workspace/` directory. Compose already mounts
the whole agent directory, and the Kubernetes chart uses a PVC for it, so a restart
fetches changes instead of cold-cloning everything. No `ox daemon` is started: that daemon
synchronizes SageOx ledger state, while repository readiness here is provided by the
one-shot code index command.

---

[← Put it on Buzz or Slack](chat-surfaces.md) · [Run it for real →](run-it-for-real.md)
