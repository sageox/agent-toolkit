import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import { jobDeadlineMs, jobParams } from "./job-host.ts";
import { admitJob } from "./kill-switch.ts";
import { type JobConfig } from "./manifest.ts";
import { tokenMatches, type ServeOptions } from "./mcp-http.ts";
import { WorkerDiagnosticsSchema, type WorkerDiagnostics } from "./job-diagnostics.ts";
import {
  ExternalRequestSchema, WorkerResultSchema, RunIdSchema, FailureReportSchema, jobDefinition,
  type ExternalRequest, type ExternalStatus,
} from "./external-jobs.ts";

const ObjectName = z.string().regex(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/).max(253);
export const WorkerProfilesSchema = z.record(z.string(), z.object({
  serviceAccountName: ObjectName,
  secrets: z.record(z.string(), z.object({ name: ObjectName, key: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default({}),
  resources: z.object({
    requests: z.record(z.string(), z.string()).optional(),
    limits: z.record(z.string(), z.string()).optional(),
  }).strict().default({}),
}).strict());
type WorkerProfiles = z.infer<typeof WorkerProfilesSchema>;

export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: { name: string; resourceVersion?: string; uid?: string; labels?: Record<string, string>; deletionTimestamp?: string; continue?: string;
    ownerReferences?: { apiVersion: string; kind: string; name: string; uid: string }[] };
  data?: Record<string, string>;
  stringData?: Record<string, string>;
  spec?: Record<string, unknown>;
  items?: KubeObject[];
  status?: {
    phase?: string;
    conditions?: { type: string; status: string; reason?: string }[];
    containerStatuses?: { name: string; state?: {
      waiting?: { reason?: string };
      terminated?: { exitCode: number; signal?: number; reason?: string; startedAt?: string; finishedAt?: string; message?: string };
    } }[];
  };
}

export class KubeError extends Error {
  constructor(readonly status: number) { super(`Kubernetes request failed (${status})`); }
}

/** In-cluster only; no kubectl, kubeconfig, credentials or arbitrary API reach in the gateway. */
export class JobKubeApi {
  constructor(private namespace: string) { ObjectName.parse(namespace); }

  async call(method: string, resource: "configmaps" | "jobs" | "pods" | "secrets", suffix = "", body?: unknown): Promise<KubeObject> {
    const root = "/var/run/secrets/kubernetes.io/serviceaccount";
    const token = readFileSync(`${root}/token`, "utf8").trim(); // projected tokens rotate
    const ca = readFileSync(`${root}/ca.crt`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const path = `${resource === "jobs" ? "/apis/batch/v1" : "/api/v1"}/namespaces/${this.namespace}/${resource}${suffix}`;
    return new Promise((resolve, reject) => {
      const req = httpsRequest(`https://kubernetes.default.svc${path}`, {
        method, ca, headers: {
          authorization: `Bearer ${token}`, "content-type": "application/json",
          ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) req.destroy(new Error("Kubernetes response too large"));
          else chunks.push(chunk);
        });
        res.on("error", () => reject(new Error("Kubernetes response interrupted")));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 300) return reject(new KubeError(res.statusCode ?? 500));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString()) as KubeObject); }
          catch { reject(new Error("invalid Kubernetes response")); }
        });
      });
      req.setTimeout(10_000, () => req.destroy(new Error("Kubernetes request timed out")));
      req.on("error", () => reject(new Error("Kubernetes unavailable")));
      req.end(payload);
    });
  }
}

interface StoredRun {
  request: ExternalRequest;
  status: ExternalStatus;
  deadline: number;
  tokenHash?: string;
  claimed?: boolean;
  cleaned?: boolean;
  job?: JobConfig;
  profile?: WorkerProfiles[string];
}

/** One dispatcher per agent, shared by all its jobs. Every claim is a Kubernetes CAS. */
export class JobDispatcher {
  private label: Record<string, string>;
  constructor(private opts: {
    api: Pick<JobKubeApi, "call">;
    name: string;
    jobs: readonly JobConfig[];
    profiles: WorkerProfiles;
    url: string;
  }) {
    ObjectName.parse(opts.name);
    this.label = { "agent-toolkit/dispatcher": opts.name };
    opts.profiles = WorkerProfilesSchema.parse(opts.profiles);
    for (const job of opts.jobs.filter((job) => job.worker)) {
      const profile = opts.profiles[job.slug];
      if (!profile) throw new Error(`job ${job.slug} has no worker deployment profile`);
      for (const ref of Object.values({ ...job.run.secrets, ...job.run.jobSecrets })) {
        if (!Object.hasOwn(profile.secrets, ref)) throw new Error(`job ${job.slug} has no worker secret mapping for ${ref}`);
      }
    }
  }

