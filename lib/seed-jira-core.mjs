import fs from "node:fs";
import {
  CHECKPOINT_FILE,
  createCheckpointManager,
  epicSlotKey,
  slotId,
  wrapHooksWithCheckpoint,
  clearCheckpoint,
} from "./checkpoint.mjs";

export { CHECKPOINT_FILE, clearCheckpoint, loadCheckpoint, checkpointSummary, fingerprintConfig, isResumable } from "./checkpoint.mjs";

export const PROJECT_KEY = "SSP";
export const SEED_LABEL = "seed-ssp";
export const STATE_FILE = ".seed-jira-ssp-state.json";

export const DEFAULTS = {
  numPIs: 3,
  sprintsPerPI: 2,
  epicsPerPI: 5,
  issuesPerEpic: 20,
  maxCommentsPerIssue: 4,
  maxWorklogsPerIssue: 6,
  daysOfHistory: 120,
  sleepMs: 150,
};

export const FIELD_META = {
  boardName: { label: "Board name", type: "string", group: "board" },
  boardId: { label: "Board ID", type: "number", group: "board" },
  numPIs: { label: "PIs", type: "number", group: "scale", default: DEFAULTS.numPIs },
  sprintsPerPI: { label: "Sprints per PI", type: "number", group: "scale", default: DEFAULTS.sprintsPerPI },
  epicsPerPI: { label: "Epics per PI", type: "number", group: "scale", default: DEFAULTS.epicsPerPI },
  issuesPerEpic: { label: "Issues per epic", type: "number", group: "scale", default: DEFAULTS.issuesPerEpic },
  assigneeIds: { label: "Assignee IDs (CSV)", type: "csv", group: "assignees" },
  reassignProb: { label: "Reassign probability", type: "number", group: "assignees", default: 0.1, min: 0, max: 1, step: 0.05 },
  products: { label: "Products (CSV)", type: "csv", group: "fields" },
  productsFieldId: { label: "Products field ID", type: "string", group: "fields" },
  teams: { label: "Teams (CSV)", type: "csv", group: "fields" },
  storyPoints: { label: "Story points (CSV)", type: "csv-numbers", group: "fields", default: "1,2,3,5,8,13" },
  storyPointsFieldId: { label: "Story points field ID", type: "string", group: "fields" },
  maxCommentsPerIssue: { label: "Max comments per issue", type: "number", group: "activity", default: DEFAULTS.maxCommentsPerIssue },
  maxWorklogsPerIssue: { label: "Max worklogs per issue", type: "number", group: "activity", default: DEFAULTS.maxWorklogsPerIssue },
  daysOfHistory: { label: "Days of history", type: "number", group: "activity", default: DEFAULTS.daysOfHistory },
  epicChurnProb: { label: "Epic churn probability", type: "number", group: "activity", default: 0.1, min: 0, max: 1, step: 0.05 },
  sleepMs: { label: "Sleep between API calls (ms)", type: "number", group: "activity", default: DEFAULTS.sleepMs },
  verbose: { label: "Verbose dry-run logging", type: "boolean", group: "flags" },
  deleteArtifacts: { label: "Delete sprints/versions on cleanup", type: "boolean", group: "flags" },
};

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    const isFlag = !next || next.startsWith("--");
    out[key] = isFlag ? true : next;
    if (!isFlag) i++;
  }
  return out;
}

function splitCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildConfig(input = {}) {
  const args = input._ !== undefined ? input : argvToConfigShape(input);
  const mode = args.mode
    ?? (args["delete-seeded"] ? "delete-seeded"
      : args["print-assignable-users"] ? "print-assignable-users"
      : args["print-teams"] ? "print-teams"
      : args["dry-run"] ? "dry-run"
      : "seed");

  return {
    mode,
    dryRun: mode === "dry-run" || !!args["dry-run"],
    deleteArtifacts: !!args.deleteArtifacts || !!args["delete-artifacts"],
    deleteStateFile: !!args.deleteStateFile || !!args["delete-state-file"],
    yes: !!args.yes,
    verbose: !!(args.verbose || args.v),
    boardId: args.boardId ?? args["board-id"] ? Number(args.boardId ?? args["board-id"]) : null,
    boardName: args.boardName ?? args["board-name"] ?? null,
    knobs: {
      numPIs: Number(args.numPIs ?? args["num-pis"] ?? DEFAULTS.numPIs),
      sprintsPerPI: Number(args.sprintsPerPI ?? args["sprints-per-pi"] ?? DEFAULTS.sprintsPerPI),
      epicsPerPI: Number(args.epicsPerPI ?? args["epics-per-pi"] ?? DEFAULTS.epicsPerPI),
      issuesPerEpic: Number(args.issuesPerEpic ?? args["issues-per-epic"] ?? DEFAULTS.issuesPerEpic),
      maxCommentsPerIssue: Number(args.maxCommentsPerIssue ?? args["max-comments"] ?? DEFAULTS.maxCommentsPerIssue),
      maxWorklogsPerIssue: Number(args.maxWorklogsPerIssue ?? args["max-worklogs"] ?? DEFAULTS.maxWorklogsPerIssue),
      daysOfHistory: Number(args.daysOfHistory ?? args["days-of-history"] ?? DEFAULTS.daysOfHistory),
      sleepMs: Number(args.sleepMs ?? args["sleep-ms"] ?? DEFAULTS.sleepMs),
    },
    assigneeIds: Array.isArray(args.assigneeIds)
      ? args.assigneeIds
      : splitCsv(args.assigneeIds ?? args["assignee-ids"]),
    reassignProb: Number(args.reassignProb ?? args["reassign-prob"] ?? 0.1),
    epicChurnProb: Number(args.epicChurnProb ?? args["epic-churn-prob"] ?? 0.1),
    productsFieldId: args.productsFieldId ?? args["products-field-id"] ?? "",
    products: Array.isArray(args.products) ? args.products : splitCsv(args.products),
    teams: Array.isArray(args.teams) ? args.teams : splitCsv(args.teams),
    storyPointsFieldId: args.storyPointsFieldId ?? args["story-points-field-id"] ?? "",
    storyPoints: Array.isArray(args.storyPoints)
      ? args.storyPoints.map(Number).filter((n) => Number.isFinite(n) && n >= 0)
      : splitCsv(args.storyPoints ?? args["story-points"] ?? "1,2,3,5,8,13")
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n) && n >= 0),
    env: {
      baseUrl: (args.baseUrl ?? process.env.JIRA_BASE_URL ?? "").replace(/\/$/, ""),
      email: args.email ?? process.env.JIRA_EMAIL ?? "",
      token: args.token ?? process.env.JIRA_API_TOKEN ?? "",
    },
  };
}

