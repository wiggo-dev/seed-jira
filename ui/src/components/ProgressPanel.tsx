import type { SeedEvent } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

interface ProgressPanelProps {
  events: SeedEvent[];
  status: string;
  currentSection?: string;
  progress?: { label: string; current: number; total: number; detail?: string };
}

export function ProgressPanel({ events, status, currentSection, progress }: ProgressPanelProps) {
  const logs = events.filter((e) => ["info", "log", "error"].includes(e.type));
  const pct = progress?.total
    ? Math.round((progress.current / progress.total) * 100)
    : progress?.current
      ? 100
      : 0;

  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Progress</CardTitle>
            <CardDescription>
              {currentSection ? `▶ ${currentSection}` : "Waiting to start"}
            </CardDescription>
          </div>
          <Badge variant={status === "running" ? "default" : status === "failed" ? "destructive" : "secondary"}>
            {status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {progress && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="font-medium">{progress.label}</span>
              <span className="text-muted-foreground">
                {progress.total ? `${progress.current}/${progress.total}` : progress.current}
              </span>
            </div>
            <Progress value={pct} />
            {progress.detail && (
              <p className="text-sm text-muted-foreground truncate">{progress.detail}</p>
            )}
          </div>
        )}

        <div className="rounded-md border bg-muted/30 p-3 h-[360px] overflow-y-auto font-mono text-xs space-y-1">
          {logs.length === 0 ? (
            <p className="text-muted-foreground">Output will appear here…</p>
          ) : (
            logs.map((e, i) => (
              <div
                key={i}
                className={
                  e.type === "error"
                    ? "text-destructive"
                    : e.type === "info"
                      ? "text-foreground"
                      : "text-muted-foreground"
                }
              >
                {e.message}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
