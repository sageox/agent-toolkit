import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { JobDispatcher, KubeError, serveJobDispatcher, type KubeObject } from "../src/job-dispatcher.ts";
import { ExternalJobs, externalRun, jobDefinition, workerResult, publishJobOutput, type ExternalRequest, type ExternalStatus } from "../src/external-jobs.ts";
import { JOB_STATUS_LIMIT_BYTES, type FinalJobOutput } from "../src/job-output.ts";
import { JobSchema, loadManifest, type JobConfig } from "../src/manifest.ts";
import { JobHost, describeJobRun } from "../src/job-host.ts";
import { jobHandler } from "../src/job-server.ts";
import { ToolPolicy } from "../src/tool-policy.ts";
import type { EventRef, InboundEvent } from "../src/events.ts";
import { type WorkerDiagnostics } from "../src/job-diagnostics.ts";

// An API model, not an in-memory dispatcher: enforce resource versions and independent
// objects so two dispatcher instances contend on the same authoritative state.
class Cluster {
  objects = new Map<string, KubeObject>();
  created = 0;
  version = 0;
  loseCreate = false;
  holdDeletion = false;
  async call(method: string, resource: "configmaps" | "jobs" | "pods" | "secrets", suffix = "", body?: unknown): Promise<KubeObject> {
    const value = structuredClone(body) as KubeObject;
    const name = suffix.startsWith("/") ? suffix.slice(1) : value?.metadata?.name;
    const key = `${resource}/${name}`;
    const old = this.objects.get(key);
    if (resource === "secrets" && method !== "POST") throw new KubeError(403);
    if (method === "GET" && (!suffix || suffix.startsWith("?"))) {
      const selector = new URLSearchParams(suffix.slice(1)).get("labelSelector");
      const items = [...this.objects.entries()].filter(([key, obj]) => key.startsWith(`${resource}/`) &&
        (!selector || selector.split(",").every((pair) => { const [k, v] = pair.split("="); return obj.metadata.labels?.[k!] === v; })))
        .map(([, value]) => structuredClone(value));
      return { metadata: { name: "" }, items };
    }
    if (method === "GET") { if (!old) throw new KubeError(404); return structuredClone(old); }
    if (method === "POST" && old) throw new KubeError(409);
    if (method === "PUT" && (!old || value.metadata.resourceVersion !== old.metadata.resourceVersion)) throw new KubeError(409);
    if (method === "DELETE") {
      if (!old) throw new KubeError(404);
      const { preconditions } = body as { preconditions?: { uid?: string; resourceVersion?: string } };
      if (preconditions && (preconditions.uid !== old.metadata.uid || preconditions.resourceVersion !== old.metadata.resourceVersion)) throw new KubeError(409);
      if (resource === "jobs" && this.holdDeletion) return old;
      this.objects.delete(key);
      if (resource === "jobs") {
        for (const [key, secret] of this.objects) if (key.startsWith("secrets/") && secret.metadata.ownerReferences?.some((owner) => owner.uid === old.metadata.uid)) this.objects.delete(key);
        for (const [key, pod] of this.objects) if (key.startsWith("pods/") && pod.metadata.labels?.["batch.kubernetes.io/job-name"] === name) this.objects.delete(key);
      }
      return old;
    }
    value.metadata.resourceVersion = String(++this.version);
    value.metadata.uid ??= `uid-${this.version}`;
    this.objects.set(key, value);
    if (resource === "jobs" && method === "POST") {
      this.created++;
      if (this.loseCreate) throw new Error("connection lost after persisted creation");
    }
    return structuredClone(value);
  }
}

const runName = (id: string) => `run-${jobDefinition(["demo-dispatcher", id]).slice(0, 40)}`;
const runToken = (api: Cluster, id: string) => api.objects.get(`secrets/${runName(id)}`)!.stringData!.token!;
const image = `example/worker@sha256:${"a".repeat(64)}`;
const manifest = (extra = "") => loadManifest(`
name: demo
brain: {provider: mock}
surfaces: [{kind: console}]
respondTo: anyone
brains: [{preset: local}]
killSwitchParkBy: []
jobs:
  - slug: task
    archetype: queue
    description: Bounded task
    trigger: {onRequest: true, schedules: ["0 * * * *"]}
    killSwitch: {failDirection: closed}
    budget: {wallClockMs: 10000, deadlineHeadroomMs: 1000}
    worker: {image: "${image}", directory: /work}
    run: {command: python3, args: [task.py], jobSecrets: {API_TOKEN: TASK_TOKEN}}
    ${extra}
`);
const request = (job: JobConfig, id = "a"): ExternalRequest => ({
  jobSlug: job.slug, runId: id.repeat(40), definition: jobDefinition(job),
  trigger: "on-request", requestedBy: { kind: "human", id: "owner" },
  startedAt: Date.now(), parameters: {}, switch: { origin: "set", state: "off" }, bypassedSwitch: true,
});
const dispatcher = (api: Cluster, jobs = manifest().jobs) => new JobDispatcher({
  api, name: "demo-dispatcher", jobs, url: "http://dispatcher:8090",
  profiles: { task: { serviceAccountName: "task-worker", secrets: { TASK_TOKEN: { name: "task-secret", key: "token" } }, resources: {} } },
});
async function completed(api: Cluster, dispatch: JobDispatcher, req: ExternalRequest, message?: string, reconcile = true) {
  const name = runName(req.runId);
  const raw = JSON.parse(api.objects.get(`configmaps/${name}`)!.data!.run!);
  if (!raw.claimed) await dispatch.claim(req.runId, runToken(api, req.runId));
  api.objects.get(`jobs/${name}`)!.status = { conditions: [{ type: "Complete", status: "True" }] };
  api.objects.set("pods/worker", {
    metadata: { name: "worker", labels: { "batch.kubernetes.io/job-name": name, "agent-toolkit/run-id": req.runId } },
    status: { phase: "Succeeded", containerStatuses: [{ name: "worker", state: { terminated: { exitCode: 0, message } } }] },
  });
  if (reconcile) await dispatch.reconcile();
}

afterEach(() => vi.restoreAllMocks());

