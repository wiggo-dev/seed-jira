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
  productsFieldId: string;
  teams: string;
  storyPointsFieldId: string;
  storyPoints: string;
  maxCommentsPerIssue: number;
  maxWorklogsPerIssue: number;
  daysOfHistory: number;
  sleepMs: number;
  verbose: boolean;
  deleteArtifacts: boolean;
  deleteConfirmed: boolean;
  deleteStateFile: boolean;
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

export interface SelectOption {
  value: string;
  label: string;
}

export interface EnvStatus {
  ok: boolean;
  baseUrl: string;
  projectKey: string;
  seedLabel: string;
}

export interface ActiveRunResponse {
  active: boolean;
  runId?: string;
  status?: RunStatus | string;
  mode?: string;
  startedAt?: string;
}

export interface CheckpointResponse {
  resumable: boolean;
  status?: string;
  runId?: string;
  startedAt?: string;
  updatedAt?: string;
  mode?: string;
  dryRun?: boolean;
  position?: { pi: number; epic: number; child: number };
  phase?: string;
  counters?: { createdCount: number; activityCount: number; sprintAssignCount: number };
  events?: SeedEvent[];
  configSummary?: Record<string, unknown>;
}

export interface DefaultsResponse {
  defaults: Partial<Settings>;
  fieldMeta: Record<string, { label: string; type: string; group: string }>;
  projectKey: string;
  seedLabel: string;
}