  private name(runId: string): string { return `run-${jobDefinition([this.opts.name, RunIdSchema.parse(runId)]).slice(0, 40)}`; }
  private lockName(slug: string): string { return `lock-${jobDefinition([this.opts.name, slug]).slice(0, 40)}`; }
  private read(cm: KubeObject): StoredRun { return JSON.parse(cm.data!.run!) as StoredRun; }
  private async get(resource: "configmaps" | "jobs", name: string): Promise<KubeObject | undefined> {
    try { return await this.opts.api.call("GET", resource, `/${name}`); }
    catch (error) { if (error instanceof KubeError && error.status === 404) return undefined; throw error; }
  }
  private async save(cm: KubeObject, run: StoredRun): Promise<KubeObject> {
    return this.opts.api.call("PUT", "configmaps", `/${cm.metadata.name}`, {
      ...cm, data: { ...cm.data, run: JSON.stringify(run) },
    });
  }
  private async owned(runId: string, slug?: string): Promise<KubeObject> {
    const cm = await this.get("configmaps", this.name(runId));
    if (!cm || cm.metadata.labels?.["agent-toolkit/dispatcher"] !== this.opts.name ||
        (slug !== undefined && this.read(cm).request.jobSlug !== slug)) throw new KubeError(404);
    return cm;
  }

  async dispatch(raw: unknown): Promise<ExternalStatus> {
    const request = ExternalRequestSchema.parse(raw);
    const job = this.opts.jobs.find((job) => job.slug === request.jobSlug);
    if (!job?.worker || request.definition !== jobDefinition(job)) throw new KubeError(400);
    jobParams(job, request.parameters);
    const arms = request.trigger === "on-request" ? job.trigger.onRequest
      : request.trigger === "webhook" ? job.trigger.webhook : job.trigger.schedules.length > 0;
    if (!arms || (request.trigger !== "on-request" && request.requestedBy !== null)) throw new KubeError(400);
    // Reapply the existing automation gates using the gateway's authenticated reading.
    // No caller of the model-facing tool can set either this reading or requestedBy.
    const admission = await admitJob(job, request, async () => {
      const reading = request.switch;
      if (reading?.origin === "set") return { origin: "set", state: reading.state };
      if (reading?.origin === "never-set") return { origin: "never-set" };
      return { origin: "unreadable", failure: reading?.failure ?? "backend-missing" };
    });
    if (!admission.admitted || admission.bypassedSwitch !== request.bypassedSwitch) throw new KubeError(403);
    const name = this.name(request.runId);
    const run: StoredRun = {
      request, job, profile: this.opts.profiles[job.slug]!, deadline: request.startedAt + jobDeadlineMs(job),
      status: { runId: request.runId, jobSlug: job.slug, startedAt: request.startedAt, state: "pending", diagnostics: { ref: name, complete: false } },
    };
    try {
      await this.opts.api.call("POST", "configmaps", "", {
        apiVersion: "v1", kind: "ConfigMap", metadata: { name, labels: { ...this.label, "agent-toolkit/run": "true" } },
        data: { run: JSON.stringify(run), diagnostics: JSON.stringify({
          runId: request.runId, jobSlug: job.slug, image: job.worker.image, admittedAt: request.startedAt, complete: false,
        }) },
      });
    } catch (error) {
      if (!(error instanceof KubeError) || error.status !== 409) throw error;
      const previous = this.read(await this.owned(request.runId, job.slug)).request;
      const { startedAt: _before, ...before } = previous;
      const { startedAt: _after, ...after } = request;
      // Same admitted request may be retried; the ID cannot be reused for other inputs.
      if (jobDefinition(before) !== jobDefinition(after)) throw new KubeError(409);
    }
    // Admission is durable before the response. Only the reconciler can create a Job.
    return this.status(job.slug, request.runId);
  }

  async status(slug: string, runId: string): Promise<ExternalStatus> {
    return this.read(await this.owned(runId, slug)).status;
  }

