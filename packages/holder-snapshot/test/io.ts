import type { CliIo } from "../src/cli/holder-snapshot.js";

/** A `CliIo` that records output and keeps files in memory, so tests never touch disk. */
export function memoryIo(fetchImpl?: typeof globalThis.fetch): { out: string[]; err: string[]; files: Map<string, string>; io: CliIo } {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  return {
    out,
    err,
    files,
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      env: {},
      ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
      readFile: async (path: string) => {
        const text = files.get(path);
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
      writeFile: async (path: string, data: string) => {
        files.set(path, data);
      },
    },
  };
}
