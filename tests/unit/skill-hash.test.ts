import { describe, it, expect } from 'vitest';
import { hashSkill, stampSkill, normalizeSkill } from '../../src/commands/skill.js';

const SRC = '---\nname: toss\ndescription: share html\nlicense: MIT\n---\n\n# Toss\n\nUse `toss share`.\n';

describe('skill content hashing', () => {
  it('round-trips: a stamped install hashes back to the source hash', () => {
    // This is the invariant that prevents spurious updates: install stamps the
    // file, and re-reading it must produce the same hash we started with.
    expect(hashSkill(stampSkill(SRC))).toBe(hashSkill(SRC));
  });

  it('changes when the body changes', () => {
    const edited = SRC.replace('Use `toss share`.', 'Use `toss publish`.');
    expect(hashSkill(edited)).not.toBe(hashSkill(SRC));
  });

  it('changes when the frontmatter description changes', () => {
    const edited = SRC.replace('share html', 'share html and folders');
    expect(hashSkill(edited)).not.toBe(hashSkill(SRC));
  });

  it('ignores the version label — a version bump alone is not a content change', () => {
    const a = '---\nname: toss\nversion: "0.1.0"\ntoss-hash: "aaaa"\n---\n\n# Body\n';
    const b = '---\nname: toss\nversion: "9.9.9"\ntoss-hash: "bbbb"\n---\n\n# Body\n';
    expect(hashSkill(a)).toBe(hashSkill(b));
  });

  it('stamps both a version and a toss-hash into the frontmatter', () => {
    const stamped = stampSkill(SRC);
    expect(stamped).toMatch(/\nversion:\s*"\d+\.\d+\.\d+/);
    expect(stamped).toMatch(/\ntoss-hash:\s*"[0-9a-f]{16}"/);
    // The original frontmatter keys survive the stamp.
    expect(stamped).toContain('name: toss');
    expect(stamped).toContain('license: MIT');
  });

  it('handles content with no frontmatter without throwing', () => {
    // Defensive branch — the real SKILL.md always has frontmatter, but a bare
    // doc must not crash. stampSkill adds a frontmatter block in that case, so
    // we don't assert a source round-trip here (only that it's well-formed).
    const bare = '# Just a heading\n\nbody\n';
    expect(() => hashSkill(bare)).not.toThrow();
    expect(stampSkill(bare).startsWith('---')).toBe(true);
  });

  it('normalizeSkill is idempotent', () => {
    expect(normalizeSkill(normalizeSkill(SRC))).toBe(normalizeSkill(SRC));
  });
});
