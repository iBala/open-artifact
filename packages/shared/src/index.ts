/**
 * Types shared between the server, the CLI and the web app.
 * The HTTP API is the product contract; these types mirror it.
 */

/** The two content formats an artifact can hold. */
export const ARTIFACT_TYPES = ['markdown', 'html'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

/** Maps a file extension to the artifact type it produces, or null if unsupported. */
export function artifactTypeForExtension(extension: string): ArtifactType | null {
  const normalised = extension.toLowerCase().replace(/^\./, '');
  if (normalised === 'md' || normalised === 'markdown') return 'markdown';
  if (normalised === 'html' || normalised === 'htm') return 'html';
  return null;
}
