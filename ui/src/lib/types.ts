export type RunMode =
  | "seed"
  | "dry-run"
  | "delete-seeded"
  | "print-assignable-users"
  | "print-teams";

export type RunStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

export interface Settings {
  boardName: string;
  boardId: string;
  numPIs: number;
  sprintsPerPI: number;
  epicsPerPI: number;
  issuesPerEpic: number;
  assigneeIds: string;
  reassignProb: number;
  epicChurnProb: number;
  products: string;
  teams: string;
  storyPoints: string;
  maxCommentsPerIssue: number;
  maxWorklogsPerIssue: number;
  daysOfHistory: number;
  sleepMs: number;
  verbose: boolean;
  deleteArtifacts: boolean;
  deleteConfirmed: boolean;
}

export interface SeedEvent {
  type: string;
  title?: string;
  message?: string;
  label?: string;
  current?: number;
  total?: number;
  detail?: string;
  summary?: Record<string, unknown>;
  status?: string;
  error?: string;
}

export interface EnvStatus {
  ok: boolean;
  baseUrl: string;
  projectKey: string;
  seedLabel: string;
}

export interface DefaultsResponse {
  defaults: Partial<Settings>;
  fieldMeta: Record<string, { label: string; type: string; group: string }>;
  projectKey: string;
  seedLabel: string;
}