  /** A bounded excerpt for automatic chat reports; the full archive stays operator-only. */
  async failureReport(slug: string, runId: string): Promise<string> {
    const cm = await this.owned(runId, slug);
    const { status } = this.read(cm);
    const counts = status.result?.counts;
    if (status.state !== "finished" || (counts && counts.PASS > 0 && !counts.FAIL && !counts.UNKNOWN)) throw new KubeError(409);
    const diagnostics: Partial<WorkerDiagnostics> & { workers?: { reason?: string }[] } = JSON.parse(cm.data?.diagnostics ?? "{}");
    let reasons = diagnostics.workers?.map((worker) => worker.reason);
    if (!reasons) {
      // Reporting may beat cleanup, which normally archives these platform facts.
      const pods = await this.opts.api.call("GET", "pods", `?labelSelector=${encodeURIComponent(`batch.kubernetes.io/job-name=${cm.metadata.name}`)}`);
      reasons = pods.items?.slice(0, 2).map((pod) => {
        const state = pod.status?.containerStatuses?.find((c) => c.name === "worker")?.state;
        return state?.waiting?.reason ?? state?.terminated?.reason;
      });
    }
    const platform = [...new Set(reasons?.filter((reason) => reason && reason !== "Completed" && /^[A-Za-z0-9]{1,64}$/.test(reason)))].join(", ");
    const source = diagnostics.stderr?.text.trim() ? "stderr" : "stdout";
    const stream = diagnostics[source];
    const text = (stream?.text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").trimEnd();
    const notes = ["redacted job output", ...(!diagnostics.complete ? ["partial checkpoint"] : []),
      ...(stream?.truncated || text.length > 1600 ? ["earlier output omitted"] : [])].join("; ");
    // Quote job text as data, and prevent a script's backticks from closing the fence.
    const excerpt = text.slice(-1600).replace(/^[\uDC00-\uDFFF]/, "").replace(/`/g, "'");
    return FailureReportSchema.parse((platform ? `Worker state: ${platform}.\n` : "") +
      (excerpt ? `Last ${source} (${notes}):\n\`\`\`\n${excerpt}\n\`\`\`` : "The worker did not retain error output."));
  }

  async cancel(slug: string, runId: string): Promise<ExternalStatus> {
    for (let attempt = 0; ; attempt++) {
      const cm = await this.owned(runId, slug);
      const run = this.read(cm);
      if (run.status.state === "finished" || run.status.outcome === "cancelled") return run.status;
      run.status.state = "cancelling";
      run.status.outcome = "cancelled";
      try { await this.save(cm, run); return run.status; }
      catch (error) {
        if (!(error instanceof KubeError && error.status === 409) || attempt >= 2) throw error;
      }
    }
  }

