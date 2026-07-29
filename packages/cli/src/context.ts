/**
 * What a command is given.
 *
 * Everything that touches the outside world arrives here as an argument: the
 * clock, sleeping, the network, where output goes. That is what lets the tests
 * run the real commands end to end without waiting on real seconds or reaching a
 * real network.
 */

export interface CommandContext {
  /** True when --json was passed: print one JSON object and nothing else. */
  json: boolean;
  print: (line: string) => void;
  /**
   * Writes exactly what it is given, with no newline of its own. For an
   * artifact's content, where `get ID > report.md` has to produce the same
   * bytes as `get ID --out report.md` — a document that does not end in a
   * newline must not gain one.
   */
  printRaw: (text: string) => void;
  printError: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchImpl: typeof fetch;
}

export function createCommandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    json: false,
    print: (line) => process.stdout.write(`${line}\n`),
    printRaw: (text) => process.stdout.write(text),
    printError: (line) => process.stderr.write(`${line}\n`),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetchImpl: fetch,
    ...overrides,
  };
}
