# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A probing job can read its thread back on Slack, so a roll call there has an answer.**
  `SlackAdapter.readThread` walks `conversations.replies` under a root the run posted and
  hands back the replies oldest first. Only Buzz implemented the verb, so a probe on a
  Slack-only agent posted its roll call, waited, and then died on *"the slack surface cannot
  read a thread back"* — the fleet-liveness job, unable to run on one of the two surfaces
  the toolkit ships. The endpoint was already in the adapter's API seam, used by backfill.
  Replies are normalized through the same `toSlackInboundEvent` a turn is, so a join notice
  or a hidden message is no more a reply than it is a turn, and the thread parent Slack
  returns is dropped by `ts` — it is not in its own thread. Every failure throws and none
  answers `[]`: an unstarted adapter, a root naming another surface, and a root in a
  conversation this agent does not serve are all findings a probe must not read as silence.

- **A probing job body can address its post, so the agents it names actually wake.**
  `post_message` takes `mentions`, and the adapter renders them as its surface's addressing
  primitive — a `p` tag on Buzz, `<@id>` on Slack. Without it a probe posted into a channel
  and woke nobody: a `p` tag is Buzz's only wake trigger, a channel post deliberately
  carries none, and so a roll call read back an empty thread and reported the entire fleet
  silent — a failure indistinguishable from a total outage, on the one job whose output is
  consumed as fleet liveness. Recipients are **ids the surface resolves** (`npub…` or hex,
  a Slack member id) and never display names, which render and wake no one; the adapter
  refuses a name rather than publish a message that looks addressed and is not. At most 64
  per message, and being addressed reaches no further than `jobs[].report` already did. The
  field is the probe's alone: a status post — this body's own `report`, and every non-probe
  job's — still addresses nobody, and the brain's `post_message` has no such field.

- **A bundle can say which of a job's credentials the gateway's own process must not hold.**
  `jobs[].run.jobSecrets` takes the same env-var-to-`secretRef` map `run.secrets` does and
  resolves from the same directory list, so a one-directory deployment satisfies both. What
  it adds is a load-time refusal: a job declaring one **may not arm `trigger.onRequest`**,
  named ref and all. A target could already hand `job run` a second directory it does not
  give the gateway — `--job-secrets`, which chart 0.9.0 mounts as `agents.<name>.jobSecrets`
  — but nothing in the manifest recorded which ref lived there, so a job that was both
  scheduled and on-request resolved it on every tick and was refused by name the first time
  a person asked for it. `onRequest` is the only trigger the gateway serves; every other one
  enters through `job run`, a separate process. The gateway still gains no credential to fix
  it — the message names the three ways out instead: drop `onRequest`, keep the credential
  in `secrets` and take the weaker guarantee knowingly, or give the credentialed work a job
  of its own that nothing may ask for. A name declared in both maps is refused too, since
  the envelope merges them. `run.jobSecrets` is also left out of the inventory `run` checks
  before it opens a socket, which is what lets such an agent launch at all: a credential
  that moved but stayed spelled `secrets` refuses the launch, not just the run. Nothing that
  loads today stops loading — the key is new, and `run` was already `.strict()`.

### Fixed

- **A job a person asks for runs, even when its kill switch is parked.** `job_run` records
  the author of the message the agent is answering, so a request that arrives through a chat
  surface is the human on-request run the host has always described — it has refused with
  *"only a human's on-request run bypasses a parked job"* since jobs shipped, and nothing was
  ever classified as one. A `tools/call` carries this server's bearer token and the tool
  arguments and nothing at all about the turn that produced it, so the author is read off the
  gateway instead: the same live-turn registry the reaction tool reads to mark "the message
  you are answering", holding an author the manifest already admitted through `owner`,
  `allowlist`, and `respondTo`. The kind comes from that author's own `isAgent` and is not a
  field of the call, so `on-request` remains a trigger rather than an authorization — a
  sibling agent asking is automation and a parked job still refuses it, as it does when two
  channels are mid-turn at once and no one person can be named. Either way the record now
  names whoever asked, rather than the agent itself. The bypass answers only whether the
  run starts: every gate governing what it may do is untouched, and it writes nothing, so a
  parked job is still parked afterwards and the run carries `bypassedSwitch: true` for
  whoever reads the record at 3am. Worst on a job with no schedule at all, where the switch
  parked no clock and its only effect was to refuse the request it exists to permit; the
  workaround it replaces is arming a posture switch for one run and remembering to disarm it.