function argvToConfigShape(body) {
  return body;
}

export function usageText() {
  return `
Usage:
  node seed-jira-ssp.mjs [options]

Modes:
  --dry-run                 Print actions, do not mutate Jira
  --delete-seeded           Delete issues with label "${SEED_LABEL}" in project ${PROJECT_KEY}
  --delete-artifacts        With --delete-seeded, also delete seeded sprints/versions
  --delete-state-file      With --delete-seeded, also delete ${STATE_FILE}
  --print-assignable-users  List users assignable in project ${PROJECT_KEY}
  --print-teams             List Atlassian teams (id + name) known from existing issues
  --yes                     Required for --delete-seeded (safety)
  --verbose, -v             Show every dry-run API call (noisy)

Board selection:
  --board-id <id>
  --board-name <name>

Assignees:
  --assignee-ids <csv>
  --reassign-prob <0..1>    Default 0.1
  --epic-churn-prob <0..1>  Chance to remove/move/re-link epic per issue (default 0.1)

Fields:
  --products <csv>          "Product(s) Affected" values
  --products-field-id <id> Use this custom field ID for products instead of matching by name
  --teams <csv>             Atlassian Team ids or names (names resolved from existing issues)
  --story-points-field-id <id> Use this custom field ID for story points instead of matching by name
  --story-points <csv>      Default "1,2,3,5,8,13"

Generator knobs:
  --num-pis <n>  --sprints-per-pi <n>  --epics-per-pi <n>  --issues-per-epic <n>
  --max-comments <n>  --max-worklogs <n>  --days-of-history <n>  --sleep-ms <n>
                        (--days-of-history backdates worklog started dates only; changelog timestamps cannot be set)

Resume:
  --fresh                   Clear checkpoint and start a new seed run
`.trim();
}

export function cliHooks(stdout = process.stdout) {
  let lastProgressLine = false;
  return {
    onSection(title) {
      if (lastProgressLine) {
        stdout.write("\n");
        lastProgressLine = false;
      }
      stdout.write(`\n▶ ${title}\n`);
    },
    onInfo(message) {
      if (lastProgressLine) {
        stdout.write("\n");
        lastProgressLine = false;
      }
      stdout.write(`  ${message}\n`);
    },
    onLog(message) {
      if (lastProgressLine) {
        stdout.write("\n");
        lastProgressLine = false;
      }
      stdout.write(`${message}\n`);
    },
    onProgress({ label, current, total, detail }) {
      const width = 28;
      const t = total || current || 1;
      const pct = Math.min(1, current / t);
      const filled = Math.round(pct * width);
      const bar = "█".repeat(filled) + "░".repeat(width - filled);
      const count = total ? `${current}/${total}` : `${current}`;
      const d = detail ? ` — ${detail}` : "";
      stdout.write(`\r\x1b[K  ${label} [${bar}] ${count}${d}`);
      lastProgressLine = true;
    },
    onProgressDone({ label, current, total, detail }) {
      const width = 28;
      const t = total || current || 1;
      const filled = Math.round(Math.min(1, current / t) * width);
      const bar = "█".repeat(filled) + "░".repeat(width - filled);
      const count = total ? `${current}/${total}` : `${current}`;
      const d = detail ? ` — ${detail}` : "";
      stdout.write(`\r\x1b[K  ${label} [${bar}] ${count}${d}\n`);
      lastProgressLine = false;
    },
    onDone(summary) {
      if (lastProgressLine) {
        stdout.write("\n");
        lastProgressLine = false;
      }
      return summary;
    },
  };
}

export function eventHooks(emit) {
  return {
    onSection: (title) => emit({ type: "section", title }),
    onInfo: (message) => emit({ type: "info", message }),
    onLog: (message) => emit({ type: "log", message }),
    onProgress: (payload) => emit({ type: "progress", ...payload }),
    onProgressDone: (payload) => emit({ type: "progress", ...payload, done: true }),
    onDone: (summary) => {
      emit({ type: "done", summary });
      return summary;
    },
  };
}

function createProgress(hooks, label, total) {
  return {
    tick(detail = "") {
      this.current = Math.min(this.current + 1, this.total || this.current + 1);
      if (detail) this.detail = detail;
      hooks.onProgress?.({ label: this.label, current: this.current, total: this.total, detail: this.detail });
    },
    set(current, detail = "") {
      this.current = Math.min(current, this.total || current);
      if (detail) this.detail = detail;
      hooks.onProgress?.({ label: this.label, current: this.current, total: this.total, detail: this.detail });
    },
    done(message = "") {
      if (this.total) this.current = this.total;
      if (message) this.detail = message;
      hooks.onProgressDone?.({ label: this.label, current: this.current, total: this.total, detail: this.detail });
    },
    label,
    total: Math.max(0, total),
    current: 0,
    detail: "",
  };
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    const err = new Error("Run cancelled");
    err.name = "AbortError";
    throw err;
  }
}

