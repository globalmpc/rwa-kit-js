#!/usr/bin/env node
import { runCreationBlock } from "../cli/creation-block.js";

process.exitCode = await runCreationBlock(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
});
