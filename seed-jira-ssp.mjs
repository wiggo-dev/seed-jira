#!/usr/bin/env node
import "dotenv/config";
import crypto from "node:crypto";
import {
  buildConfig,
  parseArgs,
  runSeed,
  cliHooks,
  usageText,
  loadCheckpoint,
  isResumable,
  clearCheckpoint,
} from "./lib/seed-jira-core.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(usageText());
  process.exit(0);
}

const config = buildConfig(args);
const fresh = !!args.fresh;

if (fresh) {
  clearCheckpoint();
}

const existing = loadCheckpoint();
const resume = !fresh && isResumable(existing, config);
const runId = resume ? existing.runId : crypto.randomUUID();

if (resume) {
  const pos = existing.position || { pi: 1, epic: 1, child: 0 };
  console.log(`Resuming interrupted run from PI ${pos.pi}, Epic ${pos.epic}...`);
}

runSeed(config, cliHooks(), { runId, fresh })
  .catch((e) => {
    console.error(e?.stack || String(e));
    process.exit(1);
  });
