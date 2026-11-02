#!/usr/bin/env node
import { runSignGuard } from "../cli/sign-guard.js";

process.exitCode = await runSignGuard(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