describe("durable application output", () => {
  const answer: FinalJobOutput = { state: "available", value: { version: 1, data: { records: [{ id: 42, title: "confidential-result" }] } } };
  const summary = JSON.stringify({ outcome: "completed", counts: { PASS: 2, FAIL: 0, UNKNOWN: 0 } });

  it("publishes once, survives cleanup/restart, expires without replay and keeps payload out of other records", async () => {
    const api = new Cluster(), job = manifest("output: {format: json}").jobs[0]!, a = dispatcher(api, [job]);
    const req = { ...request(job), outputReader: "f".repeat(64) };
    await a.dispatch(req); await a.reconcile();
    const token = runToken(api, req.runId);
    await a.claim(req.runId, token);
    await Promise.all([a.recordOutput(req.runId, token, answer), dispatcher(api, [job]).recordOutput(req.runId, token, answer)]);
    await expect(a.recordOutput(req.runId, token, { state: "missing" })).rejects.toThrow();
    expect((await a.status(job.slug, req.runId, req.outputReader)).output).toEqual({ state: "pending" });
    await completed(api, a, req, summary);
    await a.recordOutput(req.runId, token, answer); // lost final acknowledgement is idempotent
    await a.reconcile(); await a.reconcile();
    expect(api.objects.has(`jobs/${runName(req.runId)}`)).toBe(false);
    const b = dispatcher(api, [job]);
    const status = await b.status(job.slug, req.runId);
    expect(status.output).toEqual({ state: "available" });
    expect((await b.status(job.slug, req.runId, req.outputReader)).output).toEqual(answer);
    const cm = api.objects.get(`configmaps/${runName(req.runId)}`)!;
    expect(cm.data!.run).not.toContain("confidential-result");
    expect(cm.data!.diagnostics).not.toContain("confidential-result");
    expect(JSON.stringify(externalRun(req, status))).not.toContain("confidential-result");
    await expect(b.status("another-job", req.runId, req.outputReader)).rejects.toThrow();
    await expect(b.status(job.slug, req.runId, "e".repeat(64))).rejects.toThrow();
    await expect(new JobDispatcher({ api, name: "another-agent", jobs: [], profiles: {}, url: "http://dispatcher" })
      .status(job.slug, req.runId, req.outputReader)).rejects.toThrow();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 86400_000);
    expect((await b.status(job.slug, req.runId, req.outputReader)).output).toEqual({ state: "expired" });
    await b.reconcile();
    expect(api.objects.get(`configmaps/${runName(req.runId)}`)!.data!.output).toBeUndefined();
    expect((await b.status(job.slug, req.runId, req.outputReader)).output).toEqual({ state: "expired" });
    await b.dispatch(req); await b.reconcile();
    expect(api.created).toBe(1);
  });

  it.each(["missing", "invalid", "oversized", "interrupted", "blocked", "unavailable"] as const)("retains successful execution and gates with %s output", async (state) => {
    const api = new Cluster(), job = manifest("output: {format: json}").jobs[0]!, a = dispatcher(api, [job]), req = request(job);
    await a.dispatch(req); await a.reconcile();
    await a.claim(req.runId, runToken(api, req.runId));
    if (state !== "unavailable") await a.recordOutput(req.runId, runToken(api, req.runId), { state });
    await completed(api, a, req, summary);
    expect(await a.status(job.slug, req.runId, "operator")).toMatchObject({
      outcome: "completed", result: { counts: { PASS: 2 } }, output: { state },
    });
    await a.dispatch(req); await a.reconcile();
    expect(api.created).toBe(1);
  });

  it("rejects unclaimed, cross-run, undeclared, oversized and forged publications", async () => {
    const api = new Cluster(), job = manifest("output: {format: json}").jobs[0]!, a = dispatcher(api, [job]), req = request(job);
    await a.dispatch(req); await a.reconcile();
    const token = runToken(api, req.runId);
    await expect(a.recordOutput(req.runId, token, answer)).rejects.toThrow();
    await a.claim(req.runId, token);
    const other = request(job, "b");
    await a.dispatch(other);
    await expect(a.recordOutput(other.runId, token, answer)).rejects.toThrow();
    await expect(a.recordOutput(req.runId, "gateway-token", answer)).rejects.toThrow();
    for (const forged of [
      { ...answer, counts: { PASS: 999 } }, { ...answer, runId: other.runId },
      { state: "available", value: { version: 1, data: "界".repeat(6000) } },
    ]) await expect(a.recordOutput(req.runId, token, forged)).rejects.toThrow();
    expect((await a.status(job.slug, req.runId)).result).toBeUndefined();
    const legacy = manifest().jobs[0]!, oldApi = new Cluster(), old = dispatcher(oldApi, [legacy]), oldReq = request(legacy);
    await old.dispatch(oldReq); await old.reconcile(); await old.claim(oldReq.runId, runToken(oldApi, oldReq.runId));
    await expect(old.recordOutput(oldReq.runId, runToken(oldApi, oldReq.runId), answer)).rejects.toThrow();
  });

  it("never advertises an unpersisted answer, even after a failed write or cancellation", async () => {
    const api = new Cluster(), job = manifest("output: {format: json}").jobs[0]!, a = dispatcher(api, [job]), req = request(job);
    await a.dispatch(req); await a.reconcile(); await a.claim(req.runId, runToken(api, req.runId));
    const call = api.call.bind(api);
    const save = vi.spyOn(api, "call").mockImplementation(async (...args) => {
      if (args[0] === "PUT") throw new Error("store unavailable");
      return call(...args);
    });
    await expect(a.recordOutput(req.runId, runToken(api, req.runId), answer)).rejects.toThrow();
    save.mockRestore();
    expect((await a.status(job.slug, req.runId, "operator")).output).toEqual({ state: "pending" });
    const token = runToken(api, req.runId);
    await a.cancel(job.slug, req.runId);
    await expect(a.recordOutput(req.runId, token, answer)).rejects.toThrow();
    await a.reconcile(); await a.reconcile();
    expect(await a.status(job.slug, req.runId, "operator")).toMatchObject({ outcome: "cancelled", output: { state: "unavailable" } });
    await a.dispatch(req); await a.reconcile();
    expect(api.created).toBe(1);
  });

  it("reports lost or corrupt persisted output explicitly", async () => {
    const api = new Cluster(), job = manifest("output: {format: json}").jobs[0]!, a = dispatcher(api, [job]), req = request(job);
    await a.dispatch(req); await a.reconcile(); await a.claim(req.runId, runToken(api, req.runId));
    await a.recordOutput(req.runId, runToken(api, req.runId), answer);
    await completed(api, a, req, summary);
    for (const corrupt of [undefined, "{", "null", JSON.stringify({ version: 1, data: "changed after publication" })]) {
      api.objects.get(`configmaps/${runName(req.runId)}`)!.data!.output = corrupt!;
      expect((await a.status(job.slug, req.runId, "operator")).output).toEqual({ state: "unavailable" });
    }
  });

  it("retries delivery after a lost acknowledgement without executing again", async () => {
    const api = new Cluster(), job = manifest("output: {format: json}").jobs[0]!, a = dispatcher(api, [job]), req = request(job);
    await a.dispatch(req); await a.reconcile(); await a.claim(req.runId, runToken(api, req.runId));
    const server = await serveJobDispatcher(a, "gateway-token".repeat(3), { host: "127.0.0.1", port: 0 });
    const record = a.recordOutput.bind(a);
    let calls = 0;
    vi.spyOn(a, "recordOutput").mockImplementation(async (...args) => {
      await record(...args);
      if (++calls === 1) throw new Error("response lost after persistence");
    });
    try {
      expect(await publishJobOutput(`http://127.0.0.1:${server.port}`, runToken(api, req.runId), req.runId, answer)).toBe(true);
      expect(calls).toBe(2);
      expect(api.created).toBe(1);
    } finally { await server.close(); }
  });

  it("returns structured answers through authenticated job_status only to the original reader and conversation", async () => {
    const api = new Cluster(), job = manifest("output: {format: json}").jobs[0]!, a = dispatcher(api, [job]);
    const token = "private-gateway-token".repeat(3);
    const server = await serveJobDispatcher(a, token, { host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${server.port}`, remote = new ExternalJobs(url, token);
    const onRun = vi.fn(), reply = vi.fn(async () => {});
    let host = new JobHost({ external: remote, onRun, switchSource: async () => ({ origin: "set", state: "off" }) });
    const home: InboundEvent = { id: { surface: "slack", nativeId: "message" }, surface: "slack",
      channel: { surface: "slack", id: "private", isPublic: false },
      author: { surface: "slack", id: "owner", isSelf: false, isAgent: false }, text: "lookup", mentionsMe: true, ts: "", raw: null };
    let current: InboundEvent | null = home;
    const handler = (policy = new ToolPolicy(["mcp__jobs__*"], [])) => jobHandler({ jobs: [job], host, agentName: "demo", owner: ["owner"],
      answering: () => current, reply, turnTimeoutMs: 120000, policy });
    try {
      const start = JSON.stringify(await handler()({ method: "tools/call", params: { name: "job_run", arguments: { job: job.slug } } }));
      const id = /run id ([a-f0-9]{40})/.exec(start)![1]!;
      await a.reconcile();
      const req: ExternalRequest = JSON.parse(api.objects.get(`configmaps/${runName(id)}`)!.data!.run!).request;
      const workerToken = runToken(api, id);
      await a.claim(id, workerToken);
      expect(await publishJobOutput(url, workerToken, id, answer)).toBe(true);
      const spoofed = await fetch(`${url}/runs/${id}/output`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(answer) });
      expect(spoofed.status).toBe(401);
      for (const readerToken of [workerToken, "brain-token"]) {
        await expect(new ExternalJobs(url, readerToken).status(job.slug, id, undefined, "operator")).rejects.toThrow();
      }
      await completed(api, a, req, summary);
      await vi.waitFor(() => expect(onRun).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(JSON.stringify(onRun.mock.calls)).not.toContain("confidential-result");
      expect(JSON.stringify(reply.mock.calls)).not.toContain("confidential-result");
      await host.abandon();
      host = new JobHost({ external: new ExternalJobs(url, token) }); // no in-memory ownership survives
      await a.reconcile(); await a.reconcile();
      const statusCall = (includeOutput = false) => ({ method: "tools/call", params: { name: "job_status", arguments: { job: job.slug, runId: id, includeOutput } } });
      expect(JSON.stringify(await handler()(statusCall()))).not.toContain("confidential-result");
      const result = await handler()(statusCall(true)) as { content: { text: string }[] };
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ verdict: "PASS", output: answer });
      // Replies in the original thread retain access after restart.
      current = { ...home, id: { surface: "slack", nativeId: "followup" }, threadRoot: home.id };
      expect(JSON.stringify(await handler()(statusCall(true)))).toContain("confidential-result");
      await expect(handler(new ToolPolicy([], ["mcp__jobs__job_status"]))(statusCall(true))).rejects.toThrow("refused");
      for (const stranger of [null, { ...home, author: { ...home.author, id: "other" } },
        { ...home, channel: { ...home.channel, id: "public", isPublic: true } },
        { ...home, threadRoot: { surface: "slack", nativeId: "other-thread" } }, { ...home, surface: "buzz" }]) {
        current = stranger;
        await expect(handler()(statusCall(true))).rejects.toThrow();
        expect(JSON.stringify(await handler()(statusCall()))).not.toContain("confidential-result");
      }
      current = home;
      const status = host.status.bind(host);
      vi.spyOn(host, "status").mockImplementation(async (...args) => { const result = await status(...args); current = null; return result; });
      await expect(handler()(statusCall(true))).rejects.toThrow("lost its originating conversation");
    } finally { await host.abandon(); await server.close(); }
  });

  it("bounds transport bytes and rejects interrupted responses without treating them as answers", async () => {
    const server = createServer((req, res) => {
      if (req.url?.includes("output")) { res.writeHead(503).end(); return; }
      if (req.url?.includes("job=empty")) { res.writeHead(204).end(); return; }
      if (req.url?.includes("job=interrupted")) { res.writeHead(200).write('{"runId":'); res.destroy(); return; }
      res.writeHead(200).end("界".repeat(Math.ceil(JOB_STATUS_LIMIT_BYTES / 3) + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const remote = new ExternalJobs(url, "token");
      await expect(remote.status("empty", "a".repeat(40))).rejects.toThrow("job dispatcher returned an invalid, incomplete or oversized result");
      await expect(remote.status("oversized", "a".repeat(40))).rejects.toThrow("oversized");
      await expect(remote.status("interrupted", "a".repeat(40))).rejects.toThrow();
      expect(await publishJobOutput(url, "token", "a".repeat(40), answer)).toBe(false);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("explains how to retrieve status when the complete model response exceeds its bound", async () => {
    const status: ExternalStatus = { runId: "a".repeat(40), jobSlug: "task", startedAt: Date.now(), state: "finished",
      result: { outcome: "completed", counts: { PASS: 2, FAIL: 0, UNKNOWN: 0 } },
      output: { state: "available", value: { version: 1, data: "x".repeat(16000) } } };
    // A legal dispatcher response exactly at its limit becomes too large when MCP adds the verdict.
    status.jobSlug += "x".repeat(JOB_STATUS_LIMIT_BYTES - Buffer.byteLength(JSON.stringify(status)));
    const job = { ...manifest("output: {format: json}").jobs[0]!, slug: status.jobSlug };
    const host = new JobHost();
    vi.spyOn(host, "status").mockImplementation(async (_job, _runId, reader) =>
      reader ? status : { ...status, output: { state: "available" } });
    const home: InboundEvent = { id: { surface: "console", nativeId: "message" }, surface: "console",
      channel: { surface: "console", id: "chat", isPublic: false },
      author: { surface: "console", id: "owner", isAgent: false, isSelf: false }, text: "status", mentionsMe: true, ts: "", raw: null };
    const handler = jobHandler({ jobs: [job], host, agentName: "demo", answering: () => home,
      turnTimeoutMs: 120000, policy: new ToolPolicy(["mcp__jobs__job_status"], []) });
    const call = (includeOutput: boolean) => handler({ method: "tools/call", params: { name: "job_status",
      arguments: { job: job.slug, runId: status.runId, includeOutput } } });
    await expect(call(true)).rejects.toThrow("retry without includeOutput to read the status alone");
    const result = await call(false) as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ verdict: "PASS", output: { state: "available" } });
    expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThan(JOB_STATUS_LIMIT_BYTES);
    expect(JSON.parse(result.content[0]!.text).output).not.toHaveProperty("value");
  });
});

describe("durable Kubernetes job lifecycle", () => {
  it("deduplicates admission and serializes two dispatchers, requested and scheduled", async () => {
    const api = new Cluster();
    const a = dispatcher(api), b = dispatcher(api);
    const job = manifest().jobs[0]!;
    const req = request(job);
    await Promise.all([a.dispatch(req), b.dispatch(req)]);
    await Promise.all([a.reconcile(), b.reconcile()]);
    expect(api.created).toBe(1);
    const clock = { ...request(job, "b"), trigger: "schedule" as const, requestedBy: null, switch: { origin: "set" as const, state: "on" as const }, bypassedSwitch: false };
    await b.dispatch(clock);
    await b.reconcile();
    expect((await a.status(job.slug, clock.runId)).outcome).toBe("skipped-overlap");
    expect(api.created).toBe(1);
    const pod = api.objects.get(`jobs/${runName(req.runId)}`)!.spec!.template as { spec: { containers: { image: string; command: string[]; env: unknown[] }[]; serviceAccountName: string; automountServiceAccountToken: boolean } };
    expect(pod.spec.containers[0]!.image).toBe(image);
    expect(pod.spec.containers[0]!.command).toEqual(["/app/bin/sageox-agent"]);
    expect(pod.spec.serviceAccountName).toBe("task-worker");
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.containers[0]!.env).toContainEqual({ name: "TASK_TOKEN", valueFrom: { secretKeyRef: { name: "task-secret", key: "token" } } });
  });

  it("retains the result after worker cleanup and dispatcher restart, then expires it without replay", async () => {
    const api = new Cluster(), a = dispatcher(api);
    const req = request(manifest().jobs[0]!);
    await a.dispatch(req); await a.reconcile();
    await completed(api, a, req, JSON.stringify({ outcome: "completed", counts: { PASS: 2, FAIL: 0, UNKNOWN: 0 } }));
    await a.reconcile(); await a.reconcile();
    expect(api.objects.has(`jobs/${runName(req.runId)}`)).toBe(false);
    const b = dispatcher(api);
    const status = await b.status("task", req.runId);
    expect(externalRun(req, status).verdict.status).toBe("PASS");
    const retried = externalRun({ ...req, startedAt: Date.now() + 60000 }, status);
    expect(retried.startedAt).toBe(req.startedAt);
    expect(describeJobRun(retried)).toContain("2 worker gates PASS");
    await b.dispatch(req); await b.reconcile();
    expect(api.created).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 86400_000);
    await b.reconcile();
    expect((await b.status("task", req.runId)).result).toBeUndefined();
    await b.dispatch(req); await b.reconcile();
    expect(api.created).toBe(1);
  });

  it("does not replay after a lost Job creation response", async () => {
    const api = new Cluster(); api.loseCreate = true;
    const a = dispatcher(api), req = request(manifest().jobs[0]!);
    await a.dispatch(req); await a.reconcile();
    await dispatcher(api).reconcile();
    expect(api.created).toBe(1);
    expect(api.objects.has(`secrets/${runName(req.runId)}`)).toBe(false);
    vi.spyOn(Date, "now").mockReturnValue(req.startedAt + 12000);
    await a.reconcile(); await a.reconcile();
    expect((await a.status("task", req.runId)).outcome).toBe("budget-bowout");
  });

  it("keeps claim tokens out of ConfigMaps and prevents duplicate claims", async () => {
    const api = new Cluster();
    const a = dispatcher(api), req = request(manifest().jobs[0]!);
    await a.dispatch(req); await a.reconcile();
    const token = runToken(api, req.runId);
    const cm = api.objects.get(`configmaps/${runName(req.runId)}`)!;
    const raw = JSON.parse(cm.data!.run!);
    expect(JSON.stringify(cm)).not.toContain(token);
    await expect(a.claim(req.runId, raw.tokenHash)).rejects.toThrow();
    const job = api.objects.get(`jobs/${cm.metadata.name}`)!;
    expect(api.objects.get(`secrets/${cm.metadata.name}`)!.metadata.ownerReferences).toEqual([
      { apiVersion: "batch/v1", kind: "Job", name: cm.metadata.name, uid: job.metadata.uid },
    ]);
    expect(JSON.stringify(job.spec)).toContain('"secret":{"name":"' + cm.metadata.name);
    const b = dispatcher(api); await b.reconcile();
    const claims = await Promise.allSettled([a.claim(req.runId, token), b.claim(req.runId, token)]);
    expect(claims.filter((c) => c.status === "fulfilled")).toHaveLength(1);
    expect(api.created).toBe(1);
    await a.cancel("task", req.runId);
    await a.reconcile(); await a.reconcile(); await a.reconcile();
    expect(api.objects.has(`secrets/${cm.metadata.name}`)).toBe(false);
    await expect(a.claim(req.runId, token)).rejects.toThrow();
  });

  it.each([false, true])("stops and reports a failed claim Secret creation without replay (persisted=%s)", async (persisted) => {
    const api = new Cluster(), a = dispatcher(api), req = request(manifest().jobs[0]!);
    const original = api.call.bind(api);
    const calls = vi.spyOn(api, "call").mockImplementation(async (method, resource, suffix, body) => {
      if (method === "POST" && resource === "secrets") {
        if (persisted) {
          await original(method, resource, suffix, body);
          // A worker can win its claim before the response is lost. It must be stopped too.
          await a.claim(req.runId, (body as KubeObject).stringData!.token!);
        }
        throw new Error("synthetic API error containing private text");
      }
      return original(method, resource, suffix, body);
    });
    await a.dispatch(req); await a.reconcile();
    expect(await a.status("task", req.runId)).toMatchObject({ state: "cancelling", outcome: "unknown" });
    const b = dispatcher(api);
    expect(await b.cancel("task", req.runId)).toMatchObject({ state: "cancelling", outcome: "unknown" });
    await b.reconcile(); await b.reconcile(); await b.reconcile();
    expect(await b.status("task", req.runId)).toMatchObject({ state: "finished", outcome: "unknown" });
    const report = await b.failureReport("task", req.runId);
    expect(report).toContain("Worker claim Secret creation was not confirmed");
    expect(report).not.toContain("private text");
    expect(api.objects.has(`jobs/${runName(req.runId)}`)).toBe(false);
    expect(api.objects.has(`secrets/${runName(req.runId)}`)).toBe(false);
    await b.dispatch(req); await b.reconcile();
    expect(api.created).toBe(1);
    expect(calls.mock.calls.filter(([method, resource]) => method === "POST" && resource === "secrets")).toHaveLength(1);
    await b.dispatch(request(manifest().jobs[0]!, "b")); await b.reconcile();
    expect(api.created).toBe(2); // the prior run's overlap lock was released
  });

  it("preserves the first stop reason when a stale cancellation races a dispatch failure", async () => {
    const api = new Cluster(), a = dispatcher(api), req = request(manifest().jobs[0]!);
    await a.dispatch(req); await a.reconcile();
    const original = api.call.bind(api);
    let raced = false;
    vi.spyOn(api, "call").mockImplementation(async (method, resource, suffix, body) => {
      if (method === "PUT" && resource === "configmaps" && !raced) {
        raced = true;
        await dispatcher(api).cancel("task", req.runId, "claim-secret-unavailable");
      }
      return original(method, resource, suffix, body);
    });
    expect(await a.cancel("task", req.runId)).toMatchObject({ state: "cancelling", outcome: "unknown" });
    await a.reconcile(); await a.reconcile();
    expect(await a.failureReport("task", req.runId)).toContain("Worker claim Secret creation was not confirmed");
  });

  it("keeps an admitted run uncertain after an unpersisted cancellation, without replay or false completion", async () => {
    const api = new Cluster(), a = dispatcher(api), req = request(manifest().jobs[0]!);
    const original = api.call.bind(api);
    vi.spyOn(api, "call").mockImplementation(async (method, resource, suffix, body) => {
      if (method === "POST" && resource === "secrets") {
        await original(method, resource, suffix, body);
        throw new Error("lost Secret response");
      }
      if (method === "PUT" && resource === "configmaps" && JSON.parse((body as KubeObject).data!.run!).status.state === "cancelling") {
        throw new KubeError(503); // no cancellation state has been persisted
      }
      return original(method, resource, suffix, body);
    });
    await a.dispatch(req); await a.reconcile();
    expect(await a.status("task", req.runId)).toMatchObject({ state: "dispatching" });
    expect((await a.status("task", req.runId)).outcome).toBeUndefined();
    await expect(a.failureReport("task", req.runId)).rejects.toThrow();
    const b = dispatcher(api), token = runToken(api, req.runId);
    await b.dispatch(req); await b.reconcile();
    const claims = await Promise.allSettled([a.claim(req.runId, token), b.claim(req.runId, token)]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    await completed(api, b, req, JSON.stringify({ outcome: "completed", counts: { PASS: 2, FAIL: 0, UNKNOWN: 0 } }));
    expect(await b.status("task", req.runId)).toMatchObject({ state: "finished", outcome: "completed", result: { counts: { PASS: 2 } } });
    await b.dispatch(req); await b.reconcile();
    expect(api.created).toBe(1);
  });

  it("recovers a completed result when the dispatcher returns after the deadline", async () => {
    const api = new Cluster(), a = dispatcher(api), req = request(manifest().jobs[0]!);
    await a.dispatch(req); await a.reconcile();
    await completed(api, a, req, JSON.stringify({ outcome: "completed", counts: { PASS: 2, FAIL: 0, UNKNOWN: 0 } }), false);
    vi.spyOn(Date, "now").mockReturnValue(req.startedAt + 12000);
    const b = dispatcher(api);
    await b.reconcile();
    expect(await b.status("task", req.runId)).toMatchObject({ state: "finished", outcome: "completed", result: { counts: { PASS: 2 } } });
  });

  it("recovers a lock left by a stale reconciler after a cancelled run was cleaned", async () => {
    const api = new Cluster(), a = dispatcher(api), b = dispatcher(api), req = request(manifest().jobs[0]!);
    await a.dispatch(req);
    const original = api.call.bind(api);
    let pause!: () => void, proceed!: () => void;
    const paused = new Promise<void>((resolve) => { pause = resolve; });
    const resume = new Promise<void>((resolve) => { proceed = resolve; });
    vi.spyOn(api, "call").mockImplementation(async (method, resource, suffix, body) => {
      if (method === "POST" && (body as KubeObject)?.metadata.name.startsWith("lock-")) {
        pause(); await resume;
      }
      return original(method, resource, suffix, body);
    });
    const stale = a.reconcile();
    await paused;
    await b.cancel("task", req.runId);
    await b.reconcile(); await b.reconcile();
    proceed(); await stale;
    await b.reconcile();
    expect([...api.objects.keys()].some((key) => key.startsWith("configmaps/lock-"))).toBe(false);
    await b.dispatch(request(manifest().jobs[0]!, "b")); await b.reconcile();
    expect(api.created).toBe(1);
  });

  it.each(["claim", "cancel"])("retries a %s CAS when reconciliation updates the running state", async (action) => {
    const api = new Cluster(), a = dispatcher(api), req = request(manifest().jobs[0]!);
    await a.dispatch(req); await a.reconcile();
    const cm = api.objects.get(`configmaps/${runName(req.runId)}`)!;
    const original = api.call.bind(api);
    let raced = false;
    vi.spyOn(api, "call").mockImplementation(async (method, resource, suffix, body) => {
      if (method === "PUT" && !raced) {
        raced = true;
        const run = JSON.parse(cm.data!.run!);
        run.status.state = "running";
        await original("PUT", "configmaps", `/${cm.metadata.name}`, { ...cm, data: { run: JSON.stringify(run) } });
      }
      return original(method, resource, suffix, body);
    });
    if (action === "claim") {
      await a.claim(req.runId, runToken(api, req.runId));
      await expect(a.claim(req.runId, runToken(api, req.runId))).rejects.toThrow();
    } else expect((await a.cancel("task", req.runId)).state).toBe("cancelling");
  });

  it("pins the worker identity and credential mapping at admission across deployment changes", async () => {
    const api = new Cluster(), a = dispatcher(api), req = request(manifest().jobs[0]!);
    await a.dispatch(req);
    const b = new JobDispatcher({ api, name: "demo-dispatcher", jobs: manifest().jobs, url: "http://dispatcher:8090",
      profiles: { task: { serviceAccountName: "different-worker", secrets: { TASK_TOKEN: { name: "different-secret", key: "token" } }, resources: {} } } });
    await b.reconcile();
    const spec = api.objects.get(`jobs/${runName(req.runId)}`)!.spec!.template as { spec: { serviceAccountName: string; containers: { env: unknown[] }[] } };
    expect(spec.spec.serviceAccountName).toBe("task-worker");
    expect(spec.spec.containers[0]!.env).toContainEqual({ name: "TASK_TOKEN", valueFrom: { secretKeyRef: { name: "task-secret", key: "token" } } });
  });

  it("scopes run IDs to the dispatcher so agents sharing a namespace cannot collide", async () => {
    const api = new Cluster(), a = dispatcher(api), req = request(manifest().jobs[0]!);
    const b = new JobDispatcher({ api, name: "another-dispatcher", jobs: manifest().jobs, url: "http://another-dispatcher:8090",
      profiles: { task: { serviceAccountName: "task-worker", secrets: { TASK_TOKEN: { name: "task-secret", key: "token" } }, resources: {} } } });
    await a.dispatch(req); await b.dispatch(req);
    await a.reconcile(); await b.reconcile(); await b.reconcile();
    expect(api.created).toBe(2);
    await a.cancel("task", req.runId);
    await a.reconcile(); await a.reconcile();
    expect((await b.status("task", req.runId)).state).toBe("running");
  });

  it.each([undefined, "not json", JSON.stringify({ outcome: "completed", counts: { PASS: 1, FAIL: 0, UNKNOWN: 0 }, logs: "secret" })])("marks lost or untrusted results unknown (%s)", async (message) => {
    const api = new Cluster(), a = dispatcher(api), req = request(manifest().jobs[0]!);
    await a.dispatch(req); await a.reconcile(); await completed(api, a, req, message);
    const status = await a.status("task", req.runId);
    expect(status.outcome).toBe("unknown");
    expect(externalRun(req, status).verdict.status).toBe("UNKNOWN");
    await a.reconcile(); expect(api.created).toBe(1);
  });

  it.each(["cancel", "deadline"])("%s stops the actual worker and keeps its lock until deletion", async (mode) => {
    const api = new Cluster(), a = dispatcher(api), job = manifest().jobs[0]!, req = request(job);
    await a.dispatch(req); await a.reconcile();
    api.holdDeletion = true;
    if (mode === "cancel") await a.cancel("task", req.runId);
    else vi.spyOn(Date, "now").mockReturnValue(req.startedAt + 11001);
    await a.reconcile();
    expect((await a.status("task", req.runId)).state).toBe("cancelling");
    expect([...api.objects.keys()].some((k) => k.startsWith("configmaps/lock-"))).toBe(true);
    api.holdDeletion = false;
    await a.reconcile(); await a.reconcile(); await a.reconcile();
    const status = await a.status("task", req.runId);
    expect(status.outcome).toBe(mode === "cancel" ? "cancelled" : "budget-bowout");
    expect(externalRun(req, status).verdict.status).toBe("UNKNOWN");
    expect([...api.objects.keys()].some((k) => k.startsWith("configmaps/lock-"))).toBe(false);
  });

  it("applies automation gates and rejects changed definitions and undeclared inputs", async () => {
    const api = new Cluster(), a = dispatcher(api), req = request(manifest().jobs[0]!);
    await expect(a.dispatch({ ...req, trigger: "schedule", requestedBy: null, bypassedSwitch: false })).rejects.toThrow();
    await expect(a.dispatch({ ...req, definition: "b".repeat(64) })).rejects.toThrow();
    await expect(a.dispatch({ ...req, parameters: { approved: 1 } })).rejects.toThrow();
    await expect(a.dispatch({ ...req, image: "evil" })).rejects.toThrow();
    expect(api.created).toBe(0);
  });

  it("retains partial diagnostics through cancellation, rejects other tokens, and ignores stale checkpoints", async () => {
    const api = new Cluster(), a = dispatcher(api), job = manifest().jobs[0]!, req = request(job);
    await a.dispatch(req); await a.reconcile();
    const claimToken = runToken(api, req.runId);
    const snapshot: WorkerDiagnostics = { sequence: 2, complete: false,
      execution: { state: "running", startedAt: req.startedAt, exitCode: null, signal: null },
      stdout: { text: "last successful step", truncated: false }, stderr: { text: "upstream is slow", truncated: false },
    };
    await expect(a.recordDiagnostics(req.runId, claimToken, snapshot)).rejects.toThrow(); // unclaimed
    await a.claim(req.runId, claimToken);
    await expect(a.recordDiagnostics(req.runId, "gateway-token", snapshot)).rejects.toThrow();
    await a.dispatch(request(job, "b"));
    await expect(a.recordDiagnostics("b".repeat(40), claimToken, snapshot)).rejects.toThrow();
    await a.recordDiagnostics(req.runId, claimToken, snapshot);
    await a.recordDiagnostics(req.runId, claimToken, { ...snapshot, sequence: 1, stdout: { text: "stale", truncated: false } });
    await a.cancel(job.slug, req.runId);
    await a.reconcile(); await a.reconcile(); await a.reconcile();
    const status = await dispatcher(api).status(job.slug, req.runId);
    expect(status).toMatchObject({ state: "finished", outcome: "cancelled", diagnostics: { complete: false } });
    const saved = JSON.parse(api.objects.get(`configmaps/${status.diagnostics!.ref}`)!.data!.diagnostics!);
    expect(saved.stdout.text).toBe("last successful step");
    expect(saved.complete).toBe(false);
    expect(JSON.stringify(status)).not.toContain("upstream");
    await expect(a.recordDiagnostics(req.runId, claimToken, { ...snapshot, sequence: 3 })).rejects.toThrow();
  });
});

it("reports actual worker gate counts without counting summary groups as gates", () => {
  const req = request(manifest().jobs[0]!);
  const run = externalRun(req, { runId: req.runId, jobSlug: req.jobSlug, startedAt: req.startedAt,
    state: "finished", outcome: "completed", result: { outcome: "completed", counts: { PASS: 9, FAIL: 3, UNKNOWN: 1 } } });
  expect(run.verdict.status).toBe("FAIL");
  expect(describeJobRun(run)).toContain("9 worker gates PASS; 3 FAIL; 1 UNKNOWN");
  expect(describeJobRun(run)).not.toContain("2 of 3 gates");
});

it.each([false, true])("uses the same host contract for Python and a compiled executable (output=%s)", async (enabled) => {
  const dir = await mkdtemp(join(tmpdir(), "worker-contract-"));
  try {
    await writeFile(join(dir, "task.py"), 'import os,json\nassert os.environ["JOB_TRIGGER"] == "on-request"\nassert os.environ["API_TOKEN"] == "worker-secret"\nartifact={"gates":[{"gate":"worker-secret", "detail":"worker-secret", "executed":True,"exitCode":0}]}\nif os.environ.get("JOB_OUTPUT_SCHEMA_VERSION") == "1": artifact["output"]={"version":1,"data":{"records":[42]}}\njson.dump(artifact,open(os.environ["JOB_VERDICT_PATH"],"w"))\n');
    await writeFile(join(dir, "task.c"), '#include <stdlib.h>\n#include <stdio.h>\n#include <string.h>\nint main(void){FILE *f=fopen(getenv("JOB_VERDICT_PATH"),"w");fputs("{\\"gates\\":[{\\"gate\\":\\"compiled\\",\\"executed\\":true,\\"exitCode\\":0}]",f);const char *v=getenv("JOB_OUTPUT_SCHEMA_VERSION");if(v && !strcmp(v,"1"))fputs(",\\"output\\":{\\"version\\":1,\\"data\\":{\\"records\\":[42]}}",f);fputs("}",f);return fclose(f);}\n');
    execFileSync("cc", [join(dir, "task.c"), "-o", join(dir, "task")]);
    for (const [command, args] of [["python3", [join(dir, "task.py")]], [join(dir, "task"), []]] as const) {
      const original = manifest(enabled ? "output: {format: json}" : "").jobs[0]!;
      const job = { ...original, run: { ...original.run, command, args: [...args] } };
      const output = vi.fn();
      const host = new JobHost({ workDir: dir, secretOpts: { dir, env: { TASK_TOKEN: "worker-secret" } }, onOutput: output });
      const run = await host.executeWorker(JobSchema.parse(job), request(job));
      expect(run.verdict.status).toBe("PASS");
      expect(workerResult(run)).toMatchObject({ outcome: "completed", counts: { PASS: 2, FAIL: 0, UNKNOWN: 0 }, execution: { state: "exited", exitCode: 0 } });
      expect(JSON.stringify(workerResult(run))).not.toContain("worker-secret");
      if (enabled) expect(output.mock.calls[0]![1]).toEqual({ state: "available", value: { version: 1, data: { records: [42] } } });
      else expect(output).not.toHaveBeenCalled();
      expect(workerResult(run)).not.toHaveProperty("output");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("returns a durable run ID through the real HTTP client and guarded tool; rejects fabricated authority", async () => {
  const api = new Cluster(), dispatch = dispatcher(api), job = manifest().jobs[0]!;
  const token = "private-gateway-token".repeat(3);
  const server = await serveJobDispatcher(dispatch, token, { host: "127.0.0.1", port: 0 });
  const remote = new ExternalJobs(`http://127.0.0.1:${server.port}`, token);
  const host = new JobHost({ external: remote, switchSource: async () => ({ origin: "set", state: "off" }) });
  const event: InboundEvent = { id: { surface: "console", nativeId: "message" }, surface: "console", channel: { surface: "console", id: "chat", isPublic: false }, author: { surface: "console", id: "owner", isAgent: false, isSelf: false }, text: "run task", mentionsMe: true, ts: "", raw: null };
  const handler = jobHandler({ jobs: [job], host, agentName: "demo", owner: ["owner"], answering: () => event, turnTimeoutMs: 120000, policy: new ToolPolicy(["mcp__jobs__*"], []) });
  try {
    const call = (args: Record<string, unknown>) => handler({ method: "tools/call", params: { name: "job_run", arguments: args } });
    for (const override of ["human", "approved", "command", "image", "credentials"]) {
      await expect(call({ job: "task", [override]: true })).rejects.toThrow("Unrecognized key");
    }
    const first = JSON.stringify(await call({ job: "task" }));
    const id = /run id ([a-f0-9]{40})/.exec(first)![1]!;
    expect(JSON.stringify(await call({ job: "task" }))).toContain(id);
    expect((await new ExternalJobs(`http://127.0.0.1:${server.port}`, token).status("task", id)).state).toBe("pending");
    await expect(remote.status("other", id)).rejects.toThrow();
    await expect(new ExternalJobs(`http://127.0.0.1:${server.port}`, "brain-mcp-token").status("task", id)).rejects.toThrow();
    await host.abandon();
    expect((await remote.status("task", id)).state).toBe("pending");
  } finally { await host.abandon(); await server.close(); }
});

it.each(["buzz", "slack"])("automatically explains an uncaught script error in the %s report and original conversation", async (surface) => {
  const dir = await mkdtemp(join(tmpdir(), "worker-failure-"));
  const original = manifest().jobs[0]!;
  const job: JobConfig = { ...original,
    run: { ...original.run, command: process.execPath, args: ["-e", 'console.log("step: connecting"); throw new Error("synthetic worker exception: " + process.env.API_TOKEN)'] },
    report: { surface, channel: "operations", announce: "unproven", proven: "labelled", probe: false },
  };
  const api = new Cluster(), dispatch = dispatcher(api, [job]);
  const token = "private-gateway-token".repeat(3);
  const server = await serveJobDispatcher(dispatch, token, { host: "127.0.0.1", port: 0 });
  const remote = new ExternalJobs(`http://127.0.0.1:${server.port}`, token);
  const posts: { surface: string; channel: string; text: string; threadRoot?: EventRef }[] = [];
  const onRun = vi.fn();
  const reply = vi.fn(async (_home: InboundEvent, _text: string) => {});
  const host = new JobHost({ external: remote, switchSource: async () => ({ origin: "set", state: "off" }),
    onRun,
    post: async (destination, text, threadRoot) => {
      posts.push({ surface: destination.surface, channel: destination.channel, text, threadRoot });
      return { surface, nativeId: "headline" };
    },
  });
  const home: InboundEvent = { id: { surface, nativeId: "request" }, surface, channel: { surface, id: "requests", isPublic: false }, author: { surface, id: "owner", isAgent: false, isSelf: false }, text: "run task", mentionsMe: true, ts: "", raw: null };
  const handler = jobHandler({ jobs: [job], host, agentName: "demo", owner: ["owner"], answering: () => home, reply,
    turnTimeoutMs: 120000, policy: new ToolPolicy(["mcp__jobs__*"], []) });
  try {
    const started = JSON.stringify(await handler({ method: "tools/call", params: { name: "job_run", arguments: { job: job.slug } } }));
    const start = { runId: /run id ([a-f0-9]{40})/.exec(started)![1]! };
    await dispatch.reconcile();
    const cm = api.objects.get(`configmaps/${runName(start.runId)}`)!;
    const raw = JSON.parse(cm.data!.run!);
    const claimToken = runToken(api, start.runId);
    await dispatch.claim(start.runId, claimToken);
    const snapshots: WorkerDiagnostics[] = [];
    const worker = new JobHost({ workDir: dir, secretOpts: { dir, env: { TASK_TOKEN: "worker-secret" } }, onDiagnostics: (snapshot) => snapshots.push(snapshot) });
    const run = await worker.executeWorker(JobSchema.parse(raw.job), raw.request);
    expect(run.verdict.status).toBe("FAIL");
    const upload = await fetch(`http://127.0.0.1:${server.port}/runs/${start.runId}/diagnostics`, {
      method: "POST", headers: { authorization: `Bearer ${claimToken}`, "content-type": "application/json" }, body: JSON.stringify(snapshots.at(-1)),
    });
    expect(upload.status).toBe(204);
    await completed(api, dispatch, raw.request, JSON.stringify(workerResult(run)));
    await vi.waitFor(() => expect(posts).toHaveLength(2), { timeout: 3000 });
    expect(posts[0]).toMatchObject({ surface, channel: "operations" });
    expect(posts[0]!.text).toContain("FAILED:");
    expect(posts[0]!.text).toContain("process exited with code 1");
    expect(posts[1]).toMatchObject({ surface, channel: "operations", threadRoot: { surface, nativeId: "headline" } });
    expect(posts[1]!.text).toContain("Error: synthetic worker exception: [REDACTED]");
    expect(JSON.stringify(posts)).not.toContain("worker-secret");
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![0]).toBe(home);
    expect(reply.mock.calls[0]![1]).toContain("did not finish successfully");
    expect(reply.mock.calls[0]![1]).not.toMatch(/synthetic worker exception|run id|process exited|FAILED:/);
    expect(reply.mock.calls[0]![1]).not.toContain("worker-secret");
    expect(JSON.stringify(onRun.mock.calls)).not.toContain("synthetic worker exception");
    const modelStatus = JSON.stringify(await handler({ method: "tools/call", params: { name: "job_status", arguments: { job: job.slug, runId: start.runId } } }));
    expect(modelStatus).not.toContain("synthetic worker exception");
    await expect(new ExternalJobs(`http://127.0.0.1:${server.port}`, "brain-mcp-token").failureReport(job.slug, start.runId)).rejects.toThrow();
    await expect(new ExternalJobs(`http://127.0.0.1:${server.port}`, claimToken).failureReport(job.slug, start.runId)).rejects.toThrow();
    await expect(remote.failureReport("other", start.runId)).rejects.toThrow();
    await dispatch.reconcile(); await dispatch.reconcile();
    const retained = await new ExternalJobs(`http://127.0.0.1:${server.port}`, token).status(job.slug, start.runId);
    expect(retained.state).toBe("finished");
    expect(retained.result?.counts.FAIL).toBe(1);
    const saved = JSON.parse(api.objects.get(`configmaps/${retained.diagnostics!.ref}`)!.data!.diagnostics!);
    expect(saved).toMatchObject({ runId: start.runId, image, complete: true, execution: { exitCode: 1 } });
    expect(saved.stderr.text).toContain("Error: synthetic worker exception: [REDACTED]");
    expect(saved.stderr.text).toContain("at ");
    expect(saved.stdout.text).toContain("step: connecting");
    expect(JSON.stringify(saved)).not.toContain("worker-secret");
    expect(JSON.stringify(retained)).not.toContain("synthetic worker exception");
    const forbidden = await fetch(`http://127.0.0.1:${server.port}/runs/${start.runId}/diagnostics`, { headers: { authorization: `Bearer ${token}` } });
    expect(forbidden.status).toBe(404);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 86400_000);
    await dispatcher(api, [job]).reconcile();
    expect(api.objects.get(`configmaps/${retained.diagnostics!.ref}`)!.data!.diagnostics).toBeUndefined();
    expect((await remote.status(job.slug, start.runId)).diagnostics).toBeUndefined();
  } finally { await host.abandon(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});

it("bounds automatic excerpts, uses stdout when stderr is empty, and labels partial output", async () => {
  const api = new Cluster(), a = dispatcher(api), job = manifest().jobs[0]!, req = request(job);
  await a.dispatch(req); await a.reconcile();
  await a.claim(req.runId, runToken(api, req.runId));
  await a.recordDiagnostics(req.runId, runToken(api, req.runId), {
    sequence: 0, complete: false, execution: { state: "running", startedAt: req.startedAt, exitCode: null, signal: null },
    stdout: { text: "old output\n".repeat(500) + "upstream refused request\n```\nlast error", truncated: true },
    stderr: { text: "", truncated: false },
  });
  await expect(a.failureReport(job.slug, req.runId)).rejects.toThrow(); // still running
  await completed(api, a, req, JSON.stringify({ outcome: "completed", counts: { PASS: 0, FAIL: 1, UNKNOWN: 0 } }));
  const report = await a.failureReport(job.slug, req.runId);
  expect(report.length).toBeLessThanOrEqual(2000);
  expect(report).toContain("Last stdout");
  expect(report).toContain("partial checkpoint");
  expect(report).toContain("earlier output omitted");
  expect(report).toContain("upstream refused request");
  expect(report.match(/```/g)).toHaveLength(2); // only the host's code fence
  await a.reconcile(); await a.reconcile();
  expect(await dispatcher(api).failureReport(job.slug, req.runId)).toBe(report);
});

it("automatically identifies an OOM-killed worker even when no script output survived", async () => {
  const api = new Cluster(), a = dispatcher(api), req = request(manifest().jobs[0]!);
  await a.dispatch(req); await a.reconcile();
  await completed(api, a, req, undefined, false);
  api.objects.get("pods/worker")!.status = { phase: "Failed", containerStatuses: [
    { name: "worker", state: { terminated: { exitCode: 137, reason: "OOMKilled" } } },
  ] };
  await a.reconcile();
  expect(await a.failureReport("task", req.runId)).toContain("Worker state: OOMKilled");
  await a.reconcile(); await a.reconcile();
  expect(await a.failureReport("task", req.runId)).toContain("Worker state: OOMKilled");
});

it.each(["FAIL", "PASS"])("keeps automatic %s notifications independent of diagnostic retrieval", async (verdict) => {
  const job = manifest("report: {surface: console, channel: operations, announce: always}").jobs[0]!;
  const api = new Cluster(), a = dispatcher(api, [job]);
  const server = await serveJobDispatcher(a, "gateway-token".repeat(3), { host: "127.0.0.1", port: 0 });
  const remote = new ExternalJobs(`http://127.0.0.1:${server.port}`, "gateway-token".repeat(3));
  const lookup = vi.spyOn(remote, "failureReport").mockRejectedValue(new Error("private backend failure"));
  const post = vi.fn(async () => undefined);
  const host = new JobHost({ external: remote, post, switchSource: async () => ({ origin: "set", state: "off" }) });
  try {
    const start = await host.startRequest(job, { kind: "human", id: "owner" });
    await a.reconcile();
    const raw = JSON.parse(api.objects.get(`configmaps/${runName(start.runId)}`)!.data!.run!);
    const counts = { PASS: verdict === "PASS" ? 1 : 0, FAIL: verdict === "FAIL" ? 1 : 0, UNKNOWN: 0 };
    await completed(api, a, raw.request, JSON.stringify({ outcome: "completed", counts }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(verdict === "FAIL" ? 2 : 1), { timeout: 3000 });
    if (verdict === "FAIL") {
      expect(JSON.stringify(post.mock.calls)).toContain("FAILED:");
      expect(JSON.stringify(post.mock.calls)).toContain("Additional error output could not be retrieved");
      expect(lookup).toHaveBeenCalledTimes(1);
    } else {
      expect(lookup).not.toHaveBeenCalled();
      await expect(a.failureReport(job.slug, start.runId)).rejects.toThrow();
    }
    expect(JSON.stringify(post.mock.calls)).not.toContain("private backend failure");
  } finally { await host.abandon(); await server.close(); }
});

it("refuses unsupported external execution without spawning locally", async () => {
  await expect(new JobHost().startRequest(manifest().jobs[0]!, { kind: "human", id: "owner" })).rejects.toThrow("no local execution fallback");
});

it("aborts an in-flight status request when observation is abandoned", async () => {
  let received!: () => void;
  const pending = new Promise<void>((resolve) => { received = resolve; });
  const server = createServer(() => received()); // intentionally never sends headers
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  const reason = new Error("observer stopped");
  const remote = new ExternalJobs(`http://127.0.0.1:${(server.address() as { port: number }).port}`, "token");
  try {
    const waiting = remote.wait(request(manifest().jobs[0]!), controller.signal);
    const rejected = expect(waiting).rejects.toBe(reason);
    await pending;
    controller.abort(reason);
    await rejected;
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("preserves caller cancellation while reading an open status response body", async () => {
  let reading!: () => void;
  const pending = new Promise<void>((resolve) => { reading = resolve; });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Response(new ReadableStream({
    pull(stream) {
      init!.signal!.addEventListener("abort", () => stream.error(new Error("response body aborted")), { once: true });
      reading();
    },
  }, { highWaterMark: 0 })));
  const controller = new AbortController();
  const reason = new Error("observer stopped during response body");
  try {
    const waiting = new ExternalJobs("http://dispatcher", "token").wait(request(manifest().jobs[0]!), controller.signal);
    const rejected = expect(waiting).rejects.toBe(reason);
    await pending;
    controller.abort(reason);
    await rejected;
  } finally { controller.abort(); }
});

it("refuses unbound external tool requests before admission, including retries", async () => {
  const api = new Cluster(), dispatch = dispatcher(api), job = manifest().jobs[0]!;
  const remote = { dispatch: vi.fn((req: ExternalRequest) => dispatch.dispatch(req)) } as unknown as ExternalJobs;
  const host = new JobHost({ external: remote });
  const handler = jobHandler({ jobs: [job], host, agentName: "demo", answering: () => null,
    turnTimeoutMs: 120000, policy: new ToolPolicy(["mcp__jobs__*"], []) });
  for (let i = 0; i < 2; i++) {
    await expect(handler({ method: "tools/call", params: { name: "job_run", arguments: { job: job.slug } } }))
      .rejects.toThrow("unambiguous originating message");
  }
  expect(remote.dispatch).not.toHaveBeenCalled();
  expect(api.objects.size).toBe(0);
});

it.each([false, true])("reads short verdict chunks completely while preserving the size bound (oversized=%s)", async (oversized) => {
  const dir = await mkdtemp(join(tmpdir(), "short-verdict-"));
  const probe = await open(join(dir, "probe"), "w+");
  const prototype: { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> } = Object.getPrototypeOf(probe);
  const read = prototype.read;
  await probe.close();
  const reads = vi.spyOn(prototype, "read").mockImplementation(function (this: typeof prototype, buffer, offset, length, position) {
    return read.call(this, buffer, offset, Math.min(length, 7), position);
  });
  try {
    const original = manifest().jobs[0]!;
    const artifact = JSON.stringify({ gates: [{ gate: "task", executed: true, exitCode: 0 }] }) + (oversized ? " ".repeat(64 * 1024) : "");
    const job = JobSchema.parse({ ...original, run: { command: process.execPath,
      args: ["-e", `require('fs').writeFileSync(process.env.JOB_VERDICT_PATH, ${JSON.stringify(artifact)})`] } });
    const run = await new JobHost({ workDir: dir }).executeWorker(job, request(job));
    expect(run.verdict.status).toBe(oversized ? "UNKNOWN" : "PASS");
    expect(reads.mock.calls.length).toBeGreaterThan(1);
  } finally { reads.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});

it.each([
  ["a classified value", "parking" as const, "parking"],
  // The compatible direction, and the only one there is: the request schema is strict, so
  // a dispatcher older than its gateway rejects `value` outright and nothing dispatches.
  ["a gateway that predates the classification", undefined, "unavailable"],
])("carries %s across the dispatch wire", async (_case, value, reported) => {
  const { jobWorkEvents } = await import("../src/work-events.ts");
  const api = new Cluster(), dispatch = dispatcher(api), job = manifest().jobs[0]!;
  const req: ExternalRequest = { ...request(job),
    switch: { origin: "set", state: "off", ...(value ? { value } : {}) } };

  const status = await dispatch.dispatch(req);
  expect(status.state).toBe("pending");
  const stored: ExternalRequest = JSON.parse(api.objects.get(`configmaps/${runName(req.runId)}`)!.data!.run!).request;
  expect(stored.switch).toEqual(req.switch);

  const events: Array<Record<string, any>> = [];
  jobWorkEvents("demo", { AGENT_WORK_EVENTS: "1" }, (line) => events.push(JSON.parse(line).sageox_work_event))
    .onRun!(externalRun(req, { ...status, state: "finished", endedAt: req.startedAt + 50,
      outcome: "completed", result: { outcome: "completed", counts: { PASS: 1, FAIL: 0, UNKNOWN: 0 } } }));
  expect(events[0]!.admission).toEqual({ bypassed_switch: true,
    switch: { state: "off", origin: "set", value: reported } });
});

it.each(["pending", "finished", "skipped-overlap"] as const)("reports external %s observation with its existing run ID despite throwing observers", async (state) => {
  const { jobWorkEvents } = await import("../src/work-events.ts");
  const job = manifest().jobs[0]!;
  const remote = new ExternalJobs("http://unused", "unused");
  const terminal = (req: ExternalRequest) => ({
    runId: req.runId, jobSlug: req.jobSlug, startedAt: req.startedAt, endedAt: req.startedAt + 50,
    state: "finished" as const, outcome: state === "skipped-overlap" ? "skipped-overlap" as const : "completed" as const,
    ...(state === "skipped-overlap" ? {} : { result: { outcome: "completed" as const, counts: { PASS: 1, FAIL: 0, UNKNOWN: 0 } } }),
  });
  vi.spyOn(remote, "dispatch").mockImplementation(async (req) => state === "pending"
    ? { runId: req.runId, jobSlug: req.jobSlug, startedAt: req.startedAt, state: "pending" }
    : terminal(req));
  vi.spyOn(remote, "wait").mockImplementation(async (req) => externalRun(req, terminal(req)));
  const events: Array<Record<string, any>> = [];
  const observer = jobWorkEvents("demo", { AGENT_WORK_EVENTS: "1" }, (line) => events.push(JSON.parse(line).sageox_work_event));
  const host = new JobHost({ external: remote, ...observer,
    onStart: (run) => { observer.onStart!(run); throw new Error("observer failed"); },
    onRun: (run) => { observer.onRun!(run); throw new Error("observer failed"); },
  });
  const run = await host.request(job, { kind: "human", id: "owner" });
  expect(events.map((e) => e.event)).toEqual(state === "pending" ? ["run.started", "run.completed"] : ["run.completed"]);
  expect(events.at(-1)).toMatchObject({ run_id: run.runId, outcome: run.outcome, partial: true });
  expect(events.every((e) => e.run_id === run.runId)).toBe(true);
});
