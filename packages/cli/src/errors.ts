/**
 * How the CLI fails.
 *
 * An agent runs this command and reads the result. It needs to tell "you are not
 * logged in" from "the server is down" from "somebody else changed the artifact"
 * without parsing English, so every failure has an exit code and a stable machine
 * name. The message is for people and may be reworded; the code and name are the
 * contract and are not.
 */

export const EXIT_CODES = {
  ok: 0,
  /** Something was wrong with the command itself: bad flag, missing argument. */
  usage: 2,
  /** Not signed in, or the token has expired or been revoked. */
  notAuthenticated: 3,
  /** Signed in, but this artifact is not yours or does not exist. */
  noAccess: 4,
  /** The file is not Markdown or HTML. */
  unsupportedType: 5,
  /** The file is bigger than the instance allows. */
  tooLarge: 6,
  /** Somebody changed the artifact since you last read it. */
  conflict: 7,
  /** The instance could not be reached at all. */
  unreachable: 8,
  /** The server said no for some other reason. */
  serverError: 9,
  /** The file named does not exist or cannot be read. */
  fileNotFound: 10,
} as const;

export type ExitCodeName = keyof typeof EXIT_CODES;

export class CliError extends Error {
  readonly exitCode: number;
  readonly name_: ExitCodeName;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    name: ExitCodeName,
    message: string,
    options: { hint?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'CliError';
    this.name_ = name;
    this.exitCode = EXIT_CODES[name];
    this.hint = options.hint;
    this.details = options.details;
  }

  /** What `--json` prints. Shape is part of the contract. */
  toJson(): Record<string, unknown> {
    return {
      ok: false,
      error: {
        code: this.name_,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function notAuthenticated(instance?: string): CliError {
  return new CliError('notAuthenticated', 'You are not signed in.', {
    hint: instance
      ? `Run: open-artifact login --instance ${instance}`
      : 'Run: open-artifact login',
  });
}
