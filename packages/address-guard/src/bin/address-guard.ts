#!/usr/bin/env node
import { runAddressGuard } from "../cli/address-guard.js";

process.exitCode = await runAddressGuard(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
});