- **A DM sent to a Slack agent while it was down is answered when it comes back.**
  The backfill walked the configured `channels` and nothing else, so it could never reach a
  DM: a DM's conversation id does not exist until someone opens it, which is why no entry
  names one, and the adapter's live set of them is empty until an event arrives. A DM in
  that gap was therefore in neither set — nothing enumerated it, nothing replayed it, and
  the resume cursor moved past it the moment any channel message was accepted. The message
  was gone for good, and the person who sent it got silence from an agent that looked
  healthy. `users.conversations` now supplies the open DMs at backfill time, which is what
  `im:read` — already in the setup guide's scope list — is for. **Reading one is not
  permission to speak in one:** a DM still earns a reply by having sent something, so a
  conversation with nothing in the gap is enumerated and stays one the adapter may not post
  into. A workspace that withholds `im:read` loses the DM backfill and keeps everything
  else, rather than failing the launch over a scope a channel-only agent never needs.

- **A Slack message says what the brain wrote, and addresses only whom `mentions` names.**
  The adapter escapes `&`, `<` and `>` in the brain's text, so `<@U0ALICE>` renders as those
  characters instead of notifying that member. Slack's addressing primitive is in-band —
  `<@id>` written into the text *is* the mention — while every other surface addresses in a
  field of its own, so `GuardedMessage`'s inability to represent a recipient was a claim the
  Slack surface did not keep. Inbound text is already un-escaped for the brain and a mention
  of a third party reaches it as live markup, which made quoting the message that woke the
  agent enough to page whoever it named: through none of the id validation `mentions` gets,
  and recorded on the audit line as `mentions=0`. The recipients the adapter builds from
  `mentions` are still markup — the one part of an outbound message it constructs itself.
  The bulk-mention refusal is unchanged: `<!channel>` is refused, not rendered.

## [0.1.0] - 2026-08-31

First full release of 0.1.0. It is `v0.1.0-rc.2` plus the two entries below —
everything the two release-candidate sections describe is in it, and those sections
stay as the record of when each part arrived.

Published as `ghcr.io/sageox/agent-base:0.1.0`, and this is the first release to take
the floating tags a candidate is refused: `:latest` and `:0.1`. `:0` is not published
at all — before 1.0.0 a minor bump may break you, so a major-only alias would promise
a stability that does not exist. Pin the digest recorded on the GitHub Release in
production; the tags are for humans.

Still pre-1.0: configuration format and CLI flags may move between minor versions.

The Helm chart is 0.9.0, unchanged since rc.2. Both entries below are code rather than
templates — `jobs[].report.probe` is a key an older binary refuses under `.strict()`,
and `announce: reported` is a value outside that binary's enum — so roll the image
before setting either, and no chart bump is needed to render an agent that does.

### Added

- **A job body can post into its report channel, read the answers back, and mint its
  verdict from what it read.** `jobs[].report.probe: true` opens a per-run channel the body
  reaches over HTTP at `JOB_CHANNEL_URL` with `JOB_CHANNEL_TOKEN`, carrying two verbs:
  `post_message`, bounded to the one channel the job declared, and `thread_read`, bounded
  to a root that same run posted. Until now a body's only channel output was the terminal
  verdict the host mints — right for a job that *observes*, and unable to express a job
  that **probes**, where the reply set is knowable from the channel and from nowhere else.
  A fleet roll call is that job: a Deployment can be `Ready` and green while consuming no
  events at all. The listener is opened before the body is spawned and closed when it
  exits, its token is minted per run, and there is no field for a destination — the brain
  is not offered any of it, and a job body is still not an MCP client of the gateway. A
  surface with no thread model refuses the read rather than answering with an empty thread,
  because "nobody replied" and "this surface cannot tell you" are different findings.
  `SurfaceAdapter` gains an optional `readThread`, implemented on Buzz as one REQ on the
  socket it already holds; a job that declares no `probe` is spawned into exactly the
  envelope it had before.

- **A job that is both scheduled and reporting can be heard only when it has something to
  say.** `jobs[].report.announce` gains a third mode, `reported`, which posts a run whose
  body wrote a `detail` on some gate, whatever the verdict, and behaves as `unproven`
  otherwise. Neither existing mode fits a job that ticks every half hour and finds something
  twice a month: `always` makes it a half-hourly "nothing to report" in a channel, and
  `unproven` is structurally silent on the runs that did the work, since a run whose gates
  all passed has nothing unproven to announce. Keying on `detail` is the distinction — gates
  without prose are outcomes the verdict already speaks for, while a `detail` is a sentence
  the body composed for a human. It buys no pass, because the status word in front of that
  sentence is still minted from the verdict, and it lowers no floor: a body that wrote no
  gates is still UNKNOWN and still posts. `unproven` and `always` are unchanged.

