#!/usr/bin/env node
import { runTransferLedger } from "../cli/transfer-ledger.js";

process.exitCode = await runTransferLedger(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
});
