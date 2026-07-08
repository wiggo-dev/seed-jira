import { useCallback, useEffect, useState } from "react";
import { Play, FlaskConical, Trash2, Users, UsersRound, Square } from "lucide-react";
import { ModeToggle } from "@/components/mode-toggle";
import { ProgressPanel } from "@/components/ProgressPanel";
import { SettingsForm } from "@/components/SettingsForm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  cancelRun,
  fetchDefaults,
  fetchEnvStatus,
  loadSettings,
  mergeDefaults,
  saveSettings,
  settingsToPayload,
  startRun,
  subscribeRunEvents,
} from "@/lib/api";
import type { EnvStatus, RunMode, RunStatus, SeedEvent, Settings } from "@/lib/types";

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

  useEffect(() => {
    Promise.all([fetchEnvStatus(), fetchDefaults()])
      .then(([envStatus, defaults]) => {
        setEnv(envStatus);
        setSettings((prev) => ({ ...mergeDefaults(defaults), ...prev }));
      })
      .catch((e) => setError(String(e.message || e)));
  }, []);

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
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
      if (event.status === "completed") setStatus("completed");
      if (event.status === "failed") setStatus("failed");
      if (event.status === "cancelled") setStatus("cancelled");
    }
    if (event.type === "done") setStatus("completed");
  }, []);

  const run = async (mode: RunMode) => {
    if (status === "running") return;
    if (mode === "delete-seeded" && !settings.deleteConfirmed) {
      setError("Check the delete confirmation box in Advanced settings before deleting.");
      return;
    }

    setError(null);
    setEvents([]);
    setProgress(undefined);
    setCurrentSection(undefined);
    setStatus("running");

    try {
      const payload = settingsToPayload(settings, mode);
      const { runId: id } = await startRun(payload);
      setRunId(id);

      const es = subscribeRunEvents(id, handleEvent);
      es.addEventListener("error", () => {
        es.close();
      });

      const poll = setInterval(async () => {
        const res = await fetch(`/api/runs/${id}`);
        if (!res.ok) return;
        const body = await res.json();
        if (body.status !== "running") {
          clearInterval(poll);
          es.close();
          setStatus(body.status);
          if (body.error) setError(body.error);
        }
      }, 1500);
    } catch (e) {
      setStatus("failed");
      setError(String((e as Error).message || e));
    }
  };

  const cancel = async () => {
    if (!runId) return;
    try {
      await cancelRun(runId);
      setStatus("cancelled");
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const busy = status === "running";

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
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

      <main className="mx-auto max-w-6xl px-4 py-6 space-y-6">
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

        <div className="grid gap-6 lg:grid-cols-2">
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
