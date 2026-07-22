/** The CLI as a library, for tests and for anything that wants to embed it. */

export { run, parseArguments } from './run.js';
export { CliError, EXIT_CODES, type ExitCodeName } from './errors.js';
export { ApiClient } from './api.js';
export {
  credentialsPath,
  loadCredential,
  saveCredential,
  forgetCredential,
  listCredentials,
  normaliseBaseUrl,
  type StoredCredential,
} from './credentials.js';
export { createCommandContext, type CommandContext } from './context.js';