export async function runSeed(config, hooks = {}, { signal, runId = null, fresh = false } = {}) {
  const {
    mode,
    dryRun,
    deleteArtifacts,
    deleteStateFile: DELETE_STATE_FILE,
    yes,
    verbose,
    boardId,
    boardName,
    knobs: KNOBS,
    assigneeIds: ASSIGNEE_IDS,
    reassignProb: REASSIGN_PROB,
    epicChurnProb: EPIC_CHURN_PROB,
    productsFieldId: PRODUCTS_FIELD_ID,
    products: PRODUCTS,
    teams: TEAMS,
    storyPointsFieldId: STORY_POINTS_FIELD_ID,
    storyPoints: STORY_POINTS,
    env,
  } = config;

  const BASE_URL = env.baseUrl;
  const EMAIL = env.email;
  const TOKEN = env.token;

  if (!BASE_URL || !EMAIL || !TOKEN) {
    throw new Error("Missing env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
  }

  let seed = 7;
  let dryIssueCounter = 0;

  const rand = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17; seed >>>= 0;
    seed ^= seed << 5; seed >>>= 0;
    return (seed >>> 0) / 0x100000000;
  };
  const rint = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
  const choice = (arr) => arr[Math.floor(rand() * arr.length)];
  const weightedChoice = (items) => {
    const total = items.reduce((s, i) => s + i.w, 0);
    let x = rand() * total;
    for (const it of items) {
      x -= it.w;
      if (x <= 0) return it.v;
    }
    return items[items.length - 1].v;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const logSection = (title) => hooks.onSection?.(title);
  const logInfo = (message) => hooks.onInfo?.(message);
  const logLine = (message) => hooks.onLog?.(message);

  const isSeedMode = mode === "seed" || dryRun;
  let cp = null;
  if (isSeedMode) {
    cp = createCheckpointManager(config, { runId, fresh });
    if (cp.hadStaleCheckpoint) {
      logInfo("Checkpoint config changed; starting fresh.");
    }
    hooks = wrapHooksWithCheckpoint(hooks, cp);
  }

  const saveCheckpointStep = (patch = {}) => {
    if (!cp) return;
    cp.syncRng(seed, dryIssueCounter);
    cp.persist(patch);
  };

  const basicAuthHeader = (email, token) =>
    `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;

  const jira = async (method, path, body, { allowDryRun = false } = {}) => {
    assertNotAborted(signal);
    const url = `${BASE_URL}${path}`;
    const isMutation = !["GET", "HEAD"].includes(method.toUpperCase());

    if (dryRun && isMutation && !allowDryRun) {
      if (verbose) {
        logLine(`[dry-run] ${method} ${path}${body ? ` ${JSON.stringify(body).slice(0, 300)}...` : ""}`);
      }
      return { __dryRun: true };
    }

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: basicAuthHeader(EMAIL, TOKEN),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    if (res.status === 204) return null;

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status}\n${text}`);
    }
    return text ? JSON.parse(text) : null;
  };

  const adf = (text) => ({
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

  const backdateStarted = () => {
    const now = new Date();
    const days = rint(1, KNOBS.daysOfHistory);
    const hours = rint(0, 23);
    const mins = rint(0, 59);
    const dt = new Date(now.getTime() - (((days * 24 + hours) * 60 + mins) * 60 * 1000));
    const pad = (n) => String(n).padStart(2, "0");
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}.000+0000`;
  };

  const loadState = () => {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
      return { boardId: null, versions: {}, sprints: {}, issues: [] };
    }
  };

  const saveState = (state) => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  };

  const getProject = () => jira("GET", `/rest/api/3/project/${PROJECT_KEY}`);
  const getFields = () => jira("GET", "/rest/api/3/field");
  const findFieldId = (fields, pred) => {
    const f = fields.find(pred);
    return f ? f.id : null;
  };
  const pickRandom = (arr) => (arr?.length ? choice(arr) : null);
  const findFieldByName = (fields, names) => {
    for (const name of names) {
      const want = String(name).toLowerCase();
      const f = fields.find((x) => String(x?.name || "").toLowerCase() === want);
      if (f) return f;
    }
    return null;
  };

  const TEAM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isAtlassianTeamField = (field) => {
    const schema = field?.schema || {};
    return schema.type === "team" || String(schema.custom || "").includes("atlassian-team");
  };
  const isTeamUuid = (value) => TEAM_UUID_RE.test(String(value || "").trim());

  const buildFieldValue = (field, rawValue) => {
    const schema = field?.schema || {};
    const type = schema.type;
    if (rawValue == null) return null;
    if (isAtlassianTeamField(field)) return String(rawValue);
    if (type === "array") {
      const items = schema.items;
      if (items === "option" || items === "string") return [{ value: String(rawValue) }];
      return [rawValue];
    }
    if (type === "option") return { value: String(rawValue) };
    if (type === "number") return Number(rawValue);
    return String(rawValue);
  };

  const listBoards = async () => {
    const data = await jira("GET", `/rest/agile/1.0/board?projectKeyOrId=${PROJECT_KEY}&type=scrum&maxResults=50`);
    return data.values || [];
  };

  const selectBoardId = async () => {
    if (boardId) return Number(boardId);
    const boards = await listBoards();
    if (!boards.length) {
      throw new Error(`No Scrum boards found for ${PROJECT_KEY}. Create a Scrum board first.`);
    }
    if (!boardName) return boards[0].id;
    const needle = String(boardName).toLowerCase();
    const match = boards.find((b) => String(b.name).toLowerCase().includes(needle));
    if (!match) {
      const names = boards.map((b) => `- ${b.id}: ${b.name}`).join("\n");
      throw new Error(`No scrum board matched "${boardName}". Available:\n${names}`);
    }
    return match.id;
  };

  const listSprints = async (bid) => {
    const out = [];
    let startAt = 0;
    while (true) {
      const data = await jira("GET", `/rest/agile/1.0/board/${bid}/sprint?startAt=${startAt}&maxResults=50`);
      out.push(...(data.values || []));
      if (data.isLast !== false) break;
      startAt += 50;
    }
    return out;
  };

  const ensureVersions = async (projectId, names, state, progress) => {
    const existing = await jira("GET", `/rest/api/3/project/${PROJECT_KEY}/versions`);
    const byName = new Map(existing.map((v) => [v.name, v]));
    const out = new Map();

    for (const name of names) {
      assertNotAborted(signal);
      if (byName.has(name)) {
        out.set(name, byName.get(name).id);
        state.versions[name] = byName.get(name).id;
        progress?.tick(`reused ${name}`);
        continue;
      }
      const v = await jira("POST", "/rest/api/3/version", { name, projectId, released: false });
      if (!v.__dryRun) {
        out.set(name, v.id);
        state.versions[name] = v.id;
      }
      progress?.tick(`created ${name}`);
      await sleep(KNOBS.sleepMs);
    }
    progress?.done();
    return out;
  };

  const ensureSprints = async (bid, sprintNames, state, progress) => {
    const existing = await listSprints(bid);
    const byName = new Map(existing.map((s) => [s.name, s]));
    const out = new Map();

    for (const name of sprintNames) {
      assertNotAborted(signal);
      if (byName.has(name)) {
        out.set(name, byName.get(name).id);
        state.sprints[name] = byName.get(name).id;
        progress?.tick(`reused ${name}`);
        continue;
      }
      const s = await jira("POST", "/rest/agile/1.0/sprint", { name, originBoardId: bid });
      if (!s.__dryRun) {
        out.set(name, s.id);
        state.sprints[name] = s.id;
      }
      progress?.tick(`created ${name}`);
      await sleep(KNOBS.sleepMs);
    }
    progress?.done();
    return out;
  };

  const createIssue = async (issueTypeId, summary, description, fieldsExtra, state) => {
    const res = await jira("POST", "/rest/api/3/issue", {
      fields: {
        project: { key: PROJECT_KEY },
        issuetype: { id: issueTypeId },
        summary,
        description: adf(description),
        labels: [SEED_LABEL],
        ...(fieldsExtra || {}),
      },
    });
    await sleep(KNOBS.sleepMs);
    if (res.__dryRun) {
      dryIssueCounter += 1;
      return `DRY-${dryIssueCounter}`;
    }
    state.issues.push(res.key);
    return res.key;
  };

  const addIssuesToSprint = async (sprintId, issueKeys) => {
    if (!issueKeys.length || dryRun) return;
    await jira("POST", `/rest/agile/1.0/sprint/${sprintId}/issue`, { issues: issueKeys });
    await sleep(KNOBS.sleepMs);
  };

  const addComment = async (issueKey, text) => {
    if (dryRun) return;
    await jira("POST", `/rest/api/3/issue/${issueKey}/comment`, { body: adf(text) });
    await sleep(KNOBS.sleepMs);
  };

  const addWorklog = async (issueKey, minutes, started) => {
    if (dryRun) return;
    await jira("POST", `/rest/api/3/issue/${issueKey}/worklog`, {
      timeSpentSeconds: minutes * 60,
      started,
      comment: adf("seeded work"),
    });
    await sleep(KNOBS.sleepMs);
  };

  const tryTransition = async (issueKey, wantedSubstrings) => {
    if (dryRun) return false;
    const data = await jira("GET", `/rest/api/3/issue/${issueKey}/transitions`);
    for (const w of wantedSubstrings) {
      const t = (data.transitions || []).find((x) => x.name.toLowerCase().includes(w.toLowerCase()));
      if (t) {
        await jira("POST", `/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: t.id } });
        await sleep(KNOBS.sleepMs);
        return true;
      }
    }
    return false;
  };

  const searchIssuesByJql = async (jql) => {
    const keys = [];
    let nextPageToken = null;
    while (true) {
      assertNotAborted(signal);
      const data = await jira(
        "POST",
        "/rest/api/3/search/jql",
        { jql, maxResults: 100, fields: ["key"], nextPageToken },
        { allowDryRun: true }
      );
      const issues = data.issues || data.values || [];
      keys.push(...issues.map((i) => i.key).filter(Boolean));
      nextPageToken = data.nextPageToken ?? null;
      if (!nextPageToken || issues.length === 0) break;
      await sleep(KNOBS.sleepMs);
    }
    return keys;
  };

  const deleteIssue = async (key) => {
    await jira("DELETE", `/rest/api/3/issue/${key}`);
    await sleep(KNOBS.sleepMs);
  };

  const updateIssue = async (key, fields) => {
    await jira("PUT", `/rest/api/3/issue/${key}`, { fields });
    await sleep(KNOBS.sleepMs);
  };

  const setAssignee = async (key, accountId) => {
    if (!accountId) return;
    await updateIssue(key, { assignee: { accountId } });
  };

  const resolveEpicAssociation = async (epicLinkFieldId, storyTypeId) => {
    if (!storyTypeId) {
      return epicLinkFieldId ? { mode: "epic-link", epicLinkFieldId } : { mode: null, epicLinkFieldId: null };
    }
    const meta = await jira(
      "GET",
      `/rest/api/3/issue/createmeta?projectKeys=${PROJECT_KEY}&issuetypeIds=${storyTypeId}&expand=projects.issuetypes.fields`
    );
    const createFields = meta.projects?.[0]?.issuetypes?.[0]?.fields || {};
    if (createFields.parent) return { mode: "parent", epicLinkFieldId };
    if (epicLinkFieldId && createFields[epicLinkFieldId]) {
      return { mode: "epic-link", epicLinkFieldId };
    }
    if (epicLinkFieldId) return { mode: "epic-link", epicLinkFieldId };
    return { mode: null, epicLinkFieldId: null };
  };

  const applyEpicAssociation = (fieldsExtra, epicAssoc, epicKey) => {
    if (!epicAssoc?.mode || !epicKey) return;
    if (epicAssoc.mode === "parent") {
      fieldsExtra.parent = { key: epicKey };
    } else {
      fieldsExtra[epicAssoc.epicLinkFieldId] = epicKey;
    }
  };

  const setEpicAssociation = async (key, epicAssoc, epicKey) => {
    if (!epicAssoc?.mode || dryRun) return false;
    if (epicAssoc.mode === "parent") {
      await updateIssue(key, { parent: epicKey ? { key: epicKey } : null });
    } else {
      await updateIssue(key, { [epicAssoc.epicLinkFieldId]: epicKey });
    }
    return true;
  };

  const simulateEpicChurn = async (key, epicAssoc, { currentEpicKey, piEpicKeys }, onAction) => {
    if (!epicAssoc?.mode || EPIC_CHURN_PROB <= 0 || rand() >= EPIC_CHURN_PROB) return 0;

    const otherEpics = piEpicKeys.filter((k) => k !== currentEpicKey);
    const roll = rand();
    let actions = 0;

    if (roll < 0.35) {
      if (await setEpicAssociation(key, epicAssoc, null)) {
        actions++;
        onAction?.(`${key} removed from epic`);
      }
    } else if (roll < 0.7 && otherEpics.length) {
      const target = choice(otherEpics);
      if (await setEpicAssociation(key, epicAssoc, target)) {
        actions++;
        onAction?.(`${key} moved to ${target}`);
      }
    } else if (piEpicKeys.length) {
      if (await setEpicAssociation(key, epicAssoc, null)) {
        actions++;
        onAction?.(`${key} removed from epic`);
      }
      const target = choice(piEpicKeys);
      if (await setEpicAssociation(key, epicAssoc, target)) {
        actions++;
        onAction?.(`${key} added to ${target}`);
      }
    }

    return actions;
  };

  const removeSeedLabel = async (key) => {
    const data = await jira("GET", `/rest/api/3/issue/${key}?fields=labels`);
    const labels = (data?.fields?.labels || []).filter((l) => l !== SEED_LABEL);
    await updateIssue(key, { labels });
  };

  const discoverTeams = async ({ projectKey = null, teamFieldId = "customfield_10001" } = {}) => {
    const jql = projectKey
      ? `project = ${projectKey} AND Team IS NOT EMPTY`
      : "Team IS NOT EMPTY ORDER BY updated DESC";
    const byId = new Map();
    let nextPageToken = null;

    while (true) {
      assertNotAborted(signal);
      // search/jql is a read-only operation, but Jira Cloud uses POST.
      // In dry-run mode we still need it to resolve team names -> team IDs.
      const data = await jira(
        "POST",
        "/rest/api/3/search/jql",
        { jql, maxResults: 100, fields: [teamFieldId], nextPageToken },
        { allowDryRun: true }
      );
      const issues = data.issues || data.values || [];
      for (const issue of issues) {
        const team = issue?.fields?.[teamFieldId];
        if (team?.id && !byId.has(team.id)) {
          byId.set(team.id, team.name || team.title || team.id);
        }
      }
      nextPageToken = data.nextPageToken ?? null;
      if (!nextPageToken || issues.length === 0) break;
      await sleep(KNOBS.sleepMs);
    }

    return [...byId.entries()].map(([id, name]) => ({ id, name }));
  };

  const resolveTeamInputs = (inputs, knownTeams) => {
    const byName = new Map(knownTeams.map((t) => [String(t.name).toLowerCase(), t.id]));
    const resolved = [];
    const missing = [];

    for (const input of inputs) {
      if (isTeamUuid(input)) {
        resolved.push(input);
        continue;
      }
      const id = byName.get(String(input).toLowerCase());
      if (id) {
        resolved.push(id);
        continue;
      }
      missing.push(input);
    }

    return { resolved, missing };
  };

  const listAssignableUsers = async (projectKey = PROJECT_KEY) => {
    const users = await jira(
      "GET",
      `/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=1000`
    );
    return Array.isArray(users) ? users : [];
  };

  const deleteSprint = async (id) => {
    await jira("DELETE", `/rest/agile/1.0/sprint/${id}`);
    await sleep(KNOBS.sleepMs);
  };

  const deleteVersion = async (id) => {
    await jira("DELETE", `/rest/api/3/version/${id}`);
    await sleep(KNOBS.sleepMs);
  };

  const simulateActivity = async (key, onAction, epicContext = null) => {
    let actions = 0;
    const commentCount = rint(0, KNOBS.maxCommentsPerIssue);
    const worklogCount = rint(0, KNOBS.maxWorklogsPerIssue);

    for (let c = 0; c < commentCount; c++) {
      await addComment(key, `Seed comment ${rint(1, 9999)}`);
      actions++;
      onAction?.(`${key} comment ${c + 1}/${commentCount}`);
    }

    for (let w = 0; w < worklogCount; w++) {
      await addWorklog(key, choice([15, 30, 45, 60, 90, 120]), backdateStarted());
      actions++;
      onAction?.(`${key} worklog ${w + 1}/${worklogCount}`);
    }

    if (rand() < 0.55) {
      if (await tryTransition(key, ["In Progress", "Doing", "Progress"])) {
        actions++;
        onAction?.(`${key} → in progress`);
      }
    }
    if (rand() < 0.30) {
      if (await tryTransition(key, ["Done", "Closed", "Resolved"])) {
        actions++;
        onAction?.(`${key} → done`);
      }
    }

    if (!dryRun && ASSIGNEE_IDS.length && rand() < REASSIGN_PROB) {
      await setAssignee(key, choice(ASSIGNEE_IDS));
      actions++;
      onAction?.(`${key} reassigned`);
    }

    if (epicContext) {
      actions += await simulateEpicChurn(key, epicContext.epicAssoc, epicContext, onAction);
    }

    return actions;
  };

  const deleteSeeded = async (state) => {
    if (!yes) throw new Error("Refusing to delete without --yes (safety).");

    logSection("Finding seeded issues");
    const jql = `project = ${PROJECT_KEY} AND labels = ${SEED_LABEL} ORDER BY created DESC`;
    const keys = await searchIssuesByJql(jql);
    logInfo(`Found ${keys.length} issues`);

    logSection("Deleting issues");
    const deleteProgress = createProgress(hooks, "Issues", keys.length);
    for (const k of keys) {
      assertNotAborted(signal);
      try {
        await deleteIssue(k);
        deleteProgress.tick(`deleted ${k}`);
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes("-> 403")) {
          try {
            await removeSeedLabel(k);
            deleteProgress.tick(`unlabelled ${k}`);
          } catch {
            deleteProgress.tick(`failed ${k}`);
          }
          continue;
        }
        throw e;
      }
    }
    deleteProgress.done();

    if (!deleteArtifacts) {
      logInfo("Artifacts not deleted (pass --delete-artifacts to remove sprints/versions).");
      if (!dryRun && DELETE_STATE_FILE) {
        try {
          fs.unlinkSync(STATE_FILE);
          logInfo(`Deleted state file: ${STATE_FILE}`);
        } catch {
          // ignore: state file might already be gone or locked
        }
      }
      return { deletedIssues: keys.length, artifactsDeleted: false, stateDeleted: !dryRun && DELETE_STATE_FILE };
    }

    const sprintIds = [...new Set(Object.values(state.sprints || {}))].filter(Boolean);
    const versionIds = [...new Set(Object.values(state.versions || {}))].filter(Boolean);

    if (sprintIds.length) {
      logSection("Deleting sprints");
      const sprintProgress = createProgress(hooks, "Sprints", sprintIds.length);
      for (const id of sprintIds) {
        try {
          await deleteSprint(id);
          sprintProgress.tick(`id ${id}`);
        } catch (e) {
          const msg = String(e?.message || e);
          if (msg.includes("-> 404")) {
            sprintProgress.tick(`id ${id} (not found)`);
            continue;
          }
          throw e;
        }
      }
      sprintProgress.done();
    }

    if (versionIds.length) {
      logSection("Deleting fix versions");
      const versionProgress = createProgress(hooks, "Versions", versionIds.length);
      for (const id of versionIds) {
        try {
          await deleteVersion(id);
          versionProgress.tick(`id ${id}`);
        } catch (e) {
          const msg = String(e?.message || e);
          if (msg.includes("-> 404")) {
            versionProgress.tick(`id ${id} (not found)`);
            continue;
          }
          throw e;
        }
      }
      versionProgress.done();
    }

    if (!dryRun && DELETE_STATE_FILE) {
      try {
        fs.unlinkSync(STATE_FILE);
        logInfo(`Deleted state file: ${STATE_FILE}`);
      } catch {
        // ignore: state file might already be gone or locked
      }
    }
    logInfo(DELETE_STATE_FILE ? "Done." : `Done. Consider deleting ${STATE_FILE} for a clean slate.`);
    return { deletedIssues: keys.length, artifactsDeleted: true, stateDeleted: !dryRun && DELETE_STATE_FILE };
  };

  const generate = async () => {
    const state = loadState();

    if (cp?.canResume) {
      seed = cp.checkpoint.rngSeed ?? seed;
      dryIssueCounter = cp.checkpoint.dryIssueCounter ?? 0;
      const pos = cp.checkpoint.position || { pi: 1, epic: 1, child: 0 };
      logInfo(`Resuming interrupted run from PI ${pos.pi}, Epic ${pos.epic}...`);
    }

    logSection("Connecting to Jira");
    const project = await getProject();
    const projectId = project.id;
    const fields = await getFields();

    const epicLinkFieldId = findFieldId(
      fields,
      (f) => f?.schema?.custom === "com.pyxis.greenhopper.jira:gh-epic-link"
    );
    const epicNameFieldId = findFieldId(
      fields,
      (f) => (f?.name || "").toLowerCase() === "epic name"
    );
    const storyPointsField = STORY_POINTS_FIELD_ID
      ? fields.find((f) => f.id === STORY_POINTS_FIELD_ID) || null
      : findFieldByName(fields, ["Story Points", "Story points", "Story point estimate"]);
    const productsAffectedField = PRODUCTS_FIELD_ID
      ? fields.find((f) => f.id === PRODUCTS_FIELD_ID) || null
      : findFieldByName(fields, ["Product(s) Affected", "Products Affected", "Product Affected"]);
    const teamsField = findFieldByName(fields, ["Teams", "Team"]);

    if (PRODUCTS_FIELD_ID && !productsAffectedField) {
      throw new Error(`Unknown products field id "${PRODUCTS_FIELD_ID}"`);
    }
    if (STORY_POINTS_FIELD_ID && !storyPointsField) {
      throw new Error(`Unknown story points field id "${STORY_POINTS_FIELD_ID}"`);
    }

    const issueTypes = new Map((project.issueTypes || []).map((it) => [it.name, it.id]));
    const epicTypeId = issueTypes.get("Epic");
    if (!epicTypeId) throw new Error("Could not find issue type 'Epic' in project SSP.");
    const storyTypeId = issueTypes.get("Story");
    const bugTypeId = issueTypes.get("Bug");
    const epicAssoc = await resolveEpicAssociation(epicLinkFieldId, storyTypeId);

    const selectedBoardId = await selectBoardId();
    if (state.boardId && Number(state.boardId) !== Number(selectedBoardId)) {
      logInfo(`Board changed (${state.boardId} → ${selectedBoardId}); ignoring saved sprint ids.`);
      state.sprints = {};
    }
    state.boardId = selectedBoardId;

    logInfo(`Project: ${PROJECT_KEY} (id=${projectId})`);
    logInfo(`Board: ${selectedBoardId}`);
    logInfo(`Mode: ${dryRun ? "dry-run" : "write"}`);
    logInfo(`Label: ${SEED_LABEL}`);
    if (ASSIGNEE_IDS.length) logInfo(`Assignees: ${ASSIGNEE_IDS.length}`);
    if (PRODUCTS.length) logInfo(`Products: ${PRODUCTS.length} value(s)`);
    let teamIds = [];
    if (teamsField && TEAMS.length) {
      if (isAtlassianTeamField(teamsField)) {
        const knownTeams = await discoverTeams({ projectKey: PROJECT_KEY, teamFieldId: teamsField.id });
        const { resolved, missing } = resolveTeamInputs(TEAMS, knownTeams);
        if (missing.length) {
          const available = knownTeams.length
            ? knownTeams.map((t) => `  - ${t.name}  id=${t.id}`).join("\n")
            : "  (none found — assign a Team on an issue in Jira, or pass team UUIDs)";
          throw new Error(
            `Unknown team(s): ${missing.join(", ")}\n` +
            `The Team field requires Atlassian team UUIDs, not free-text labels.\n` +
            `Run with --print-teams to list known teams, or use ids from the team profile URL.\n` +
            `Known teams from project ${PROJECT_KEY}:\n${available}`
          );
        }
        teamIds = resolved;
        logInfo(`Teams: ${teamIds.length} id(s)`);
      } else {
        teamIds = TEAMS;
        logInfo(`Teams: ${TEAMS.length} value(s)`);
      }
    }
    if (storyPointsField) logInfo(`Story points field: ${storyPointsField.name} (${storyPointsField.id})`);
    else if (STORY_POINTS.length) logInfo("Story points field not found; stories will be created without points.");
    if (productsAffectedField) logInfo(`Products field: ${productsAffectedField.name}`);
    if (teamsField) logInfo(`Teams field: ${teamsField.name}`);
    if (epicAssoc.mode) logInfo(`Epic association: ${epicAssoc.mode}`);

    const piNames = Array.from({ length: KNOBS.numPIs }, (_, i) => `SSP-PI-${i + 1}`);
    const sprintNames = [];
    for (let pi = 1; pi <= KNOBS.numPIs; pi++) {
      for (let sp = 1; sp <= KNOBS.sprintsPerPI; sp++) {
        sprintNames.push(`SSP-PI-${pi}.${sp}`);
      }
    }

    const totalIssues = KNOBS.numPIs * KNOBS.epicsPerPI * (1 + KNOBS.issuesPerEpic);

    logSection("Fix versions");
    const versionProgress = createProgress(hooks, "Versions", piNames.length);
    const versionIds = await ensureVersions(projectId, piNames, state, versionProgress);
    saveCheckpointStep({ phase: "sprints" });

    logSection("Sprints");
    const sprintProgress = createProgress(hooks, "Sprints", sprintNames.length);
    const sprintIds = await ensureSprints(selectedBoardId, sprintNames, state, sprintProgress);

    if (!dryRun) saveState(state);
    saveCheckpointStep({ phase: "issues" });

    logSection("Issues & activity");
    const issueProgress = createProgress(hooks, "Issues", totalIssues);

    let createdCount = cp?.checkpoint.counters?.createdCount ?? 0;
    let activityCount = cp?.checkpoint.counters?.activityCount ?? 0;
    let sprintAssignCount = cp?.checkpoint.counters?.sprintAssignCount ?? 0;

    if (cp?.canResume) {
      issueProgress.current = cp.countCreatedSlots(KNOBS);
      issueProgress.set(issueProgress.current, "resuming");
    }

    const slots = cp?.checkpoint.slots ?? {};
    const epicSprintDone = cp?.checkpoint.epicSprintDone ?? {};
    const epicSprintBuckets = cp?.checkpoint.epicSprintBuckets ?? {};
    const piEpicKeysMap = cp?.checkpoint.piEpicKeys ?? {};
    if (cp && !cp.checkpoint.slots) cp.checkpoint.slots = slots;
    if (cp && !cp.checkpoint.epicSprintDone) cp.checkpoint.epicSprintDone = epicSprintDone;
    if (cp && !cp.checkpoint.epicSprintBuckets) cp.checkpoint.epicSprintBuckets = epicSprintBuckets;
    if (cp && !cp.checkpoint.piEpicKeys) cp.checkpoint.piEpicKeys = piEpicKeysMap;

    for (let pi = 1; pi <= KNOBS.numPIs; pi++) {
      assertNotAborted(signal);
      const piName = `SSP-PI-${pi}`;
      const piKey = String(pi);
      const fixVersionId = state.versions[piName] || versionIds.get(piName);
      const fixVersions = fixVersionId ? [{ id: fixVersionId }] : [];
      const piSprints = Array.from({ length: KNOBS.sprintsPerPI }, (_, i) => `SSP-PI-${pi}.${i + 1}`);
      const piEpicKeys = [...(piEpicKeysMap[piKey] || [])];

      for (let e = 1; e <= KNOBS.epicsPerPI; e++) {
        assertNotAborted(signal);
        const epicSlotId = slotId(pi, e, 0);
        let epicSlot = slots[epicSlotId];
        let epicKey;

        if (epicSlot?.key) {
          epicKey = epicSlot.key;
          if (piEpicKeys.length < e) piEpicKeys.push(epicKey);
        } else {
          const epicSummary = `[${SEED_LABEL}] ${piName} Epic ${e}: capability area ${rint(1, 30)}`;
          const epicFields = { fixVersions };
          const epicName = `${piName} Epic ${e}`;
          if (epicNameFieldId) epicFields[epicNameFieldId] = epicName;
          let assigneeId = null;
          if (ASSIGNEE_IDS.length) {
            assigneeId = choice(ASSIGNEE_IDS);
            epicFields.assignee = { accountId: assigneeId };
          }

          epicKey = await createIssue(epicTypeId, epicSummary, `Seed epic for ${piName}.`, epicFields, state);
          epicSlot = {
            kind: "epic",
            key: epicKey,
            summary: epicSummary,
            epicName,
            assigneeId,
            created: true,
          };
          slots[epicSlotId] = epicSlot;
          piEpicKeys.push(epicKey);
          createdCount++;
          issueProgress.tick(`${piName} epic ${epicKey}`);
          saveCheckpointStep({
            position: { pi, epic: e, child: 0 },
            piEpicKeys: { [piKey]: [...piEpicKeys] },
            counters: { createdCount, activityCount, sprintAssignCount },
          });
        }

        const sprintCandidateKeys = [];

        for (let i = 1; i <= KNOBS.issuesPerEpic; i++) {
          assertNotAborted(signal);
          const childSlotId = slotId(pi, e, i);
          let childSlot = slots[childSlotId];

          if (childSlot?.key) {
            const key = childSlot.key;
            if (!childSlot.activityDone) {
              const actions = await simulateActivity(
                key,
                (detail) => issueProgress.set(issueProgress.current, detail),
                epicAssoc.mode ? { epicAssoc, currentEpicKey: epicKey, piEpicKeys } : null
              );
              activityCount += actions;
              childSlot.activityDone = true;
              slots[childSlotId] = childSlot;
              saveCheckpointStep({
                position: { pi, epic: e, child: i },
                counters: { createdCount, activityCount, sprintAssignCount },
              });
            }
            if (childSlot.typeName === "Story" || childSlot.typeName === "Bug") {
              sprintCandidateKeys.push(key);
            }
            continue;
          }

          const typeName = weightedChoice([
            { v: "Story", w: 0.8 },
            { v: "Bug", w: 0.2 },
          ]);
          const typeId = typeName === "Story" ? storyTypeId : typeName === "Bug" ? bugTypeId : null;
          if (!typeId) continue;

          const summary = `[${SEED_LABEL}] ${piName} ${typeName} ${e}.${i}: implement thing ${rint(100, 999)}`;
          const fieldsExtra = { fixVersions };
          if (ASSIGNEE_IDS.length) fieldsExtra.assignee = { accountId: choice(ASSIGNEE_IDS) };
          if (productsAffectedField && PRODUCTS.length) {
            const val = buildFieldValue(productsAffectedField, pickRandom(PRODUCTS));
            if (val != null) fieldsExtra[productsAffectedField.id] = val;
          }
          if (teamsField && teamIds.length) {
            const val = buildFieldValue(teamsField, pickRandom(teamIds));
            if (val != null) fieldsExtra[teamsField.id] = val;
          }
          if (typeName === "Story" && storyPointsField && STORY_POINTS.length) {
            const val = buildFieldValue(storyPointsField, pickRandom(STORY_POINTS));
            if (val != null) fieldsExtra[storyPointsField.id] = val;
          }
          applyEpicAssociation(fieldsExtra, epicAssoc, epicKey);

          const key = await createIssue(typeId, summary, "Seed issue with simulated activity.", fieldsExtra, state);
          childSlot = {
            kind: "child",
            typeName,
            key,
            summary,
            fieldsExtra,
            created: true,
            activityDone: false,
          };
          slots[childSlotId] = childSlot;
          createdCount++;
          issueProgress.tick(`${typeName} ${key}`);
          if (typeName === "Story" || typeName === "Bug") sprintCandidateKeys.push(key);

          saveCheckpointStep({
            position: { pi, epic: e, child: i },
            counters: { createdCount, activityCount, sprintAssignCount },
          });

          const actions = await simulateActivity(
            key,
            (detail) => issueProgress.set(issueProgress.current, detail),
            epicAssoc.mode ? { epicAssoc, currentEpicKey: epicKey, piEpicKeys } : null
          );
          activityCount += actions;
          childSlot.activityDone = true;
          slots[childSlotId] = childSlot;
          saveCheckpointStep({
            counters: { createdCount, activityCount, sprintAssignCount },
          });
        }

        const epicKeyStr = epicSlotKey(pi, e);
        if (!epicSprintDone[epicKeyStr]) {
          let buckets = epicSprintBuckets[epicKeyStr];
          if (!buckets) {
            buckets = Object.fromEntries(piSprints.map((s) => [s, []]));
            for (const k of sprintCandidateKeys) {
              buckets[choice(piSprints)].push(k);
            }
            epicSprintBuckets[epicKeyStr] = buckets;
            saveCheckpointStep({});
          }

          for (const [sname, keys] of Object.entries(buckets)) {
            if (!keys.length) continue;
            const sid = sprintIds.get(sname) || state.sprints[sname];
            if (!sid) continue;
            await addIssuesToSprint(sid, keys);
            sprintAssignCount += keys.length;
            issueProgress.set(issueProgress.current, `sprint ${keys.length} → ${sname}`);
          }
          epicSprintDone[epicKeyStr] = true;
          saveCheckpointStep({
            counters: { createdCount, activityCount, sprintAssignCount },
          });
        }

        piEpicKeysMap[piKey] = [...piEpicKeys];
        if (!dryRun) saveState(state);
        const nextEpic = e + 1;
        const nextPi = nextEpic > KNOBS.epicsPerPI ? pi + 1 : pi;
        const nextEpicIndex = nextEpic > KNOBS.epicsPerPI ? 1 : nextEpic;
        saveCheckpointStep({
          position: { pi: nextPi, epic: nextEpicIndex, child: 0 },
          piEpicKeys: { [piKey]: [...piEpicKeys] },
        });
        await sleep(KNOBS.sleepMs);
      }
    }

    issueProgress.done(`created ${createdCount}, ${activityCount} activity actions, ${sprintAssignCount} sprinted`);

    logSection("Summary");
    logInfo(`Created ${createdCount} issues`);
    logInfo(`Activity actions: ${activityCount}`);
    logInfo(`Sprint assignments: ${sprintAssignCount}`);
    logInfo(`Search: project = ${PROJECT_KEY} AND labels = ${SEED_LABEL}`);
    if (!dryRun) logInfo(`State saved: ${STATE_FILE}`);

    cp?.clear();
    return { createdCount, activityCount, sprintAssignCount, dryRun, resumed: !!cp?.canResume };
  };

  if (mode === "print-assignable-users") {
    logSection("Assignable users");
    const users = await listAssignableUsers(PROJECT_KEY);
    for (const u of users) {
      const display = u.displayName || "(no name)";
      const email = u.emailAddress ? ` <${u.emailAddress}>` : "";
      logLine(`  ${display}${email}  accountId=${u.accountId}`);
    }
    const summary = { users: users.length };
    hooks.onDone?.(summary);
    return summary;
  }

  if (mode === "print-teams") {
    const fields = await getFields();
    const teamsField = findFieldByName(fields, ["Teams", "Team"]);
    if (!teamsField || !isAtlassianTeamField(teamsField)) {
      throw new Error("Could not find an Atlassian Team custom field in this Jira site.");
    }
    logSection("Known teams");
    const projectTeams = await discoverTeams({ projectKey: PROJECT_KEY, teamFieldId: teamsField.id });
    if (!projectTeams.length) {
      logInfo(`No teams found on issues in project ${PROJECT_KEY}.`);
      logInfo("Assign a Team on any issue, or copy ids from Jira → Teams → team profile URL.");
      const summary = { teams: 0 };
      hooks.onDone?.(summary);
      return summary;
    }
    for (const t of projectTeams) {
      logLine(`  ${t.name}  id=${t.id}`);
    }
    const summary = { teams: projectTeams.length };
    hooks.onDone?.(summary);
    return summary;
  }

  if (mode === "delete-seeded") {
    clearCheckpoint();
    const summary = await deleteSeeded(loadState());
    hooks.onDone?.(summary);
    return summary;
  }

  const summary = await generate();
  hooks.onDone?.(summary);
  return summary;
}
