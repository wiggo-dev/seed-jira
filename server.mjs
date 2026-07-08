import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import {
  DEFAULTS,
  FIELD_META,
  PROJECT_KEY,
  SEED_LABEL,
  buildConfig,
  eventHooks,
  runSeed,
} from "./lib/seed-jira-core.mjs";

const PORT = Number(process.env.SEED_UI_API_PORT || 3847);
const app = express();

app.use(express.json());

/** @type {Map<string, object>} */
const runs = new Map();
let activeRunId = null;

function getEnvStatus() {
  const baseUrl = (process.env.JIRA_BASE_URL || "").replace(/\/$/, "");
  const ok = !!(baseUrl && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
  return { ok, baseUrl, projectKey: PROJECT_KEY, seedLabel: SEED_LABEL };
}

function bodyToConfig(body = {}) {
  const {
    mode = "seed",
    dryRun,
    deleteArtifacts,
    deleteStateFile,
    yes,
    verbose,
    boardName,
    boardId,
    ...rest
  } = body;

  const knobs = {
    numPIs: rest.numPIs,
    sprintsPerPI: rest.sprintsPerPI,
    epicsPerPI: rest.epicsPerPI,
    issuesPerEpic: rest.issuesPerEpic,
    maxCommentsPerIssue: rest.maxCommentsPerIssue,
    maxWorklogsPerIssue: rest.maxWorklogsPerIssue,
    daysOfHistory: rest.daysOfHistory,
    sleepMs: rest.sleepMs,
  };

  const cleanedKnobs = Object.fromEntries(
    Object.entries(knobs).filter(([, v]) => v !== undefined && v !== null && v !== "")
  );

  return buildConfig({
    mode,
    "dry-run": dryRun ?? mode === "dry-run",
    "delete-artifacts": deleteArtifacts,
    "delete-state-file": deleteStateFile,
    yes,
    verbose,
    "board-name": boardName,
    "board-id": boardId,
    "num-pis": cleanedKnobs.numPIs,
    "sprints-per-pi": cleanedKnobs.sprintsPerPI,
    "epics-per-pi": cleanedKnobs.epicsPerPI,
    "issues-per-epic": cleanedKnobs.issuesPerEpic,
    "max-comments": cleanedKnobs.maxCommentsPerIssue,
    "max-worklogs": cleanedKnobs.maxWorklogsPerIssue,
    "days-of-history": cleanedKnobs.daysOfHistory,
    "sleep-ms": cleanedKnobs.sleepMs,
    "assignee-ids": Array.isArray(rest.assigneeIds) ? rest.assigneeIds.join(",") : rest.assigneeIds,
    "reassign-prob": rest.reassignProb,
    "epic-churn-prob": rest.epicChurnProb,
    products: Array.isArray(rest.products) ? rest.products.join(",") : rest.products,
    teams: Array.isArray(rest.teams) ? rest.teams.join(",") : rest.teams,
    "products-field-id": rest.productsFieldId,
    "story-points": Array.isArray(rest.storyPoints) ? rest.storyPoints.join(",") : rest.storyPoints,
  });
}

function broadcast(run, event) {
  run.events.push(event);
  for (const res of run.subscribers) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/env-status", (_req, res) => {
  res.json(getEnvStatus());
});

app.get("/api/defaults", (_req, res) => {
  res.json({
    defaults: {
      ...DEFAULTS,
      reassignProb: 0.1,
      epicChurnProb: 0.1,
      productsFieldId: "",
      storyPoints: [1, 2, 3, 5, 8, 13],
      verbose: false,
      deleteArtifacts: false,
      deleteStateFile: false,
      boardName: "SSP",
    },
    fieldMeta: FIELD_META,
    projectKey: PROJECT_KEY,
    seedLabel: SEED_LABEL,
  });
});

