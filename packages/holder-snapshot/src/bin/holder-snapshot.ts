#!/usr/bin/env node
import { runHolderSnapshot } from "../cli/holder-snapshot.js";

process.exitCode = await runHolderSnapshot(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
});