## [0.1.0-rc.2] - 2026-08-30

Second release candidate for 0.1.0. Everything below shipped after
`v0.1.0-rc.1`, which was the first published image.

Published as `ghcr.io/sageox/agent-base:0.1.0-rc.2` only. A release candidate takes
no floating tag — not `:latest`, not `:0.1` — so nothing tracking those moves onto
it.

Two of these need this image and not only the chart, because they are code rather
than templates: `jobs[].report.announce` is a manifest key an older binary refuses
under `.strict()`, and `--job-secrets` is a flag an older binary ignores, leaving a
mounted source unsearched. Roll the image before setting either. The Helm chart is
0.9.0; `networkPolicy` and the documented container names need no new image, and a
release that sets none of the new keys renders byte for byte what 0.8.0 rendered.

### Fixed

- **A single-surface agent can be served the top-level post tool.** `post_message` was
  offered only when two or more surfaces named a channel, on the reading that posting is
  always *cross*-posting. It is not: a job has no inbound turn to answer, so the tool is the
  only way it reaches a channel on its own initiative, and `jobs[].report` has always
  reached one through the same `SurfaceEgress.post` call from an egress built on a single
  adapter. The capability now follows the channels — any configured post target will do.
  Adding a surface still grants the tool automatically only at two, so a single-surface
  agent gets it by naming it, never as a side effect. The audit verb is `post_message` to
  match the tool, where it read `cross_post`; the internal `crossPost` flags are
  `postMessage`.

### Added

- **The chart's container names are documented.** `agent`, `job`, and `stage-config`, in a
  table in the chart README, because a cluster add-on that acts on some containers needs
  their names and nothing else stated them. EKS's `eks.amazonaws.com/skip-containers` is the
  case spelled out — excluding `agent` keeps `AWS_ROLE_ARN` out of the container reading
  untrusted channel text — with `podAnnotations` being release-wide, so one value names the
  containers of both Pod kinds. Whether the webhook ignores a name matching no container in
  a given Pod is left explicitly unasserted.

- **A credential only a job needs can be kept off the Pod that runs the brain.**
  `agents.<name>.jobSecrets` is a second secret source, mounted by that agent's CronJob Pods
  alongside `secrets` and searched ahead of it when a job body resolves `run.secrets`. A
  write token that pushes branches was previously a file in the container running an LLM over
  untrusted channel text — unreadable by policy, since the tool policy denies
  `Read(//mnt/secrets-store/**)` and the brain's environment is an allowlist, but a policy is
  a file that can be wrong. What is not in `secrets` is now not in that container at all.
  It adds rather than replaces: a job process resolves the agent's own credentials too, for
  the surface its report is signed with and the switch it is admitted past, and both of those
  swallow a failure to resolve — so swapping the mounts would answer a forgotten credential
  with a disarmed kill switch and a lost report. `resolveSecret`'s `dir` accepts a list for
  this, and `job run` takes `--job-secrets`. Scheduled runs only: a run started on request
  executes in the gateway's own process and fails such a ref by name, which is also what
  stops a prompt-injected turn reaching a write credential through a job it may ask for.
  Chart 0.9.0.

- **A reporting job can be heard without claiming it failed.** `jobs[].report.announce`
  (default `unproven`) decides whether a run that proved itself is still posted. The default
  is today's behaviour exactly — a job that found nothing posts nothing — and is right for a
  job that hunts. It is wrong for a job whose successes are the point: with only the verdict
  to speak through, such a job had to claim it proved nothing to reach its channel, and its
  headline then read `FAILED` over words saying a fix had landed. `always` posts
  whatever the verdict is, so the job can exit 0 for "this went fine" and still be heard.
  It moves nothing else: the status word is still minted by the host, a body still cannot
  write one, and a combined verdict still carries none of the body's words into the
  headline. Neither mode announces a job the kill switch or a suspension refused.

- **An agent can declare the traffic it is allowed.** A release-wide `networkPolicy` block
  renders one NetworkPolicy per agent, covering that agent's Deployment and CronJob Pods,
  with `ingress` and `egress` rules passed through verbatim the way a `bundle.volume` is.
  `policyTypes` is the switch and there is no `enabled` beside it: empty renders no object,
  because a policy that names no direction is a deny-all-ingress rule rather than an inert
  one, and rules written for a direction it does not name are refused at render rather than
  applied and ignored. Enforcement stays the cluster's — where the CNI does not implement
  NetworkPolicy the object applies cleanly and constrains nothing, so this is a declaration
  of intent until you have checked otherwise. Chart 0.8.0.