function basicAuthHeader(email, token) {
  const b64 = Buffer.from(`${email}:${token}`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

function parseOptionLike(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(parseOptionLike);
  if (typeof value === "string") return value ? [value] : [];
  if (typeof value === "number") return [String(value)];
  if (typeof value === "object") {
    if (typeof value.value === "string") return [value.value];
    if (typeof value.name === "string") return [value.name];
    if (typeof value.id === "string") return [value.id];
  }
  return [];
}

async function jiraJson(method, path, body) {
  const baseUrl = (process.env.JIRA_BASE_URL || "").replace(/\/$/, "");
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !token) {
    throw new Error("Missing env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
  }
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: basicAuthHeader(email, token),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}\n${text}`);
  }
  return text ? JSON.parse(text) : null;
}

app.get("/api/options/assignable-users", async (req, res) => {
  try {
    const projectKey = req.query.projectKey ? String(req.query.projectKey) : PROJECT_KEY;
    const users = await jiraJson(
      "GET",
      `/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=1000`
    );
    const list = Array.isArray(users)
      ? users.map((u) => ({
          value: u.accountId,
          label: `${u.displayName || "(no name)"}${u.emailAddress ? ` <${u.emailAddress}>` : ""}`,
        }))
      : [];
    res.json({ options: list });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/options/teams", async (req, res) => {
  try {
    const projectKey = req.query.projectKey ? String(req.query.projectKey) : PROJECT_KEY;
    const fields = await jiraJson("GET", "/rest/api/3/field");
    const teamsField = Array.isArray(fields)
      ? fields.find((f) => f?.name && ["teams", "team"].includes(String(f.name).toLowerCase()) && f?.id)
      : null;
    const teamFieldId = teamsField?.id;
    if (!teamFieldId) throw new Error("Could not find Team custom field id.");

    const jql = `project = ${projectKey} AND ${teamFieldId} IS NOT EMPTY`;
    const byId = new Map();
    let nextPageToken = null;

    while (true) {
      const data = await jiraJson("POST", "/rest/api/3/search/jql", {
        jql,
        maxResults: 100,
        fields: [teamFieldId],
        nextPageToken,
      });
      const issues = data?.issues || data?.values || [];
      for (const issue of issues) {
        const team = issue?.fields?.[teamFieldId];
        const id = team?.id || null;
        const label = team?.name || team?.title || id;
        if (id && !byId.has(id)) byId.set(id, label);
      }
      nextPageToken = data?.nextPageToken ?? null;
      if (!nextPageToken || issues.length === 0) break;
    }

    const options = [...byId.entries()].map(([value, label]) => ({ value, label }));
    options.sort((a, b) => a.label.localeCompare(b.label));
    res.json({ options });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/options/products", async (req, res) => {
  try {
    const projectKey = req.query.projectKey ? String(req.query.projectKey) : PROJECT_KEY;
    const requestedFieldId = req.query.fieldId ? String(req.query.fieldId) : "";

    const fields = await jiraJson("GET", "/rest/api/3/field");
    const namedField = Array.isArray(fields)
      ? fields.find((f) => {
          const n = String(f?.name || "").toLowerCase();
          return ["product(s) affected", "products affected", "product affected"].includes(n) && f?.id;
        })
      : null;
    const fieldId = requestedFieldId || namedField?.id;
    if (!fieldId) throw new Error("Could not determine products custom field id.");

    const jql = `project = ${projectKey} AND ${fieldId} IS NOT EMPTY`;
    const byValue = new Map();
    let nextPageToken = null;

    while (true) {
      const data = await jiraJson("POST", "/rest/api/3/search/jql", {
        jql,
        maxResults: 100,
        fields: [fieldId],
        nextPageToken,
      });
      const issues = data?.issues || data?.values || [];

      for (const issue of issues) {
        const v = issue?.fields?.[fieldId];
        const values = parseOptionLike(v);
        for (const raw of values) {
          const key = String(raw);
          if (key && !byValue.has(key)) byValue.set(key, key);
        }
      }

      nextPageToken = data?.nextPageToken ?? null;
      if (!nextPageToken || issues.length === 0) break;
    }

    const options = [...byValue.entries()].map(([value, label]) => ({ value, label }));
    options.sort((a, b) => a.label.localeCompare(b.label));
    res.json({ fieldId, options });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/runs/active", (_req, res) => {
  if (!activeRunId) return res.json({ active: false });
  const run = runs.get(activeRunId);
  res.json({
    active: true,
    runId: activeRunId,
    status: run.status,
    mode: run.mode,
    startedAt: run.startedAt,
  });
});

app.post("/api/runs", async (req, res) => {
  if (activeRunId) {
    const active = runs.get(activeRunId);
    if (active?.status === "running") {
      return res.status(409).json({ error: "A run is already in progress", runId: activeRunId });
    }
  }

  const config = bodyToConfig(req.body);
  const runId = crypto.randomUUID();
  const controller = new AbortController();

  const run = {
    id: runId,
    status: "running",
    mode: config.mode,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    summary: null,
    error: null,
    events: [],
    subscribers: new Set(),
    controller,
  };

  runs.set(runId, run);
  activeRunId = runId;

  res.json({ runId });

  const hooks = eventHooks((event) => broadcast(run, event));

  try {
    const summary = await runSeed(config, hooks, { signal: controller.signal });
    run.status = "completed";
    run.summary = summary;
    run.exitCode = 0;
    broadcast(run, { type: "status", status: "completed", summary });
  } catch (err) {
    if (err?.name === "AbortError") {
      run.status = "cancelled";
      run.exitCode = 1;
      broadcast(run, { type: "status", status: "cancelled" });
    } else {
      run.status = "failed";
      run.error = String(err?.message || err);
      run.exitCode = 1;
      broadcast(run, { type: "error", message: run.error });
      broadcast(run, { type: "status", status: "failed", error: run.error });
    }
  } finally {
    run.finishedAt = new Date().toISOString();
    activeRunId = null;
    for (const sub of run.subscribers) {
      sub.end();
    }
    run.subscribers.clear();
  }
});

app.get("/api/runs/:id", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json({
    id: run.id,
    status: run.status,
    mode: run.mode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    summary: run.summary,
    error: run.error,
    events: run.events,
  });
});

app.get("/api/runs/:id/events", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  for (const event of run.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  run.subscribers.add(res);

  req.on("close", () => {
    run.subscribers.delete(res);
  });
});

app.post("/api/runs/:id/cancel", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  if (run.status !== "running") {
    return res.status(400).json({ error: "Run is not active", status: run.status });
  }
  run.controller.abort();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`seed-jira API listening on http://localhost:${PORT}`);
});