  /** At-most-one body start, even if Kubernetes creates a replacement Pod. Never replay a claim. */
  async claim(runId: string, token: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const cm = await this.owned(runId);
      const run = this.read(cm);
      if (!run.tokenHash || !tokenMatches(createHash("sha256").update(token).digest("hex"), run.tokenHash)) throw new KubeError(401);
      if (run.claimed || !["dispatching", "running"].includes(run.status.state) || Date.now() >= run.deadline) throw new KubeError(409);
      run.claimed = true;
      try { await this.save(cm, run); return; }
      catch (error) {
        // Retry only a rejected CAS, never an ambiguous write or an already-taken claim.
        if (!(error instanceof KubeError && error.status === 409) || attempt >= 2) throw error;
      }
    }
  }

  /** Write-only for the claimed worker. The gateway capability cannot write logs. */
  async recordDiagnostics(runId: string, token: string, raw: unknown): Promise<void> {
    const diagnostics = WorkerDiagnosticsSchema.parse(raw);
    for (let attempt = 0; ; attempt++) {
      const cm = await this.owned(runId);
      const run = this.read(cm);
      if (!run.tokenHash || !tokenMatches(createHash("sha256").update(token).digest("hex"), run.tokenHash)) throw new KubeError(401);
      if (!run.claimed || run.cleaned) throw new KubeError(409);
      if (run.status.state === "finished" && !diagnostics.complete) throw new KubeError(409);
      const previous = JSON.parse(cm.data!.diagnostics!);
      if (diagnostics.sequence <= (previous.sequence ?? -1) || previous.complete) return;
      cm.data!.diagnostics = JSON.stringify({ ...previous, ...diagnostics });
      run.status.execution = diagnostics.execution;
      run.status.diagnostics = { ref: cm.metadata.name, complete: diagnostics.complete };
      try { await this.save(cm, run); return; }
      catch (error) {
        if (!(error instanceof KubeError && error.status === 409) || attempt >= 2) throw error;
      }
    }
  }

  private async removeJob(cm: KubeObject, run: StoredRun): Promise<KubeObject | undefined> {
    const name = cm.metadata.name;
    const worker = await this.get("jobs", name);
    const pods = await this.opts.api.call("GET", "pods", `?labelSelector=${encodeURIComponent(`batch.kubernetes.io/job-name=${name}`)}`);
    if (cm.data?.diagnostics && pods.items?.length) {
      const diagnostics = JSON.parse(cm.data.diagnostics);
      const workers = pods.items.slice(0, 2).map((pod) => {
        const state = pod.status?.containerStatuses?.find((c) => c.name === "worker")?.state;
        const ended = state?.terminated;
        return { pod: pod.metadata.name, phase: pod.status?.phase, reason: state?.waiting?.reason ?? ended?.reason,
          exitCode: ended?.exitCode, signal: ended?.signal, startedAt: ended?.startedAt, endedAt: ended?.finishedAt };
      });
      if (JSON.stringify(workers) !== JSON.stringify(diagnostics.workers)) {
        cm.data.diagnostics = JSON.stringify({ ...diagnostics, workers });
        cm = await this.save(cm, run); // persist platform facts before Pod deletion
      }
    }
    if (worker) {
      try { await this.opts.api.call("DELETE", "jobs", `/${name}`, { propagationPolicy: "Foreground" }); }
      catch (error) { if (!(error instanceof KubeError) || error.status !== 404) throw error; }
      return undefined;
    }
    return pods.items?.some((pod) => !["Succeeded", "Failed"].includes(pod.status?.phase ?? "")) ? undefined : cm;
  }

  private async release(run: StoredRun): Promise<void> {
    const name = this.lockName(run.request.jobSlug);
    const lock = await this.get("configmaps", name);
    if (lock?.data?.runId === run.request.runId) {
      await this.opts.api.call("DELETE", "configmaps", `/${name}`, {
        preconditions: { uid: lock.metadata.uid, resourceVersion: lock.metadata.resourceVersion },
      });
    }
  }

  private async finish(cm: KubeObject, run: StoredRun, outcome: ExternalStatus["outcome"]): Promise<void> {
    run.status = { ...run.status, state: "finished", outcome, endedAt: Date.now() };
    // Retain results independently of Pod cleanup. Never release a lock before this write.
    await this.save(cm, run);
  }

  private workerJob(cm: KubeObject, run: StoredRun): KubeObject {
    const job = run.job!;
    const profile = run.profile!;
    const refs = [...new Set(Object.values({ ...job.run.secrets, ...job.run.jobSecrets }))];
    return {
      apiVersion: "batch/v1", kind: "Job", metadata: { name: cm.metadata.name, labels: this.label },
      spec: {
        backoffLimit: 0, completions: 1, parallelism: 1, podReplacementPolicy: "Failed",
        activeDeadlineSeconds: Math.max(1, Math.ceil((run.deadline - Date.now()) / 1000)),
        template: {
          metadata: { labels: { ...this.label, "agent-toolkit/run-id": run.request.runId } },
          spec: {
            restartPolicy: "Never", automountServiceAccountToken: false,
            serviceAccountName: profile.serviceAccountName,
            terminationGracePeriodSeconds: Math.ceil(job.budget.deadlineHeadroomMs / 1000),
            securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
            containers: [{
              name: "worker", image: job.worker!.image,
              command: ["/app/bin/sageox-agent"], args: ["job", "worker", "/run/job/run"],
              workingDir: job.worker!.directory,
              env: [
                { name: "AGENT_JOB_DISPATCHER_URL", value: this.opts.url },
                ...refs.map((ref) => ({ name: ref, valueFrom: { secretKeyRef: profile.secrets[ref] } })),
              ],
              resources: profile.resources,
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              terminationMessagePath: "/dev/termination-log", terminationMessagePolicy: "File",
              volumeMounts: [{ name: "run", mountPath: "/run/job", readOnly: true }],
            }],
            volumes: [{ name: "run", projected: { sources: [
              { configMap: { name: cm.metadata.name, items: [{ key: "run", path: "run" }] } },
              { secret: { name: cm.metadata.name, items: [{ key: "token", path: "token" }] } },
            ] } }],
          },
        },
      },
    };
  }

  async reconcile(): Promise<void> {
    const selector = `agent-toolkit/dispatcher=${this.opts.name}`;
    let cursor = "";
    do {
      const list = await this.opts.api.call("GET", "configmaps", `?limit=25&labelSelector=${encodeURIComponent(selector)}&continue=${encodeURIComponent(cursor)}`);
      for (const cm of list.items ?? []) {
        try {
          if (cm.data?.runId) {
            // A stale pending reader can acquire a lock after cancellation and cleanup.
            // Reconcile the few extant locks too, without probing every retained tombstone.
            const run = this.read(await this.owned(cm.data.runId));
            if (run.cleaned) await this.release(run);
          } else if (cm.metadata.labels?.["agent-toolkit/run"] === "true") await this.reconcileRun(cm);
        }
        catch (error) {
          if (!(error instanceof KubeError && [404, 409].includes(error.status))) {
            // No API response, body output or secrets in logs.
            console.warn(`job_dispatcher run=${cm.metadata.name} reconciliation unavailable`);
          }
        }
      }
      cursor = list.metadata.continue ?? "";
    } while (cursor);
  }

  private async reconcileRun(cm: KubeObject): Promise<void> {
    let run = this.read(cm);
    const name = cm.metadata.name;
    if (run.status.state === "finished") {
      if (!run.cleaned) {
        const cleared = await this.removeJob(cm, run);
        if (!cleared) return;
        cm = cleared;
        await this.release(run);
      }
      if (!run.cleaned || ((run.status.result || cm.data?.diagnostics) && Date.now() - run.status.endedAt! > 7 * 86400_000)) {
        run.cleaned = true;
        delete run.job;
        delete run.profile;
        delete run.tokenHash;
        if (Date.now() - run.status.endedAt! > 7 * 86400_000) {
          delete run.status.result;
          delete run.status.execution;
          delete run.status.diagnostics;
          delete cm.data!.diagnostics;
          run.status.outcome = "unknown";
        }
        await this.save(cm, run);
      }
      return;
    }
    const worker = ["dispatching", "running"].includes(run.status.state) ? await this.get("jobs", name) : undefined;
    const terminal = worker?.status?.conditions?.find((c) => ["Complete", "Failed"].includes(c.type) && c.status === "True");
    // Recover a terminal worker before applying today's clock: it may have finished
    // within budget while the dispatcher was offline.
    if (run.status.state === "cancelling" || (!terminal && Date.now() >= run.deadline)) {
      if (run.status.state !== "cancelling") {
        run.status.state = "cancelling";
        run.status.outcome = "budget-bowout";
        cm = await this.save(cm, run);
      }
      const cleared = await this.removeJob(cm, run);
      if (cleared) await this.finish(cleared, run, run.status.outcome);
      return;
    }
    if (run.status.state === "pending") {
      const lockName = this.lockName(run.request.jobSlug);
      try {
        await this.opts.api.call("POST", "configmaps", "", {
          apiVersion: "v1", kind: "ConfigMap", metadata: { name: lockName, labels: this.label }, data: { runId: run.request.runId },
        });
      } catch (error) {
        if (!(error instanceof KubeError) || error.status !== 409) throw error;
        const lock = await this.get("configmaps", lockName);
        if (lock?.data?.runId !== run.request.runId) {
          await this.finish(cm, run, "skipped-overlap");
          return;
        }
      }
      run.status.state = "dispatching";
      const token = randomBytes(32).toString("hex");
      run.tokenHash = createHash("sha256").update(token).digest("hex");
      cm = await this.save(cm, run); // winner alone may send one create
      const created = await this.opts.api.call("POST", "jobs", "", this.workerJob(cm, run));
      // The Pod waits for this Secret. A lost create response never authorizes a retry.
      // Job ownership also garbage-collects a Secret created after concurrent cancellation.
      if (!created.metadata.uid) throw new Error("worker Job identity missing");
      await this.opts.api.call("POST", "secrets", "", {
        apiVersion: "v1", kind: "Secret", metadata: { name, labels: this.label,
          ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name, uid: created.metadata.uid }] },
        stringData: { token },
      });
      // Do not write running here: the worker may already have claimed with a new RV.
      return;
    }
    if (!worker) {
      // A create may have reached the API before its connection was lost. Never recreate
      // it. Keep the lock through the deadline, when a late creation can no longer run.
      return;
    }
    if (!terminal) {
      if (run.status.state === "dispatching") {
        run.status.state = "running";
        await this.save(cm, run);
      }
      return;
    }
    const pods = await this.opts.api.call("GET", "pods", `?labelSelector=${encodeURIComponent(`batch.kubernetes.io/job-name=${name}`)}`);
    // A worker may have claimed or been cancelled while the API reads were in flight.
    cm = await this.owned(run.request.runId);
    run = this.read(cm);
    if (run.status.state === "cancelling" || run.status.state === "finished") return;
    const terminated = pods.items?.length === 1 && pods.items[0]?.status?.containerStatuses?.find((c) => c.name === "worker")?.state?.terminated;
    let result;
    try {
      if (run.claimed && terminated && terminated.exitCode === 0 && (terminated.message?.length ?? 0) <= 4096) {
        result = WorkerResultSchema.parse(JSON.parse(terminated.message ?? ""));
      }
    } catch { /* A lost or corrupt result is unknown, never a successful container exit. */ }
    if (result) {
      run.status.result = result;
      if (result.execution) run.status.execution = result.execution;
    }
    await this.finish(cm, run, result?.outcome ?? (terminal.reason === "DeadlineExceeded" ? "budget-bowout" : "unknown"));
  }
}

