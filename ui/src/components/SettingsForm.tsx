import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { Settings } from "@/lib/types";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchMultiSelect } from "@/components/SearchMultiSelect";
import type { SelectOption } from "@/lib/types";
import { fetchAssignableUsersOptions, fetchProductsOptions, fetchTeamsOptions } from "@/lib/api";

interface SettingsFormProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  disabled?: boolean;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

export function SettingsForm({ settings, onChange, disabled }: SettingsFormProps) {
  const splitCsv = useMemo(
    () => (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean),
    []
  );

  const [assignableOptions, setAssignableOptions] = useState<SelectOption[]>([]);
  const [teamOptions, setTeamOptions] = useState<SelectOption[]>([]);
  const [productOptions, setProductOptions] = useState<SelectOption[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAssignableUsersOptions()
      .then(setAssignableOptions)
      .catch(() => {
        /* ignore; user can still enter ids manually in advanced mode if needed */
      });
    fetchTeamsOptions()
      .then(setTeamOptions)
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setProductsLoading(true);
    fetchProductsOptions(settings.productsFieldId || undefined)
      .then(({ options }) => {
        if (cancelled) return;
        setProductOptions(options);
      })
      .catch(() => {
        if (cancelled) return;
        setProductOptions([]);
      })
      .finally(() => {
        if (!cancelled) setProductsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settings.productsFieldId]);

  const selectedAssignees = splitCsv(settings.assigneeIds);
  const selectedTeams = splitCsv(settings.teams);
  const selectedProducts = splitCsv(settings.products);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Advanced settings</CardTitle>
        <CardDescription>All CLI options are available here.</CardDescription>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple" defaultValue={["board", "scale"]} className="w-full">
          <AccordionItem value="board">
            <AccordionTrigger>Board</AccordionTrigger>
            <AccordionContent className="grid gap-4 lg:grid-cols-2">
              <Field label="Board name">
                <Input
                  value={settings.boardName}
                  disabled={disabled}
                  onChange={(e) => onChange({ boardName: e.target.value })}
                />
              </Field>
              <Field label="Board ID (optional)">
                <Input
                  value={settings.boardId}
                  disabled={disabled}
                  onChange={(e) => onChange({ boardId: e.target.value })}
                  placeholder="e.g. 2"
                />
              </Field>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="scale">
            <AccordionTrigger>Scale</AccordionTrigger>
            <AccordionContent className="grid gap-4 lg:grid-cols-2">
              {([
                ["numPIs", "PIs"],
                ["sprintsPerPI", "Sprints per PI"],
                ["epicsPerPI", "Epics per PI"],
                ["issuesPerEpic", "Issues per epic"],
              ] as const).map(([key, label]) => (
                <Field key={key} label={label}>
                  <Input
                    type="number"
                    min={1}
                    disabled={disabled}
                    value={settings[key]}
                    onChange={(e) => onChange({ [key]: Number(e.target.value) })}
                  />
                </Field>
              ))}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="assignees">
            <AccordionTrigger>Assignees</AccordionTrigger>
            <AccordionContent className="grid gap-4 lg:grid-cols-2">
              <Field label="Assignees">
                <SearchMultiSelect
                  options={assignableOptions}
                  selected={selectedAssignees}
                  disabled={disabled || !assignableOptions.length}
                  placeholder="Search users…"
                  onChange={(next) => onChange({ assigneeIds: next.join(",") })}
                />
              </Field>
              <Field label="Reassign probability">
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={disabled}
                  value={settings.reassignProb}
                  onChange={(e) => onChange({ reassignProb: Number(e.target.value) })}
                />
              </Field>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="fields">
            <AccordionTrigger>Custom fields</AccordionTrigger>
            <AccordionContent className="grid gap-4">
              <Field label="Products field customfield id (optional)">
                <Input
                  value={settings.productsFieldId}
                  disabled={disabled}
                  onChange={(e) => onChange({ productsFieldId: e.target.value.trim() })}
                  placeholder="e.g. customfield_10101 (leave blank to match by name)"
                />
              </Field>

              <Field label="Products">
                <SearchMultiSelect
                  options={productOptions}
                  selected={selectedProducts}
                  disabled={disabled || productsLoading}
                  placeholder={productsLoading ? "Loading products…" : "Search products…"}
                  onChange={(next) => onChange({ products: next.join(",") })}
                />
              </Field>

              <Field label="Teams">
                <SearchMultiSelect
                  options={teamOptions}
                  selected={selectedTeams}
                  disabled={disabled || !teamOptions.length}
                  placeholder="Search teams…"
                  onChange={(next) => onChange({ teams: next.join(",") })}
                />
              </Field>

              <Field label="Story points (comma-separated)">
                <Input
                  value={settings.storyPoints}
                  disabled={disabled}
                  onChange={(e) => onChange({ storyPoints: e.target.value })}
                />
              </Field>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="activity">
            <AccordionTrigger>Activity simulation</AccordionTrigger>
            <AccordionContent className="grid gap-4 lg:grid-cols-2">
              {([
                ["maxCommentsPerIssue", "Max comments"],
                ["maxWorklogsPerIssue", "Max worklogs"],
                ["daysOfHistory", "Days of history"],
                ["sleepMs", "Sleep ms"],
              ] as const).map(([key, label]) => (
                <Field key={key} label={label}>
                  <Input
                    type="number"
                    min={0}
                    disabled={disabled}
                    value={settings[key]}
                    onChange={(e) => onChange({ [key]: Number(e.target.value) })}
                  />
                </Field>
              ))}
              <Field label="Epic churn probability">
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={disabled}
                  value={settings.epicChurnProb}
                  onChange={(e) => onChange({ epicChurnProb: Number(e.target.value) })}
                />
              </Field>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="flags">
            <AccordionTrigger>Flags & cleanup</AccordionTrigger>
            <AccordionContent className="space-y-4">
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label>Verbose dry-run logging</Label>
                  <p className="text-sm text-muted-foreground">Show every API call in dry-run mode</p>
                </div>
                <Switch
                  checked={settings.verbose}
                  disabled={disabled}
                  onCheckedChange={(v) => onChange({ verbose: v })}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label>Delete artifacts on cleanup</Label>
                  <p className="text-sm text-muted-foreground">Also remove sprints and fix versions</p>
                </div>
                <Switch
                  checked={settings.deleteArtifacts}
                  disabled={disabled}
                  onCheckedChange={(v) => onChange({ deleteArtifacts: v })}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label>Also delete state file</Label>
                  <p className="text-sm text-muted-foreground">Removes `.seed-jira-ssp-state.json` after cleanup</p>
                </div>
                <Switch
                  checked={settings.deleteStateFile}
                  disabled={disabled || !settings.deleteConfirmed}
                  onCheckedChange={(v) => onChange({ deleteStateFile: v })}
                />
              </div>
              <div className="flex items-center gap-3 rounded-lg border border-destructive/40 p-3">
                <Checkbox
                  id="delete-confirmed"
                  checked={settings.deleteConfirmed}
                  disabled={disabled}
                  onCheckedChange={(v) => onChange({ deleteConfirmed: !!v })}
                />
                <div>
                  <Label htmlFor="delete-confirmed">I confirm delete seeded issues</Label>
                  <p className="text-sm text-muted-foreground">Required for Delete action (maps to --yes)</p>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}
