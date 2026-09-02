import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../scripts/frontmatter.mjs";

test("parses flat key-value pairs", () => {
  const { data, bodyStartLine } = parseFrontmatter(
    "---\nname: llm-gateway\ndescription: Use when x\n---\n# Body\n",
  );
  assert.deepEqual(data, { name: "llm-gateway", description: "Use when x" });
  assert.equal(bodyStartLine, 5);
});

test("ignores blank lines inside the block", () => {
  const { data } = parseFrontmatter("---\nname: a\n\ndescription: b\n---\n");
  assert.deepEqual(data, { name: "a", description: "b" });
});

// This test used to assert the opposite — that a colon-space in a value was
// kept verbatim. That "feature" is what let llm-gateway ship a description
// real YAML could not parse, so the skill was skipped at install while every
// gate here stayed green. The parser must never accept what YAML rejects.
test("rejects a colon-space in a value, which YAML reads as a nested mapping", () => {
  assert.throws(
    () => parseFrontmatter("---\nname: a\ndescription: Use when: retries\n---\n"),
    /line 3.*colon followed by a space.*would not install/is,
  );
});

test("keeps a colon that is not followed by a space", () => {
  const { data } = parseFrontmatter("---\nname: a\ndescription: Use when ratio a:b matters\n---\n");
  assert.equal(data.description, "Use when ratio a:b matters");
});

test("rejects the other constructs YAML reads differently", () => {
  assert.throws(() => parseFrontmatter("---\nname: a\nd: trailing colon:\n---\n"), /trailing colon/i);
  assert.throws(() => parseFrontmatter("---\nname: a\nd: text #comment\n---\n"), /starts a comment/i);
  assert.throws(() => parseFrontmatter("---\nname: a\nd: *anchor here\n---\n"), /indicator character/i);
});

test("rejects a file that does not open with a fence", () => {
  assert.throws(() => parseFrontmatter("# No frontmatter\n"), /line 1.*must open with ---/is);
});

test("rejects an unterminated block", () => {
  assert.throws(() => parseFrontmatter("---\nname: a\n"), /unterminated/i);
});

test("rejects a duplicate key", () => {
  assert.throws(() => parseFrontmatter("---\nname: a\nname: b\n---\n"), /line 3.*duplicate key/is);
});

test("rejects a nested or list value", () => {
  assert.throws(() => parseFrontmatter("---\nname: a\nmeta:\n  - x\n---\n"), /line 3/);
});

test("rejects a tab-indented continuation", () => {
  assert.throws(() => parseFrontmatter("---\nname: a\n\tmore\n---\n"), /line 3/);
});

test("consumes every space after the colon, not just one", () => {
  const { data } = parseFrontmatter("---\nname:   a\ndescription:\tb\n---\n");
  assert.equal(data.name, "a");
  assert.equal(data.description, "b");
});

test("closes on a fence carrying trailing whitespace", () => {
  const { data, bodyStartLine } = parseFrontmatter("---\nname: a\n---  \n# Body\n");
  assert.deepEqual(data, { name: "a" });
  assert.equal(bodyStartLine, 4);
});

test("names CRLF line endings instead of blaming the opening fence", () => {
  assert.throws(() => parseFrontmatter("---\r\nname: a\r\n---\r\n"), /CRLF/);
});

test("still rejects an indented fence", () => {
  assert.throws(() => parseFrontmatter("  ---\nname: a\n---\n"), /line 1.*must open with ---/is);
});
