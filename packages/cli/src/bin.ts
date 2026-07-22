#!/usr/bin/env node
/** The executable. Everything interesting is in run.ts, which tests call directly. */

import { run } from './run.js';

run(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    process.stderr.write(`\n  ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.exitCode = 1;
  });