/** Private deployment API; distinct from the policy-checked jobs MCP listener. */
export async function serveJobDispatcher(dispatcher: JobDispatcher, token: string, opts: ServeOptions = {}) {
  if (token.length < 32) throw new Error("dispatcher token must be at least 32 characters");
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.origin) throw new KubeError(403);
      const url = new URL(req.url ?? "/", "http://dispatcher");
      const claim = /^\/runs\/([a-f0-9]{40})\/claim$/.exec(url.pathname);
      const diagnostics = req.method === "POST" && /^\/runs\/([a-f0-9]{40})\/diagnostics$/.exec(url.pathname);
      const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (claim && req.method === "POST") {
        await dispatcher.claim(claim[1]!, bearer);
        res.writeHead(204).end();
        return;
      }
      if (!diagnostics && !tokenMatches(bearer, token)) throw new KubeError(401);
      let body = "";
      req.setEncoding("utf8");
      for await (const chunk of req) {
        body += String(chunk);
        if (Buffer.byteLength(body) > (diagnostics ? 128 : 32) * 1024) throw new KubeError(413);
      }
      if (diagnostics) {
        await dispatcher.recordDiagnostics(diagnostics[1]!, bearer, JSON.parse(body));
        res.writeHead(204).end();
        return;
      }
      const run = /^\/runs\/([a-f0-9]{40})(\/cancel)?$/.exec(url.pathname);
      const report = /^\/runs\/([a-f0-9]{40})\/failure-report$/.exec(url.pathname);
      let status;
      if (url.pathname === "/runs" && req.method === "POST") status = await dispatcher.dispatch(JSON.parse(body));
      else if (report && req.method === "GET") status = await dispatcher.failureReport(url.searchParams.get("job") ?? "", report[1]!);
      else if (run && !run[2] && req.method === "GET") status = await dispatcher.status(url.searchParams.get("job") ?? "", run[1]!);
      else if (run?.[2] && req.method === "POST") {
        const args = z.object({ jobSlug: z.string() }).strict().parse(JSON.parse(body));
        status = await dispatcher.cancel(args.jobSlug, run[1]!);
      } else throw new KubeError(404);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(status));
    } catch (error) {
      res.writeHead(error instanceof KubeError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503)
        .end("job request unavailable or refused");
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8090, opts.host ?? "0.0.0.0", resolve);
  });
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void dispatcher.reconcile().catch(() => console.warn("job_dispatcher reconciliation unavailable"))
      .finally(() => { polling = false; });
  }, 1000);
  return {
    port: (server.address() as { port: number }).port,
    close: async () => {
      clearInterval(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
