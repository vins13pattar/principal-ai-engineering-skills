import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCoverage } from "../scripts/check-sources.mjs";

function scratch(manifest, skillFiles) {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  for (const [path, body] of Object.entries(skillFiles)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  writeFileSync(join(root, "sources.json"), JSON.stringify(manifest));
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