- **A job may read the Kubernetes API.** `agents.<name>.serviceAccount.automountJobToken`
  (default `false`) mounts the projected ServiceAccount token on that agent's CronJob Pods,
  which is the only credential in-cluster API auth has. The Deployment Pod's
  `automountServiceAccountToken: false` stays unconditional — it runs an LLM over untrusted
  channel text — and the knob is named for the job so no single value can conflate the two.
  Mounting the token grants nothing on its own: bind the reads with your own `Role` and
  `RoleBinding`, which this chart still does not render. Chart 0.7.0.

## [0.1.0-rc.1] - 2026-08-28

First release candidate for 0.1.0, and the first published image. Pre-1.0:
configuration format and CLI flags may still move between minor versions.

Published as `ghcr.io/sageox/agent-base:0.1.0-rc.1` only. A release candidate takes
no floating tag — not `:latest`, not `:0.1` — so nothing tracking those moves onto
it.

### Added

- **One agent across many chat surfaces.** A single process multiplexes Buzz/Nostr, Slack,
  and a local console into one brain and routes each reply back out the way it came in, so
  the agent keeps one identity, one memory, and one face everywhere.
- **A brain that holds no transport or write credential.** The brain can only *request*
  actions, through one guarded chokepoint; the gateway decides and executes. A
  prompt-injected brain can only ask, and every ask meets the tool policy and the guard.
- **MCP servers run inside the gateway**, spawned with the credential in the gateway's own
  process and published to the brain as brokered tools. `mcpServers[].scope` puts a
  fail-closed bound on any server's credential — name an argument and its allowed values,
  and every `tools/call` must carry it. A leak scan runs over every string argument of every
  call, reads included, and refuses on a hit.
- **Memory with a private tier.** Markdown vaults, age encryption, and a shared/private
  split, with vault reads and appends opened `O_NOFOLLOW` so a planted symlink cannot reach
  outside the vault.
- **Jobs.** Anyone may park a job; only a human may arm one, enforced on the write.
- **`sageox-agent create`** — a guided, resumable interview that builds a coherent identity
  (purpose, approval boundary, voice, look) rather than just naming a bot, then offers a
  brain, chat surfaces, memory, and tools. `sageox-agent run` starts a console agent with a
  mock brain and no runtime account, key, or model spend.
- **Deployment.** A Helm chart (`agent`) and Terraform for AWS EKS, against a multi-arch
  image published to `ghcr.io/sageox/agent-base` with a pinnable digest.


### Added

- Jobs may declare `parameters` — typed, bounded values one run is given, for work that
  needs a **target**: which issue, which document, which environment. `mcp__jobs__job_run`
  advertises them on its input schema and refuses a value that does not match at the call;
  the host validates again, so the bound holds on every door, including `job run --param`.
  The body reads them as `JOB_PARAM_<NAME>`, and they are on the run record, which is where
  "what did that run act on" gets answered. Environment, never argv — the command line is
  still `run.command` and `run.args`.

  `integer` (with `minimum`/`maximum`) and `string`, bounded by a closed list of `values` or
  by a `pattern`, exactly one of the two — an unbounded string is the free-form argument this
  tool spent its design avoiding. No boolean: "which" is not a question answered yes or no. A
  job that declares none is started by a slug and nothing else, exactly as before — its
  `job_run` schema does not grow a `params` field at all. A parameter needs
  `trigger.onRequest`, since nothing else can supply one, and a *required* parameter may not
  also arm a schedule or a webhook: neither has a target to give it.

### Changed

- The repository is now `agent-toolkit`, renamed from `buzz-agent-toolkit`. Its packages
  were already `@sageox/agent-toolkit-*`, and no shipped artifact ever carried the old slug
  — the image is `ghcr.io/sageox/agent-base`, the CLI is `sageox-agent`, the chart is
  `agent` — so the cost is a redirect on the old GitHub URL, which keeps working. Existing
  clones need `git remote set-url origin https://github.com/sageox/agent-toolkit.git`;
  nothing in a deployment changes. `docs/naming.md` no longer exempts the repository slug,
  because there is no longer anything to exempt, and `test/naming.test.ts` now checks the
  slug like any other identifier.

