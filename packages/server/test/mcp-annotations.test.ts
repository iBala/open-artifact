import { describe, it, expect } from 'vitest';
import { listMcpTools } from '../src/mcp/tools.js';

/**
 * The behaviour annotations on every MCP tool.
 *
 * A client uses these to decide whether to ask the person first. A tool that
 * says it only reads and then writes is worse than one that says nothing,
 * because the flag is what a client trusted instead of asking. Both directories
 * that list this server require them, and mislabelling is the usual reason a
 * submission is sent back — but that is not why they are tested. They are tested
 * because a wrong flag is a lie told to the software acting on somebody's behalf.
 *
 * What is asserted here is the shape and the internal logic. The specific claims
 * — that share_artifact is the only one that leaves the instance, that
 * update_artifact replaces what a reader sees — are asserted by name, so
 * changing what a tool does forces a decision about what it now says it does.
 */

const TOOLS = listMcpTools();
const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

describe('every tool is annotated', () => {
  it('carries all five flags and a title', () => {
    expect(TOOLS).toHaveLength(8);
    for (const tool of TOOLS) {
      expect(tool.title, `${tool.name} has no title`).toBeTruthy();
      expect(tool.annotations.title).toBe(tool.title);
      for (const flag of [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ] as const) {
        expect(typeof tool.annotations[flag], `${tool.name}.${flag}`).toBe('boolean');
      }
    }
  });

  it('never claims to read only and destroy at the same time', () => {
    for (const tool of TOOLS) {
      if (tool.annotations.readOnlyHint) {
        expect(tool.annotations.destructiveHint, `${tool.name} reads only`).toBe(false);
        // Reading the same thing twice is reading it once, always.
        expect(tool.annotations.idempotentHint, `${tool.name} reads only`).toBe(true);
      }
    }
  });

  it('gives a human title, not the tool name again', () => {
    for (const tool of TOOLS) {
      expect(tool.title).not.toBe(tool.name);
      expect(tool.title).not.toContain('_');
    }
  });
});

describe('what the flags claim, tool by tool', () => {
  it('marks the four readers read-only', () => {
    for (const name of ['get_artifact', 'list_artifacts', 'list_comments']) {
      expect(byName.get(name)?.annotations.readOnlyHint, name).toBe(true);
    }
  });

  it('marks the writers as writers', () => {
    for (const name of [
      'publish_artifact',
      'update_artifact',
      'share_artifact',
      'reply_to_comment',
      'resolve_comment_thread',
    ]) {
      expect(byName.get(name)?.annotations.readOnlyHint, name).toBe(false);
    }
  });

  it('calls only update_artifact destructive, because only it replaces what a reader sees', () => {
    const destructive = TOOLS.filter((tool) => tool.annotations.destructiveHint).map((t) => t.name);
    expect(destructive).toEqual(['update_artifact']);
  });

  it('calls only share_artifact open-world, because only it emails somebody', () => {
    // reply_to_comment tells people too, but through in-app notifications that
    // never leave the instance. If replying ever starts sending mail, this fails.
    const openWorld = TOOLS.filter((tool) => tool.annotations.openWorldHint).map((t) => t.name);
    expect(openWorld).toEqual(['share_artifact']);
  });

  it('marks the two that stack up as not idempotent', () => {
    // Publishing twice makes two pages; replying twice makes two replies.
    expect(byName.get('publish_artifact')?.annotations.idempotentHint).toBe(false);
    expect(byName.get('reply_to_comment')?.annotations.idempotentHint).toBe(false);
  });
});
