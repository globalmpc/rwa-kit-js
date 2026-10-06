#!/usr/bin/env node
import { runDappStats } from "../cli/dapp-stats.js";

process.exitCode = await runDappStats(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
});
