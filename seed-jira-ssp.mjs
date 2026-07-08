import "dotenv/config";
import fs from "node:fs";

const BASE_URL = (process.env.JIRA_BASE_URL || "").replace(/\/$/, "");
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;

const PROJECT_KEY = "SSP";
const SEED_LABEL = "seed-ssp";
const STATE_FILE = ".seed-jira-ssp-state.json";

const DEFAULTS = {
  numPIs: 3,
  sprintsPerPI: 2,
  epicsPerPI: 5,
  issuesPerEpic: 20,
  maxCommentsPerIssue: 4,
  maxWorklogsPerIssue: 6,
  daysOfHistory: 120,
  sleepMs: 150,
};

function usage() {
  console.log(`
Usage:
  node seed-jira-ssp.mjs [options]

Modes:
  --dry-run                 Print actions, do not mutate Jira
  --delete-seeded           Delete issues with label "${SEED_LABEL}" in project ${PROJECT_KEY}
  --delete-artifacts        With --delete-seeded, also delete seeded sprints/versions
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

Fields:
  --products <csv>          "Product(s) Affected" values
  --teams <csv>             Atlassian Team ids or names (names resolved from existing issues)
  --story-points <csv>      Default "1,2,3,5,8,13"

Generator knobs:
  --num-pis <n>  --sprints-per-pi <n>  --epics-per-pi <n>  --issues-per-epic <n>
  --max-comments <n>  --max-worklogs <n>  --days-of-history <n>  --sleep-ms <n>
`.trim());
}

function parseArgs(argv) {
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

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  usage();
  process.exit(0);
}

const DRY_RUN = !!args["dry-run"];
const DELETE_MODE = !!args["delete-seeded"];
const DELETE_ARTIFACTS = !!args["delete-artifacts"];
const PRINT_ASSIGNABLE_USERS = !!args["print-assignable-users"];
const PRINT_TEAMS = !!args["print-teams"];
const YES = !!args["yes"];
const VERBOSE = !!(args.verbose || args.v);

const KNOBS = {
  numPIs: Number(args["num-pis"] ?? DEFAULTS.numPIs),
  sprintsPerPI: Number(args["sprints-per-pi"] ?? DEFAULTS.sprintsPerPI),
  epicsPerPI: Number(args["epics-per-pi"] ?? DEFAULTS.epicsPerPI),
  issuesPerEpic: Number(args["issues-per-epic"] ?? DEFAULTS.issuesPerEpic),
  maxCommentsPerIssue: Number(args["max-comments"] ?? DEFAULTS.maxCommentsPerIssue),
  maxWorklogsPerIssue: Number(args["max-worklogs"] ?? DEFAULTS.maxWorklogsPerIssue),
  daysOfHistory: Number(args["days-of-history"] ?? DEFAULTS.daysOfHistory),
  sleepMs: Number(args["sleep-ms"] ?? DEFAULTS.sleepMs),
};

