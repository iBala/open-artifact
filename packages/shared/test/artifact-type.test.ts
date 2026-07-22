import { describe, it, expect } from 'vitest';
import { artifactTypeForExtension, isArtifactType } from '../src/index.js';

describe('artifact types', () => {
  it('recognises the two supported types', () => {
    expect(isArtifactType('markdown')).toBe(true);
    expect(isArtifactType('html')).toBe(true);
    expect(isArtifactType('pdf')).toBe(false);
  });

  it('maps file extensions to artifact types', () => {
    expect(artifactTypeForExtension('.md')).toBe('markdown');
    expect(artifactTypeForExtension('markdown')).toBe('markdown');
    expect(artifactTypeForExtension('.HTML')).toBe('html');
    expect(artifactTypeForExtension('.htm')).toBe('html');
    expect(artifactTypeForExtension('.pdf')).toBeNull();
  });
});
