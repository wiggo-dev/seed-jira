import type { ActiveRunResponse, CheckpointResponse, DefaultsResponse, EnvStatus, RunMode, Settings } from "./types";

const SETTINGS_KEY = "seed-jira-settings";

export const defaultSettings: Settings = {
  boardName: "SSP",
  boardId: "",
  numPIs: 3,
  sprintsPerPI: 2,
  epicsPerPI: 5,
  issuesPerEpic: 20,
  assigneeIds: "",
  reassignProb: 0.1,
  epicChurnProb: 0.1,
  products: "",
  productsFieldId: "",
  teams: "",
  storyPoints: "1,2,3,5,8,13",
  maxCommentsPerIssue: 4,
  maxWorklogsPerIssue: 6,
  daysOfHistory: 120,
  sleepMs: 150,
  verbose: false,
  deleteArtifacts: false,
  deleteConfirmed: false,
  deleteStateFile: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function mergeDefaults(data: DefaultsResponse): Settings {
  const d = data.defaults;
  return {
    ...defaultSettings,
    boardName: d.boardName ?? defaultSettings.boardName,
    numPIs: d.numPIs ?? defaultSettings.numPIs,
    sprintsPerPI: d.sprintsPerPI ?? defaultSettings.sprintsPerPI,
    epicsPerPI: d.epicsPerPI ?? defaultSettings.epicsPerPI,
    issuesPerEpic: d.issuesPerEpic ?? defaultSettings.issuesPerEpic,
    reassignProb: d.reassignProb ?? defaultSettings.reassignProb,
    epicChurnProb: d.epicChurnProb ?? defaultSettings.epicChurnProb,
    productsFieldId: d.productsFieldId ?? defaultSettings.productsFieldId,
    storyPoints: Array.isArray(d.storyPoints)
      ? d.storyPoints.join(",")
      : defaultSettings.storyPoints,
    maxCommentsPerIssue: d.maxCommentsPerIssue ?? defaultSettings.maxCommentsPerIssue,
    maxWorklogsPerIssue: d.maxWorklogsPerIssue ?? defaultSettings.maxWorklogsPerIssue,
    daysOfHistory: d.daysOfHistory ?? defaultSettings.daysOfHistory,
    sleepMs: d.sleepMs ?? defaultSettings.sleepMs,
    verbose: d.verbose ?? defaultSettings.verbose,
    deleteArtifacts: d.deleteArtifacts ?? defaultSettings.deleteArtifacts,
    deleteStateFile: d.deleteStateFile ?? defaultSettings.deleteStateFile,
  };
}

export function settingsToPayload(settings: Settings, mode: RunMode) {
  const splitCsv = (s: string) =>
    s.split(",").map((x) => x.trim()).filter(Boolean);

  return {
    mode,
    dryRun: mode === "dry-run",
    yes: mode === "delete-seeded" ? settings.deleteConfirmed : undefined,
    deleteArtifacts: settings.deleteArtifacts,
    deleteStateFile: settings.deleteStateFile,
    verbose: settings.verbose,
    boardName: settings.boardName || undefined,
    boardId: settings.boardId ? Number(settings.boardId) : undefined,
    productsFieldId: settings.productsFieldId || undefined,
    numPIs: settings.numPIs,
    sprintsPerPI: settings.sprintsPerPI,
    epicsPerPI: settings.epicsPerPI,
    issuesPerEpic: settings.issuesPerEpic,
    assigneeIds: splitCsv(settings.assigneeIds),
    reassignProb: settings.reassignProb,
    epicChurnProb: settings.epicChurnProb,
    products: splitCsv(settings.products),
    teams: splitCsv(settings.teams),
    storyPoints: splitCsv(settings.storyPoints).map(Number),
    maxCommentsPerIssue: settings.maxCommentsPerIssue,
    maxWorklogsPerIssue: settings.maxWorklogsPerIssue,
    daysOfHistory: settings.daysOfHistory,
    sleepMs: settings.sleepMs,
  };
}

export async function fetchEnvStatus(): Promise<EnvStatus> {
  const res = await fetch("/api/env-status");
  if (!res.ok) throw new Error("Failed to load env status");
  return res.json();
}

export async function fetchDefaults(): Promise<DefaultsResponse> {
  const res = await fetch("/api/defaults");
  if (!res.ok) throw new Error("Failed to load defaults");
  return res.json();
}

export async function fetchAssignableUsersOptions() {
  const res = await fetch("/api/options/assignable-users");
  if (!res.ok) throw new Error("Failed to load assignable users");
  const body = await res.json();
  return (body.options || []) as Array<{ value: string; label: string }>;
}

export async function fetchTeamsOptions() {
  const res = await fetch("/api/options/teams");
  if (!res.ok) throw new Error("Failed to load teams");
  const body = await res.json();
  return (body.options || []) as Array<{ value: string; label: string }>;
}

export async function fetchProductsOptions(fieldId?: string) {
  const url = new URL("/api/options/products", window.location.origin);
  if (fieldId) url.searchParams.set("fieldId", fieldId);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Failed to load products options");
  const body = await res.json();
  return {
    fieldId: body.fieldId as string,
    options: (body.options || []) as Array<{ value: string; label: string }>,
  };
}

export async function fetchActiveRun(): Promise<ActiveRunResponse> {
  const res = await fetch("/api/runs/active");
  if (!res.ok) throw new Error("Failed to fetch active run");
  return res.json();
}

export async function fetchCheckpoint(): Promise<CheckpointResponse> {
  const res = await fetch("/api/checkpoint");
  if (!res.ok) throw new Error("Failed to fetch checkpoint");
  return res.json();
}

export async function clearCheckpoint() {
  const res = await fetch("/api/checkpoint", { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to clear checkpoint");
}

export async function startRun(
  payload: Record<string, unknown>,
  options: { fresh?: boolean } = {}
) {
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, fresh: options.fresh ?? false }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Failed to start run (${res.status})`) as Error & {
      runId?: string;
      statusCode?: number;
    };
    if (body?.runId) err.runId = String(body.runId);
    err.statusCode = res.status;
    throw err;
  }
  return res.json() as Promise<{ runId: string; resumed?: boolean }>;
}

export async function cancelRun(runId: string) {
  const res = await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to cancel run");
}

export function subscribeRunEvents(runId: string, onEvent: (data: unknown) => void) {
  const es = new EventSource(`/api/runs/${runId}/events`);
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  };
  return es;
}
