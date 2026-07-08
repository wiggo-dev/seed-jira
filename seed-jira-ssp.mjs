#!/usr/bin/env node
import "dotenv/config";
import { buildConfig, parseArgs, runSeed, cliHooks, usageText } from "./lib/seed-jira-core.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(usageText());
  process.exit(0);
}

const config = buildConfig(args);

runSeed(config, cliHooks())
  .catch((e) => {
    console.error(e?.stack || String(e));
    process.exit(1);
  });
