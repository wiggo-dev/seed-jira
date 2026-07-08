# Jira SSP Seeder

Node script to populate a Jira Cloud development instance with realistic planning data for the **SSP** project: fix versions, sprints, epics, stories, bugs, assignees, custom fields, and simulated activity history.

All seeded issues are tagged with the label `seed-ssp` so they can be found and cleaned up later.

## Prerequisites

- **Node.js 18+** (uses native `fetch`)
- A Jira Cloud site with:
  - Project **SSP** (Scrum)
  - At least one **Scrum board** for SSP
  - Permission to create issues, versions, and sprints
- A Jira API token: [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)

## Setup

```bash
cd seed-jira
npm install
```

Create a `.env` file in this directory (loaded automatically via `dotenv`):

```env
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=your_api_token_here
```

## Web UI (local)

Run the API and React UI together:

```bash
npm run dev
```

Then open **http://localhost:5173**

- **Seed / Dry run / Delete** with live progress
- **Advanced settings** panel for all CLI options
- **Light / dark / system** theme toggle
- Credentials still come from `.env` only (never stored in the browser)

Individual processes:

```bash
npm run api   # API on http://localhost:3847
npm run ui    # Vite dev server on http://localhost:5173
```

## Run flow

Follow these steps in order:

### 1. Verify credentials and board access

```bash
node seed-jira-ssp.mjs --print-assignable-users
```

This confirms your API token works and lists users you can assign issues to in SSP. Copy the `accountId` values you want to use.

### 2. Dry run (recommended)

Preview what would be created without writing to Jira:

```bash
node seed-jira-ssp.mjs --dry-run --board-name "SSP" --num-pis 4 --sprints-per-pi 6
```

Dry run still reads from Jira (project, board, existing versions/sprints) but does not create issues or activity.

### 3. Seed data

Run the full generator with your desired scale and options:

```bash
node seed-jira-ssp.mjs \
  --board-name "SSP" \
  --num-pis 4 \
  --sprints-per-pi 6 \
  --assignee-ids "712020:49a762e7-f846-4178-88bf-a79798e8b6b3,712020:1728b808-4ebc-467d-be80-3cfa66af722d" \
  --products "Drive,XtremIO,Block Storage,Cloud Sync" \
  --teams "Team A,Team B"
```

### 4. Verify in Jira

Search for seeded issues:

```
project = SSP AND labels = seed-ssp
```

Check fix versions (`SSP-PI-1`, `SSP-PI-2`, …), sprints (`SSP-PI-1.1`, `SSP-PI-1.2`, …), and board backlog/sprint columns.

### 5. Clean up when done

Remove seeded issues (and optionally sprints/versions):

```bash
# Issues only (falls back to removing label if delete permission is missing)
node seed-jira-ssp.mjs --delete-seeded --yes

# Issues + sprints + versions recorded in state file
node seed-jira-ssp.mjs --delete-seeded --delete-artifacts --yes
```

If cleanup fails partway through, delete `.seed-jira-ssp-state.json` and re-run, or search Jira manually with `labels = seed-ssp`.

## What gets created

| Artifact | Naming | Notes |
|----------|--------|-------|
| Fix versions | `SSP-PI-1`, `SSP-PI-2`, … | One per PI |
| Sprints | `SSP-PI-1.1`, `SSP-PI-1.2`, … | `--sprints-per-pi` per PI |
| Epics | `[seed-ssp] SSP-PI-n Epic …` | Linked to fix version |
| Stories | ~80% of child issues | Story points, sprint, products, teams |
| Bugs | ~20% of child issues | Sprint, products, teams |

**Per issue activity (randomised):**

- Comments
- Backdated worklogs (`--days-of-history` sets how far back worklog **started** dates go)
- Status transitions (best-effort, depends on your workflow)
- Optional reassignment (`--reassign-prob`)
- Optional epic churn: remove from epic, move to another epic, or remove then re-link (`--epic-churn-prob`, default 0.1). Uses Jira Cloud `parent` when available, otherwise Epic Link.

**History / changelog timestamps:** Jira Cloud does not let the REST API set issue created dates or backdate changelog entries. Comments, transitions, reassignments, and epic changes are recorded at seed time. Only worklog **started** dates are backdated; the issue History tab will still show most activity clustered around when you ran the seeder.

**Defaults** (override with flags):

| Setting | Default |
|---------|---------|
| PIs | 3 |
| Sprints per PI | 2 |
| Epics per PI | 5 |
| Issues per epic | 20 |
| Story points | 1, 2, 3, 5, 8, 13 |

With defaults, expect roughly **~315 issues** (3 × 5 × (1 epic + 20 children) per PI).

## Example commands

### Help

```bash
node seed-jira-ssp.mjs --help
```

### List assignable users

```bash
node seed-jira-ssp.mjs --print-assignable-users
```

### Dry run

```bash
node seed-jira-ssp.mjs --dry-run --board-name "SSP" --num-pis 4 --sprints-per-pi 6
```

### Full seed (4 PIs, 6 sprints each, two assignees)

```bash
node seed-jira-ssp.mjs \
  --board-name "SSP" \
  --num-pis 4 \
  --sprints-per-pi 6 \
  --assignee-ids "712020:49a762e7-f846-4178-88bf-a79798e8b6b3,712020:1728b808-4ebc-467d-be80-3cfa66af722d"
```

### Full seed with custom fields

