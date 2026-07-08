import crypto from "node:crypto";
import fs from "node:fs";

export const CHECKPOINT_FILE = ".seed-jira-run-checkpoint.json";
const MAX_EVENTS = 500;
const CHECKPOINT_VERSION = 1;

export function slotId(pi, epic, child) {
  return `${pi}.${epic}.${child}`;
}

export function epicSlotKey(pi, epic) {
  return `${pi}.${epic}`;
}

function emptyCheckpoint() {
  return {
    version: CHECKPOINT_VERSION,
    status: "in_progress",
    runId: null,
    startedAt: null,
    updatedAt: null,
    configFingerprint: null,
    config: null,
    phase: "setup",
    rngSeed: 7,
    dryIssueCounter: 0,
    position: { pi: 1, epic: 1, child: 0 },
    counters: { createdCount: 0, activityCount: 0, sprintAssignCount: 0 },
    piEpicKeys: {},
    slots: {},
    epicSprintDone: {},
    epicSprintBuckets: {},
    events: [],
  };
}

export function fingerprintConfig(config) {
  const payload = {
    mode: config.mode,
    dryRun: config.dryRun,
    boardId: config.boardId,
    boardName: config.boardName,
    knobs: config.knobs,
    assigneeIds: config.assigneeIds,
    reassignProb: config.reassignProb,
    epicChurnProb: config.epicChurnProb,
    productsFieldId: config.productsFieldId,
    products: config.products,
    teams: config.teams,
    storyPointsFieldId: config.storyPointsFieldId,
    storyPoints: config.storyPoints,
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function loadCheckpoint() {
  try {
    const raw = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
    if (!raw || raw.version !== CHECKPOINT_VERSION) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveCheckpoint(checkpoint) {
  checkpoint.updatedAt = new Date().toISOString();
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

export function clearCheckpoint() {
  try {
    fs.unlinkSync(CHECKPOINT_FILE);
  } catch {
    // ignore missing file
  }
}

export function isResumable(checkpoint, config) {
  if (!checkpoint || checkpoint.status !== "in_progress") return false;
  return checkpoint.configFingerprint === fingerprintConfig(config);
}

export function initCheckpoint(config, runId, fingerprint) {
  const checkpoint = emptyCheckpoint();
  checkpoint.runId = runId;
  checkpoint.startedAt = new Date().toISOString();
  checkpoint.configFingerprint = fingerprint;
  checkpoint.config = {
    mode: config.mode,
    dryRun: config.dryRun,
    boardId: config.boardId,
    boardName: config.boardName,
    knobs: { ...config.knobs },
  };
  saveCheckpoint(checkpoint);
  return checkpoint;
}

export function checkpointSummary(checkpoint) {
  if (!checkpoint || checkpoint.status !== "in_progress") {
    return { resumable: false };
  }
  const pos = checkpoint.position || { pi: 1, epic: 1, child: 0 };
  return {
    resumable: true,
    status: checkpoint.status,
    runId: checkpoint.runId,
    startedAt: checkpoint.startedAt,
    updatedAt: checkpoint.updatedAt,
    mode: checkpoint.config?.mode,
    dryRun: checkpoint.config?.dryRun,
    position: pos,
    phase: checkpoint.phase,
    counters: checkpoint.counters,
    events: checkpoint.events || [],
    configSummary: checkpoint.config,
  };
}

export function createCheckpointManager(config, { runId, fresh = false } = {}) {
  const fingerprint = fingerprintConfig(config);

  if (fresh) {
    clearCheckpoint();
  }

  let checkpoint = loadCheckpoint();
  const hadStaleCheckpoint = checkpoint?.status === "in_progress";
  const canResume = !fresh && isResumable(checkpoint, config);

  if (hadStaleCheckpoint && !canResume) {
    clearCheckpoint();
    checkpoint = null;
  }

  if (!canResume) {
    checkpoint = initCheckpoint(config, runId, fingerprint);
  }

  const appendEvent = (event) => {
    checkpoint.events = checkpoint.events || [];
    checkpoint.events.push(event);
    if (checkpoint.events.length > MAX_EVENTS) {
      checkpoint.events = checkpoint.events.slice(-MAX_EVENTS);
    }
  };

  const persist = (patch = {}) => {
    const { piEpicKeys, counters, position, phase, ...rest } = patch;
    if (piEpicKeys) {
      checkpoint.piEpicKeys = { ...checkpoint.piEpicKeys, ...piEpicKeys };
    }
    if (counters) {
      checkpoint.counters = { ...checkpoint.counters, ...counters };
    }
    if (position) {
      checkpoint.position = { ...checkpoint.position, ...position };
    }
    if (phase) checkpoint.phase = phase;
    Object.assign(checkpoint, rest);
    saveCheckpoint(checkpoint);
  };

  const syncRng = (rngSeed, dryCounter) => {
    checkpoint.rngSeed = rngSeed;
    if (dryCounter != null) checkpoint.dryIssueCounter = dryCounter;
  };

  const countCreatedSlots = (knobs) => {
    let count = 0;
    for (let pi = 1; pi <= knobs.numPIs; pi++) {
      for (let e = 1; e <= knobs.epicsPerPI; e++) {
        if (checkpoint.slots[slotId(pi, e, 0)]?.key) count++;
        for (let i = 1; i <= knobs.issuesPerEpic; i++) {
          if (checkpoint.slots[slotId(pi, e, i)]?.key) count++;
        }
      }
    }
    return count;
  };

  return {
    checkpoint,
    canResume,
    hadStaleCheckpoint: hadStaleCheckpoint && !canResume,
    appendEvent,
    persist,
    syncRng,
    countCreatedSlots,
    clear: clearCheckpoint,
  };
}

export function wrapHooksWithCheckpoint(hooks, cp) {
  const wrap = (name, build) => {
    const orig = hooks[name];
    return (...args) => {
      const event = build(...args);
      if (event) cp.appendEvent(event);
      return orig?.(...args);
    };
  };

  return {
    ...hooks,
    onSection: wrap("onSection", (title) => ({ type: "section", title })),
    onInfo: wrap("onInfo", (message) => ({ type: "info", message })),
    onLog: wrap("onLog", (message) => ({ type: "log", message })),
    onProgress: wrap("onProgress", (payload) => ({ type: "progress", ...payload })),
    onProgressDone: wrap("onProgressDone", (payload) => ({ type: "progress", ...payload, done: true })),
    onDone: (summary) => {
      cp.appendEvent({ type: "done", summary });
      return hooks.onDone?.(summary);
    },
  };
}
