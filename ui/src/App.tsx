import { useCallback, useEffect, useRef, useState } from "react";
import { Play, FlaskConical, Trash2, Users, UsersRound, Square, RotateCcw } from "lucide-react";
import { ModeToggle } from "@/components/mode-toggle";
import { ProgressPanel } from "@/components/ProgressPanel";
import { SettingsForm } from "@/components/SettingsForm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  cancelRun,
  clearCheckpoint,
  fetchCheckpoint,
  fetchDefaults,
  fetchEnvStatus,
  fetchActiveRun,
  loadSettings,
  mergeDefaults,
  saveSettings,
  settingsToPayload,
  startRun,
  subscribeRunEvents,
} from "@/lib/api";
import type { CheckpointResponse, EnvStatus, RunMode, RunStatus, SeedEvent, Settings } from "@/lib/types";

function hydrateFromEvents(events: SeedEvent[]) {
  let currentSection: string | undefined;
  let progress:
    | { label: string; current: number; total: number; detail?: string }
    | undefined;

  for (const event of events) {
    if (event.type === "section") currentSection = event.title;
    if (event.type === "progress") {
      progress = {
        label: event.label || "Progress",
        current: event.current || 0,
        total: event.total || 0,
        detail: event.detail,
      };
    }
  }

  return { currentSection, progress };
}

function checkpointBannerText(checkpoint: CheckpointResponse) {
  const pos = checkpoint.position || { pi: 1, epic: 1, child: 0 };
  const child = pos.child > 0 ? ` · Issue ${pos.child}` : "";
  return `Resuming from PI ${pos.pi} · Epic ${pos.epic}${child}`;
}