```bash
node seed-jira-ssp.mjs \
  --board-name "SSP" \
  --num-pis 4 \
  --sprints-per-pi 6 \
  --assignee-ids "712020:49a762e7-f846-4178-88bf-a79798e8b6b3,712020:1728b808-4ebc-467d-be80-3cfa66af722d" \
  --products "Drive,XtremIO,Block Storage,Cloud Sync" \
  --teams "Team A,Team B" \
  --story-points "1,2,3,5,8,13" \
  --reassign-prob 0.15
```

### Smaller / faster seed

```bash
node seed-jira-ssp.mjs \
  --board-name "SSP" \
  --num-pis 2 \
  --sprints-per-pi 2 \
  --epics-per-pi 2 \
  --issues-per-epic 5
```

### Use a specific board by ID

```bash
node seed-jira-ssp.mjs --board-id 2 --num-pis 3
```

### Clean up

```bash
node seed-jira-ssp.mjs --delete-seeded --yes
node seed-jira-ssp.mjs --delete-seeded --delete-artifacts --yes
```

## CLI reference

| Flag | Description |
|------|-------------|
| `--dry-run` | Print create actions; no writes |
| `--delete-seeded` | Delete (or unlabel) issues with `seed-ssp` |
| `--delete-artifacts` | Also delete sprints/versions from state file |
| `--yes` | Required for delete mode |
| `--print-assignable-users` | List assignable users and accountIds |
| `--print-teams` | List Atlassian team ids/names from existing issues |
| `--board-name <name>` | Pick scrum board by name (substring match) |
| `--board-id <id>` | Use a specific board ID |
| `--assignee-ids <csv>` | Account IDs to randomly assign |
| `--reassign-prob <0..1>` | Chance of reassigning after create (default 0.1) |
| `--epic-churn-prob <0..1>` | Chance of epic remove/move/re-link per issue (default 0.1) |
| `--products <csv>` | Values for **Product(s) Affected** |
| `--teams <csv>` | Atlassian **Team** ids or names (names resolved from issues already using Team) |
| `--story-points <csv>` | Story point pool for Stories |
| `--num-pis <n>` | Number of PIs / fix versions |
| `--sprints-per-pi <n>` | Sprints per PI |
| `--epics-per-pi <n>` | Epics per PI |
| `--issues-per-epic <n>` | Child issues per epic |
| `--max-comments <n>` | Max comments per issue |
| `--max-worklogs <n>` | Max worklogs per issue |
| `--days-of-history <n>` | How far back to set worklog **started** dates (does not backdate changelog timestamps) |
| `--sleep-ms <n>` | Delay between API calls (rate limiting) |
| `--verbose`, `-v` | Show every dry-run API call (default: progress bars only) |

## Terminal output

The script prints section headers and progress bars as it runs:

```
▶ Fix versions
  Versions [████████████████████████████] 4/4 — created SSP-PI-4

▶ Sprints
  Sprints [████████████████████████████] 24/24 — created SSP-PI-4.6

▶ Issues & activity
  Issues [████████░░░░░░░░░░░░░░░░░░░░] 120/420 — SSP-142 worklog 2/3
```

Use `--verbose` with `--dry-run` to see every API call instead of progress bars.

## State file

`.seed-jira-ssp-state.json` records board ID, version IDs, sprint IDs, and issue keys created during a run. Used by `--delete-artifacts` for reliable cleanup.

Delete this file if sprint IDs get out of sync (e.g. after switching boards).

## Run checkpoint (resume)

`.seed-jira-run-checkpoint.json` records in-progress seed runs so they can resume after a connection drop, cancel, or server restart.

- **Auto-resume:** Starting a seed again (CLI or web UI) continues from the last checkpoint when settings match.
- **Start fresh:** Pass `--fresh` on the CLI, click **Start fresh** in the UI, or `DELETE /api/checkpoint` to discard the checkpoint and begin a new run.
- **Config mismatch:** If scale/board/field settings change, the checkpoint is cleared automatically and a fresh run starts.
- **Cleanup:** Successful completion and `--delete-seeded` remove the checkpoint file.

The checkpoint stores per-issue progress (creation, simulated activity, sprint assignment), RNG state, and recent progress events for UI replay.

## Troubleshooting

| Problem | Likely cause | Fix |
|---------|--------------|-----|
| `No Scrum board found` | No scrum board for SSP | Create a Scrum board in Jira |
| `rapidViewId` / board permission error | Wrong sprint ID in state | Delete `.seed-jira-ssp-state.json` and re-run |
| Seed resumes unexpectedly | Checkpoint from prior run | Use `--fresh` or **Start fresh** in the UI |
| `403` on delete | No "Delete issues" permission | Script removes `seed-ssp` label instead; or grant delete permission |
| `410` on search | Old Jira search API removed | Script uses `/rest/api/3/search/jql` (already updated) |
| Custom fields not set | Field names differ | Check exact names in Jira; adjust script if needed |
| `Cannot assign a non-existing team` | Team field needs UUIDs, not labels | Run `--print-teams` or pass team ids from the team profile URL |
| Transitions skipped | Workflow names differ | Expected; transitions are best-effort |

## Notes

- **User creation** is not supported. Invite users via Atlassian Admin, then use `--print-assignable-users` to get account IDs.
- **Issue created dates** and **changelog timestamps** cannot be set on Jira Cloud via the REST API. Activity is simulated via comments, worklogs, transitions, and reassignments, but only worklog started dates can be backdated (`--days-of-history`). Everything else in the issue History tab reflects when the seed run executed.
- **Epics** are not placed in sprints; child issues are **Stories and Bugs** only.
- Re-running is safe: existing versions and sprints with matching names are reused.
