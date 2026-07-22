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
  printError: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchImpl: typeof fetch;
}

export function createCommandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    json: false,
    print: (line) => process.stdout.write(`${line}\n`),
    printError: (line) => process.stderr.write(`${line}\n`),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetchImpl: fetch,
    ...overrides,
  };
}
