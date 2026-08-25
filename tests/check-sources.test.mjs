import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCoverage, checkSourcePaths } from "../scripts/check-sources.mjs";

function scratch(manifest, skillFiles) {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  for (const [path, body] of Object.entries(skillFiles)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  writeFileSync(join(root, "sources.json"), JSON.stringify(manifest));
  return root;
}

function scratchHandbook(files) {
  const root = mkdtempSync(join(tmpdir(), "handbook-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const manifest = (files) => ({ handbookRepo: "r", handbookSha: "abc123", files });

test("a fully covered tree produces no findings", () => {
  const root = scratch(manifest({ "skills/a/SKILL.md": ["page.mdx"] }), {
    "skills/a/SKILL.md": "body",
  });
  assert.deepEqual(checkCoverage(root), []);
});

test("flags a skill file absent from the manifest", () => {
  const root = scratch(manifest({ "skills/a/SKILL.md": ["page.mdx"] }), {
    "skills/a/SKILL.md": "body",
    "skills/a/references/notes.md": "body",
  });
  const findings = checkCoverage(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "uncovered");
  assert.match(findings[0].file, /references\/notes\.md/);
});

test("flags a manifest entry whose file was deleted", () => {
  const root = scratch(
    manifest({ "skills/a/SKILL.md": ["page.mdx"], "skills/a/references/gone.md": ["page.mdx"] }),
    { "skills/a/SKILL.md": "body" },
  );
  const findings = checkCoverage(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "missing-source");
});

test("flags an entry with an empty source list", () => {
  const root = scratch(manifest({ "skills/a/SKILL.md": [] }), { "skills/a/SKILL.md": "body" });
  const findings = checkCoverage(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "manifest");
});

test("flags a manifest source path that does not exist in the handbook checkout", () => {
  const root = scratch(manifest({ "skills/a/SKILL.md": ["missing.mdx"] }), {
    "skills/a/SKILL.md": "body",
  });
  const handbook = scratchHandbook({});
  const findings = checkSourcePaths(root, handbook);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "stale-source");
});

test("a manifest whose source paths all exist in the handbook checkout produces no findings", () => {
  const root = scratch(manifest({ "skills/a/SKILL.md": ["present.mdx"] }), {
    "skills/a/SKILL.md": "body",
  });
  const handbook = scratchHandbook({ "present.mdx": "body" });
  assert.deepEqual(checkSourcePaths(root, handbook), []);
});

test("flags only the missing path when one of two source paths exists", () => {
  const root = scratch(
    manifest({ "skills/a/SKILL.md": ["present.mdx"], "skills/b/SKILL.md": ["missing.mdx"] }),
    { "skills/a/SKILL.md": "body", "skills/b/SKILL.md": "body" },
  );
  const handbook = scratchHandbook({ "present.mdx": "body" });
  const findings = checkSourcePaths(root, handbook);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "stale-source");
  assert.match(findings[0].file, /missing\.mdx/);
});