const ASSIGNEE_IDS = String(args["assignee-ids"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REASSIGN_PROB = Number(args["reassign-prob"] ?? 0.1);

const PRODUCTS = String(args["products"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TEAMS = String(args["teams"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const STORY_POINTS = String(args["story-points"] ?? "1,2,3,5,8,13")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0);

if (!BASE_URL || !EMAIL || !TOKEN) {
  console.error("Missing env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
  process.exit(1);
}

let seed = 7;
let dryIssueCounter = 0;

function rand() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17; seed >>>= 0;
  seed ^= seed << 5; seed >>>= 0;
  return (seed >>> 0) / 0x100000000;
}
function rint(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}
function choice(arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function weightedChoice(items) {
  const total = items.reduce((s, i) => s + i.w, 0);
  let x = rand() * total;
  for (const it of items) {
    x -= it.w;
    if (x <= 0) return it.v;
  }
  return items[items.length - 1].v;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function logSection(title) {
  process.stdout.write(`\n▶ ${title}\n`);
}

function logInfo(message) {
  console.log(`  ${message}`);
}

class ProgressBar {
  constructor(label, total, { width = 28 } = {}) {
    this.label = label;
    this.total = Math.max(0, total);
    this.current = 0;
    this.width = width;
    this.detail = "";
  }

  tick(detail = "") {
    this.current = Math.min(this.current + 1, this.total || this.current + 1);
    if (detail) this.detail = detail;
    this.render();
  }

  set(current, detail = "") {
    this.current = Math.min(current, this.total || current);
    if (detail) this.detail = detail;
    this.render();
  }

  done(message = "") {
    if (this.total) this.current = this.total;
    if (message) this.detail = message;
    this.render();
    process.stdout.write("\n");
  }

  render() {
    const total = this.total || this.current || 1;
    const pct = Math.min(1, this.current / total);
    const filled = Math.round(pct * this.width);
    const bar = "█".repeat(filled) + "░".repeat(this.width - filled);
    const count = this.total ? `${this.current}/${this.total}` : `${this.current}`;
    const detail = this.detail ? ` — ${this.detail}` : "";
    process.stdout.write(`\r\x1b[K  ${this.label} [${bar}] ${count}${detail}`);
  }
}

function basicAuthHeader(email, token) {
  const b64 = Buffer.from(`${email}:${token}`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

async function jira(method, path, body, { allowDryRun = false } = {}) {
  const url = `${BASE_URL}${path}`;
  const isMutation = !["GET", "HEAD"].includes(method.toUpperCase());

  if (DRY_RUN && isMutation && !allowDryRun) {
    if (VERBOSE) {
      console.log(`[dry-run] ${method} ${path}${body ? ` ${JSON.stringify(body).slice(0, 300)}...` : ""}`);
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
  });

  if (res.status === 204) return null;

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}\n${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function adf(text) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function backdateStarted() {
  const now = new Date();
  const days = rint(1, KNOBS.daysOfHistory);
  const hours = rint(0, 23);
  const mins = rint(0, 59);
  const dt = new Date(now.getTime() - (((days * 24 + hours) * 60 + mins) * 60 * 1000));
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}.000+0000`;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { boardId: null, versions: {}, sprints: {}, issues: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function getProject() {
  return jira("GET", `/rest/api/3/project/${PROJECT_KEY}`);
}

async function getFields() {
  return jira("GET", "/rest/api/3/field");
}

function findFieldId(fields, pred) {
  const f = fields.find(pred);
  return f ? f.id : null;
}

function pickRandom(arr) {
  return arr?.length ? choice(arr) : null;
}

function findFieldByName(fields, names) {
  const want = names.map((n) => n.toLowerCase());
  return fields.find((f) => want.includes(String(f?.name || "").toLowerCase())) || null;
}

const TEAM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAtlassianTeamField(field) {
  const schema = field?.schema || {};
  return (
    schema.type === "team" ||
    String(schema.custom || "").includes("atlassian-team")
  );
}

function isTeamUuid(value) {
  return TEAM_UUID_RE.test(String(value || "").trim());
}

function buildFieldValue(field, rawValue) {
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
}

async function listBoards() {
  const data = await jira("GET", `/rest/agile/1.0/board?projectKeyOrId=${PROJECT_KEY}&type=scrum&maxResults=50`);
  return data.values || [];
}

async function selectBoardId() {
  if (args["board-id"]) return Number(args["board-id"]);
  const boards = await listBoards();
  if (!boards.length) {
    throw new Error(`No Scrum boards found for ${PROJECT_KEY}. Create a Scrum board first.`);
  }
  if (!args["board-name"]) return boards[0].id;
  const needle = String(args["board-name"]).toLowerCase();
  const match = boards.find((b) => String(b.name).toLowerCase().includes(needle));
  if (!match) {
    const names = boards.map((b) => `- ${b.id}: ${b.name}`).join("\n");
    throw new Error(`No scrum board matched "${args["board-name"]}". Available:\n${names}`);
  }
  return match.id;
}

async function listSprints(boardId) {
  const out = [];
  let startAt = 0;
  while (true) {
    const data = await jira("GET", `/rest/agile/1.0/board/${boardId}/sprint?startAt=${startAt}&maxResults=50`);
    out.push(...(data.values || []));
    if (data.isLast !== false) break;
    startAt += 50;
  }
  return out;
}

async function ensureVersions(projectId, names, state, progress) {
  const existing = await jira("GET", `/rest/api/3/project/${PROJECT_KEY}/versions`);
  const byName = new Map(existing.map((v) => [v.name, v]));
  const out = new Map();

  for (const name of names) {
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
}

async function ensureSprints(boardId, sprintNames, state, progress) {
  const existing = await listSprints(boardId);
  const byName = new Map(existing.map((s) => [s.name, s]));
  const out = new Map();

  for (const name of sprintNames) {
    if (byName.has(name)) {
      out.set(name, byName.get(name).id);
      state.sprints[name] = byName.get(name).id;
      progress?.tick(`reused ${name}`);
      continue;
    }
    const s = await jira("POST", "/rest/agile/1.0/sprint", { name, originBoardId: boardId });
    if (!s.__dryRun) {
      out.set(name, s.id);
      state.sprints[name] = s.id;
    }
    progress?.tick(`created ${name}`);
    await sleep(KNOBS.sleepMs);
  }
  progress?.done();
  return out;
}

async function createIssue(issueTypeId, summary, description, fieldsExtra, state) {
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
}

async function addIssuesToSprint(sprintId, issueKeys) {
  if (!issueKeys.length || DRY_RUN) return;
  await jira("POST", `/rest/agile/1.0/sprint/${sprintId}/issue`, { issues: issueKeys });
  await sleep(KNOBS.sleepMs);
}

async function addComment(issueKey, text) {
  if (DRY_RUN) return;
  await jira("POST", `/rest/api/3/issue/${issueKey}/comment`, { body: adf(text) });
  await sleep(KNOBS.sleepMs);
}

async function addWorklog(issueKey, minutes, started) {
  if (DRY_RUN) return;
  await jira("POST", `/rest/api/3/issue/${issueKey}/worklog`, {
    timeSpentSeconds: minutes * 60,
    started,
    comment: adf("seeded work"),
  });
  await sleep(KNOBS.sleepMs);
}

async function tryTransition(issueKey, wantedSubstrings) {
  if (DRY_RUN) return false;
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
}

async function searchIssuesByJql(jql) {
  const keys = [];
  let nextPageToken = null;
  while (true) {
    const data = await jira("POST", "/rest/api/3/search/jql", {
      jql,
      maxResults: 100,
      fields: ["key"],
      nextPageToken,
    });
    const issues = data.issues || data.values || [];
    keys.push(...issues.map((i) => i.key).filter(Boolean));
    nextPageToken = data.nextPageToken ?? null;
    if (!nextPageToken || issues.length === 0) break;
    await sleep(KNOBS.sleepMs);
  }
  return keys;
}

async function deleteIssue(key) {
  await jira("DELETE", `/rest/api/3/issue/${key}`);
  await sleep(KNOBS.sleepMs);
}

async function updateIssue(key, fields) {
  await jira("PUT", `/rest/api/3/issue/${key}`, { fields });
  await sleep(KNOBS.sleepMs);
}

async function setAssignee(key, accountId) {
  if (!accountId) return;
  await updateIssue(key, { assignee: { accountId } });
}

async function removeSeedLabel(key) {
  const data = await jira("GET", `/rest/api/3/issue/${key}?fields=labels`);
  const labels = (data?.fields?.labels || []).filter((l) => l !== SEED_LABEL);
  await updateIssue(key, { labels });
}

async function discoverTeams({ projectKey = null, teamFieldId = "customfield_10001" } = {}) {
  const jql = projectKey
    ? `project = ${projectKey} AND Team IS NOT EMPTY`
    : "Team IS NOT EMPTY ORDER BY updated DESC";
  const byId = new Map();
  let nextPageToken = null;

  while (true) {
    const data = await jira("POST", "/rest/api/3/search/jql", {
      jql,
      maxResults: 100,
      fields: [teamFieldId],
      nextPageToken,
    });
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
}

function resolveTeamInputs(inputs, knownTeams) {
  const byId = new Map(knownTeams.map((t) => [t.id, t]));
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
}

async function listAssignableUsers(projectKey = PROJECT_KEY) {
  const users = await jira(
    "GET",
    `/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=1000`
  );
  return Array.isArray(users) ? users : [];
}

async function deleteSprint(id) {
  await jira("DELETE", `/rest/agile/1.0/sprint/${id}`);
  await sleep(KNOBS.sleepMs);
}

async function deleteVersion(id) {
  await jira("DELETE", `/rest/api/3/version/${id}`);
  await sleep(KNOBS.sleepMs);
}

async function simulateActivity(key, onAction) {
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

  if (!DRY_RUN && ASSIGNEE_IDS.length && rand() < REASSIGN_PROB) {
    await setAssignee(key, choice(ASSIGNEE_IDS));
    actions++;
    onAction?.(`${key} reassigned`);
  }

  return actions;
}

async function deleteSeeded(state) {
  if (!YES) throw new Error("Refusing to delete without --yes (safety).");

  logSection("Finding seeded issues");
  const jql = `project = ${PROJECT_KEY} AND labels = ${SEED_LABEL} ORDER BY created DESC`;
  const keys = await searchIssuesByJql(jql);
  logInfo(`Found ${keys.length} issues`);

  logSection("Deleting issues");
  const deleteProgress = new ProgressBar("Issues", keys.length);
  for (const k of keys) {
    try {
      await deleteIssue(k);
      deleteProgress.tick(`deleted ${k}`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("-> 403")) {
        try {
          await removeSeedLabel(k);
          deleteProgress.tick(`unlabelled ${k}`);
        } catch (e2) {
          deleteProgress.tick(`failed ${k}`);
        }
        continue;
      }
      throw e;
    }
  }
  deleteProgress.done();

  if (!DELETE_ARTIFACTS) {
    logInfo("Artifacts not deleted (pass --delete-artifacts to remove sprints/versions).");
    return;
  }

  const sprintIds = [...new Set(Object.values(state.sprints || {}))].filter(Boolean);
  const versionIds = [...new Set(Object.values(state.versions || {}))].filter(Boolean);

  if (sprintIds.length) {
    logSection("Deleting sprints");
    const sprintProgress = new ProgressBar("Sprints", sprintIds.length);
    for (const id of sprintIds) {
      await deleteSprint(id);
      sprintProgress.tick(`id ${id}`);
    }
    sprintProgress.done();
  }

  if (versionIds.length) {
    logSection("Deleting fix versions");
    const versionProgress = new ProgressBar("Versions", versionIds.length);
    for (const id of versionIds) {
      await deleteVersion(id);
      versionProgress.tick(`id ${id}`);
    }
    versionProgress.done();
  }

  logInfo(`Done. Consider deleting ${STATE_FILE} for a clean slate.`);
}

async function generate() {
  const state = loadState();

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
  const storyPointsField = findFieldByName(fields, ["Story point estimate", "Story Points", "Story points"]);
  const productsAffectedField = findFieldByName(fields, ["Product(s) Affected", "Products Affected", "Product Affected"]);
  const teamsField = findFieldByName(fields, ["Teams", "Team"]);

  const issueTypes = new Map((project.issueTypes || []).map((it) => [it.name, it.id]));
  const epicTypeId = issueTypes.get("Epic");
  if (!epicTypeId) throw new Error("Could not find issue type 'Epic' in project SSP.");
  const storyTypeId = issueTypes.get("Story");
  const bugTypeId = issueTypes.get("Bug");

  const boardId = await selectBoardId();
  if (state.boardId && Number(state.boardId) !== Number(boardId)) {
    logInfo(`Board changed (${state.boardId} → ${boardId}); ignoring saved sprint ids.`);
    state.sprints = {};
  }
  state.boardId = boardId;

  logInfo(`Project: ${PROJECT_KEY} (id=${projectId})`);
  logInfo(`Board: ${boardId}`);
  logInfo(`Mode: ${DRY_RUN ? "dry-run" : "write"}`);
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
  if (storyPointsField) logInfo(`Story points field: ${storyPointsField.name}`);
  if (productsAffectedField) logInfo(`Products field: ${productsAffectedField.name}`);
  if (teamsField) logInfo(`Teams field: ${teamsField.name}`);

  const piNames = Array.from({ length: KNOBS.numPIs }, (_, i) => `SSP-PI-${i + 1}`);
  const sprintNames = [];
  for (let pi = 1; pi <= KNOBS.numPIs; pi++) {
    for (let sp = 1; sp <= KNOBS.sprintsPerPI; sp++) {
      sprintNames.push(`SSP-PI-${pi}.${sp}`);
    }
  }

  const totalIssues = KNOBS.numPIs * KNOBS.epicsPerPI * (1 + KNOBS.issuesPerEpic);

  logSection("Fix versions");
  const versionProgress = new ProgressBar("Versions", piNames.length);
  const versionIds = await ensureVersions(projectId, piNames, state, versionProgress);

  logSection("Sprints");
  const sprintProgress = new ProgressBar("Sprints", sprintNames.length);
  const sprintIds = await ensureSprints(boardId, sprintNames, state, sprintProgress);

  if (!DRY_RUN) saveState(state);

  logSection("Issues & activity");
  const issueProgress = new ProgressBar("Issues", totalIssues);

  let createdCount = 0;
  let activityCount = 0;
  let sprintAssignCount = 0;

  for (let pi = 1; pi <= KNOBS.numPIs; pi++) {
    const piName = `SSP-PI-${pi}`;
    const fixVersionId = state.versions[piName] || versionIds.get(piName);
    const fixVersions = fixVersionId ? [{ id: fixVersionId }] : [];
    const piSprints = Array.from({ length: KNOBS.sprintsPerPI }, (_, i) => `SSP-PI-${pi}.${i + 1}`);

    for (let e = 1; e <= KNOBS.epicsPerPI; e++) {
      const epicSummary = `[${SEED_LABEL}] ${piName} Epic ${e}: capability area ${rint(1, 30)}`;
      const epicFields = { fixVersions };
      if (epicNameFieldId) epicFields[epicNameFieldId] = `${piName} Epic ${e}`;
      if (ASSIGNEE_IDS.length) epicFields.assignee = { accountId: choice(ASSIGNEE_IDS) };

      const epicKey = await createIssue(epicTypeId, epicSummary, `Seed epic for ${piName}.`, epicFields, state);
      createdCount++;
      issueProgress.tick(`${piName} epic ${epicKey}`);

      const sprintCandidateKeys = [];

      for (let i = 1; i <= KNOBS.issuesPerEpic; i++) {
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
        if (epicLinkFieldId) fieldsExtra[epicLinkFieldId] = epicKey;
        else fieldsExtra.parent = { key: epicKey };

        const key = await createIssue(typeId, summary, "Seed issue with simulated activity.", fieldsExtra, state);
        createdCount++;
        issueProgress.tick(`${typeName} ${key}`);
        if (typeName === "Story" || typeName === "Bug") sprintCandidateKeys.push(key);

        const actions = await simulateActivity(key, (detail) => issueProgress.set(issueProgress.current, detail));
        activityCount += actions;
      }

      const buckets = new Map(piSprints.map((s) => [s, []]));
      for (const k of sprintCandidateKeys) buckets.get(choice(piSprints)).push(k);

      for (const [sname, keys] of buckets.entries()) {
        if (!keys.length) continue;
        const sid = sprintIds.get(sname) || state.sprints[sname];
        if (!sid) continue;
        await addIssuesToSprint(sid, keys);
        sprintAssignCount += keys.length;
        issueProgress.set(issueProgress.current, `sprint ${keys.length} → ${sname}`);
      }

      if (!DRY_RUN) saveState(state);
      await sleep(KNOBS.sleepMs);
    }
  }

  issueProgress.done(`created ${createdCount}, ${activityCount} activity actions, ${sprintAssignCount} sprinted`);

  logSection("Summary");
  logInfo(`Created ${createdCount} issues`);
  logInfo(`Activity actions: ${activityCount}`);
  logInfo(`Sprint assignments: ${sprintAssignCount}`);
  logInfo(`Search: project = ${PROJECT_KEY} AND labels = ${SEED_LABEL}`);
  if (!DRY_RUN) logInfo(`State saved: ${STATE_FILE}`);
}

async function main() {
  if (PRINT_ASSIGNABLE_USERS) {
    logSection("Assignable users");
    const users = await listAssignableUsers(PROJECT_KEY);
    for (const u of users) {
      const display = u.displayName || "(no name)";
      const email = u.emailAddress ? ` <${u.emailAddress}>` : "";
      console.log(`  ${display}${email}  accountId=${u.accountId}`);
    }
    return;
  }
  if (PRINT_TEAMS) {
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
      return;
    }
    for (const t of projectTeams) {
      console.log(`  ${t.name}  id=${t.id}`);
    }
    return;
  }
  if (DELETE_MODE) {
    await deleteSeeded(loadState());
    return;
  }
  await generate();
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
