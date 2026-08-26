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

test("keeps colons that appear in the value", () => {
  const { data } = parseFrontmatter("---\nname: a\ndescription: Use when: retries\n---\n");
  assert.equal(data.description, "Use when: retries");
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
