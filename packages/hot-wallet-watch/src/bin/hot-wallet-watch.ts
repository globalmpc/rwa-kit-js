#!/usr/bin/env node
import { runHotWalletWatch } from "../cli/hot-wallet-watch.js";

// If whatever reads the alerts goes away, say so and exit non-zero, so a supervisor restarts the
// watch, rather than crash on an unhandled EPIPE or keep running with alerts going nowhere.
process.stdout.on("error", () => {
  process.stderr.write("hot-wallet-watch: standard output closed, alerts can no longer be delivered\n");
  process.exit(3);
});

process.exitCode = await runHotWalletWatch(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  // Only watch installs these, so check stays interruptible with Ctrl-C.
  watchSignal: () => {
    const stop = new AbortController();
    // The first signal stops the loop gently; both listeners are then removed, so a second signal of
    // either kind terminates the process the default way.
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      stop.abort();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    return stop.signal;
  },
});
