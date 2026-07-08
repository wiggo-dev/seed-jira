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
      storyPoints: [1, 2, 3, 5, 8, 13],
      verbose: false,
      deleteArtifacts: false,
      boardName: "SSP",
    },
    fieldMeta: FIELD_META,
    projectKey: PROJECT_KEY,
    seedLabel: SEED_LABEL,
  });
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