- `identity register buzz` no longer ends at a membership-gated relay. It prints **both**
  grants an administrator has to make — `buzz-admin add-member` for relay membership, on
  the relay host, and `buzz channels add-member --role bot` for the channel — then waits and
  re-reads the relay when you say they landed, finishing the registration in the same
  sitting instead of asking for the command to be run again. The wait is a keypress rather
  than a poll: what it is waiting for is a person in another terminal. Each retry is a real
  authenticated call, because a relay can accept the NIP-42 handshake from a key it will
  still not serve, so "the admin says it is done" is not evidence that it is. Non-interactive
  runs behave as before: the handoff is printed and setup continues. `doctor`'s membership
  failure now names the same `buzz-admin add-member --pubkey <npub>` command, since the key
  to admit is the one thing the failure does not otherwise tell you.

- The channel bot role is offered at the prompt, not only printed as a command. After the
  relay accepts the identity, registration asks `Add it to channel <id> now?` and reads the
  channel owner or admin key through the same hidden, one-time prompt `--add-as-bot` uses —
  so the one credential setup asks for that is not the agent's own never reaches a shell
  history. Guided `create` gets it by driving the same command: it picks the channel off the
  relay's own menu, then makes the grant. Decline, or run without a terminal, and the
  complete command is printed exactly as before; a key the relay refuses reports and falls
  back to it rather than failing a registration that already published.

- The channel-role command the handoff prints is now complete: `buzz channels add-member`
  carries neither the relay nor the signing key — both are global `buzz` options, and an
  omitted `--relay` is `http://localhost:3000` — so the bare command granted a role on
  whatever relay the admin's shell defaulted to, or none. It now names the relay and shows
  where the owner key goes, in the environment rather than in argv where `ps` would show it.
  The same command printed at the end of a successful registration was fixed with it.

- Guided `create` offers the same grant and wait at the *surface* step, which is where it
  meets a gated relay one step before registration. It used to fall back to asking someone
  to type channel ids the relay had just refused to show them. Declining still falls back,
  so a relay that cannot be listed for any other reason is unchanged.

- The membership refusal is recognized in the spelling the relay actually sends —
  `403 relay_membership_required`, forwarded verbatim by the `buzz` client — and not only in
  the prose a NIP-42 refusal carries. Unrecognized, it reached guided `create` as an ordinary
  step failure, which re-asked "Publish its profile and join a Buzz channel now?" for as long
  as anyone kept answering yes.

### Removed

- The team brain's `team_kb_list` and `team_kb_show` tools, and the knowledge-bubble
  plumbing behind them — `ox kb` enumerates a feature nobody maintains, and the project
  config the gateway wrote under `.agent-toolkit-ox/<team-id>/` existed only to scope it.
  `team_search` is now the team brain's one tool; it is also the only one that works where
  an agent actually runs, because `ox query` is answered server-side from the token while
  `ox conversation`, `ox session list` and `ox glance` all need a locally synced checkout
  this toolkit does not keep.

### Fixed

- A job body's per-gate `detail` reaches the status post. The field was declared on the
  verdict artifact schema, parsed, and then dropped by `verdictFromGate`, so every threaded
  line under a job's headline read as `FAILED: ci did not pass (gate ci exited 1).` no
  matter what the body wrote — and a linked reference the body put there never reached the
  channel at all. A gate that supplies no `detail` posts exactly what it posted before. The
  status word in front of the line is still the toolkit's, and the headline is still minted
  from the combined verdict, which carries no `detail`, so a body still cannot phrase its
  own PASS.

- `memory add team` lists the teams on the machine again. It read them from
  `ox kb list --json`, which ignores `--json` and prints a table, so the parse threw on
  every call and the listing was silently always empty. It reads `ox team list --json` now,
  puts the primary team first, and leaves out the `<team-id>.bak.<epoch>` clones a restore
  leaves behind — `ox` reports those as teams, but their ids are directory names that no
  deployment can resolve.

### Added

- `memory add team` offers to create a SageOx account when no teams are found on the
  machine, pointing at https://sageox.ai/register and waiting for the team to exist before
  asking for its id. Previously that branch told someone to find the id in an app they had
  no account for.

### Changed

- `memory add team` now asks for the SageOx token even where `ox login` already
  authenticates the workstation. That login lives in the user's config directory rather than
  in the bundle, so a container built from the bundle had no credential and failed every
  `team_search` while still answering — the setup that collected every other credential was
  the one place the deployment's token was never asked for. A blank answer still skips it,
  and `doctor` keeps reporting the gap.

### Not included

- **A separate-container tier.** The brain is a child process, so it shares the gateway's
  filesystem. Credentials are kept out of its *environment*, but that is not a filesystem
  boundary.