export default function App() {
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [status, setStatus] = useState<RunStatus>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<SeedEvent[]>([]);
  const [currentSection, setCurrentSection] = useState<string>();
  const [progress, setProgress] = useState<{
    label: string;
    current: number;
    total: number;
    detail?: string;
  }>();
  const [error, setError] = useState<string | null>(null);
  const [resumeBanner, setResumeBanner] = useState<string | null>(null);
  const [checkpointAvailable, setCheckpointAvailable] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);
  const autoResumeAttempted = useRef(false);

  const stopTracking = useCallback(() => {
    if (pollRef.current != null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (esRef.current) {
      try {
        esRef.current.close();
      } catch {
        /* ignore */
      }
      esRef.current = null;
    }
  }, []);

  const handleEvent = useCallback((raw: unknown) => {
    const event = raw as SeedEvent;
    setEvents((prev) => [...prev, event]);

    if (event.type === "section") setCurrentSection(event.title);
    if (event.type === "progress") {
      setProgress({
        label: event.label || "Progress",
        current: event.current || 0,
        total: event.total || 0,
        detail: event.detail,
      });
    }
    if (event.type === "error") {
      setError(event.message || "Unknown error");
      setStatus("failed");
    }
    if (event.type === "status") {
      if (event.status === "completed") {
        setStatus("completed");
        setCheckpointAvailable(false);
        setResumeBanner(null);
      }
      if (event.status === "failed") setStatus("failed");
      if (event.status === "cancelled") setStatus("cancelled");
    }
    if (event.type === "done") {
      setStatus("completed");
      setCheckpointAvailable(false);
      setResumeBanner(null);
    }
  }, []);

  const attachToRun = useCallback(
    (id: string, initialStatus: RunStatus = "running", initialEvents: SeedEvent[] = []) => {
      stopTracking();
      setRunId(id);
      setStatus(initialStatus);
      setError(null);
      setEvents(initialEvents);
      const hydrated = hydrateFromEvents(initialEvents);
      setProgress(hydrated.progress);
      setCurrentSection(hydrated.currentSection);

      const es = subscribeRunEvents(id, handleEvent);
      esRef.current = es;

      pollRef.current = window.setInterval(async () => {
        const res = await fetch(`/api/runs/${id}`);
        if (!res.ok) return;
        const body = await res.json();
        if (body.status !== "running") {
          stopTracking();
          setStatus(body.status);
          if (body.error) setError(body.error);
          if (body.status === "completed") {
            setCheckpointAvailable(false);
            setResumeBanner(null);
          }
        }
      }, 1500);
    },
    [handleEvent, stopTracking]
  );

  const beginRun = useCallback(
    async (mode: RunMode, options: { fresh?: boolean; resumed?: boolean; initialEvents?: SeedEvent[] } = {}) => {
      if (status === "running") return;
      if (mode === "delete-seeded" && !settings.deleteConfirmed) {
        setError("Check the delete confirmation box in Advanced settings before deleting.");
        return;
      }

      setError(null);
      if (!options.resumed) {
        setEvents([]);
        setProgress(undefined);
        setCurrentSection(undefined);
      }
      setStatus("running");

      try {
        const payload = settingsToPayload(settings, mode);
        const { runId: id, resumed } = await startRun(payload, { fresh: options.fresh });
        setRunId(id);
        if (!resumed && !options.resumed) {
          setResumeBanner(null);
        }
        setCheckpointAvailable(false);

        const initialEvents = options.initialEvents ?? [];
        if (initialEvents.length) {
          setEvents(initialEvents);
          const hydrated = hydrateFromEvents(initialEvents);
          setProgress(hydrated.progress);
          setCurrentSection(hydrated.currentSection);
        }

        const es = subscribeRunEvents(id, handleEvent);
        esRef.current = es;

        pollRef.current = window.setInterval(async () => {
          const res = await fetch(`/api/runs/${id}`);
          if (!res.ok) return;
          const body = await res.json();
          if (body.status !== "running") {
            stopTracking();
            setStatus(body.status);
            if (body.error) setError(body.error);
            if (body.status === "completed") {
              setCheckpointAvailable(false);
              setResumeBanner(null);
            }
          }
        }, 1500);
      } catch (e) {
        const err = e as Error & { runId?: string; statusCode?: number };
        if (err.runId) {
          attachToRun(err.runId, "running");
          return;
        }
        setStatus("failed");
        setError(String(err.message || err));
      }
    },
    [attachToRun, handleEvent, settings, status, stopTracking]
  );

  useEffect(() => {
    Promise.all([fetchEnvStatus(), fetchDefaults(), fetchActiveRun(), fetchCheckpoint()])
      .then(([envStatus, defaults, activeRun, checkpoint]) => {
        const mergedSettings = { ...mergeDefaults(defaults), ...loadSettings() };
        setEnv(envStatus);
        setSettings(mergedSettings);
        setCheckpointAvailable(checkpoint.resumable);

        if (activeRun?.active && (activeRun.status === "running" || activeRun.status === "cancelled")) {
          const activeId = activeRun.runId;
          if (activeId) attachToRun(activeId, (activeRun.status as RunStatus) || "running");
          return;
        }

        if (
          !autoResumeAttempted.current &&
          checkpoint.resumable &&
          envStatus.ok &&
          (checkpoint.mode === "seed" || checkpoint.dryRun)
        ) {
          autoResumeAttempted.current = true;
          const mode: RunMode = checkpoint.dryRun ? "dry-run" : "seed";
          setResumeBanner(checkpointBannerText(checkpoint));
          setSettings(mergedSettings);
          void (async () => {
            setError(null);
            setEvents(checkpoint.events ?? []);
            const hydrated = hydrateFromEvents(checkpoint.events ?? []);
            setProgress(hydrated.progress);
            setCurrentSection(hydrated.currentSection);
            setStatus("running");
            setCheckpointAvailable(false);
            try {
              const payload = settingsToPayload(mergedSettings, mode);
              const { runId: id } = await startRun(payload);
              setRunId(id);
              const es = subscribeRunEvents(id, handleEvent);
              esRef.current = es;
              pollRef.current = window.setInterval(async () => {
                const res = await fetch(`/api/runs/${id}`);
                if (!res.ok) return;
                const body = await res.json();
                if (body.status !== "running") {
                  stopTracking();
                  setStatus(body.status);
                  if (body.error) setError(body.error);
                  if (body.status === "completed") {
                    setCheckpointAvailable(false);
                    setResumeBanner(null);
                  }
                }
              }, 1500);
            } catch (e) {
              const err = e as Error & { runId?: string };
              if (err.runId) {
                attachToRun(err.runId, "running", checkpoint.events ?? []);
                return;
              }
              setStatus("failed");
              setError(String(err.message || err));
            }
          })();
        }
      })
      .catch((e) => setError(String(e.message || e)));
    // Mount-only bootstrap: reconnect active run or auto-resume checkpoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const run = (mode: RunMode) => beginRun(mode);

  const startFresh = async (mode: RunMode = "seed") => {
    try {
      await clearCheckpoint();
      setCheckpointAvailable(false);
      setResumeBanner(null);
      await beginRun(mode, { fresh: true });
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const cancel = async () => {
    if (!runId) return;
    try {
      await cancelRun(runId);
      setStatus("cancelled");
      setCheckpointAvailable(true);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  useEffect(() => {
    return () => stopTracking();
  }, [stopTracking]);

  const busy = status === "running";

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30 overflow-x-auto">
      <header className="border-b bg-card/80 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">seed-jira</h1>
            <p className="text-sm text-muted-foreground">SSP planning data seeder</p>
          </div>
          <div className="flex items-center gap-3">
            {env && (
              <Badge variant={env.ok ? "secondary" : "destructive"} className="hidden sm:inline-flex">
                {env.ok ? env.baseUrl : "Missing .env"}
              </Badge>
            )}
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl w-full px-4 py-6 space-y-6">
        {resumeBanner && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
            {resumeBanner}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <section className="flex flex-wrap gap-3">
          <Button onClick={() => run("seed")} disabled={busy || !env?.ok} className="gap-2">
            <Play className="h-4 w-4" /> Seed
          </Button>
          <Button variant="secondary" onClick={() => run("dry-run")} disabled={busy || !env?.ok} className="gap-2">
            <FlaskConical className="h-4 w-4" /> Dry run
          </Button>
          {checkpointAvailable && !busy && (
            <Button variant="outline" onClick={() => startFresh("seed")} disabled={!env?.ok} className="gap-2">
              <RotateCcw className="h-4 w-4" /> Start fresh
            </Button>
          )}
          <Button variant="destructive" onClick={() => run("delete-seeded")} disabled={busy || !env?.ok} className="gap-2">
            <Trash2 className="h-4 w-4" /> Delete seeded
          </Button>
          <Separator orientation="vertical" className="h-10 hidden sm:block" />
          <Button variant="outline" onClick={() => run("print-assignable-users")} disabled={busy || !env?.ok} className="gap-2">
            <Users className="h-4 w-4" /> List users
          </Button>
          <Button variant="outline" onClick={() => run("print-teams")} disabled={busy || !env?.ok} className="gap-2">
            <UsersRound className="h-4 w-4" /> List teams
          </Button>
          {busy && (
            <Button variant="outline" onClick={cancel} className="gap-2 ml-auto">
              <Square className="h-4 w-4" /> Cancel
            </Button>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-2 min-w-0">
          <ProgressPanel
            events={events}
            status={status}
            currentSection={currentSection}
            progress={progress}
          />
          <SettingsForm settings={settings} onChange={patchSettings} disabled={busy} />
        </div>
      </main>
    </div>
  );
}
