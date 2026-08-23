import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { validateSkills } from "../scripts/validate.mjs";

// fileURLToPath, not .pathname: .pathname is percent-encoded, and this repo's
// path contains a literal space ("Open Source"), so a %20-encoded path would
// not exist on disk and every fixture lookup would silently return [].
const fixture = (name) => fileURLToPath(new URL(`fixtures/${name}/`, import.meta.url));

test("a well-formed skill produces no findings", () => {
  assert.deepEqual(validateSkills(fixture("good")), []);
});

test("flags a name that is not kebab-case and not the directory name", () => {
  const rules = validateSkills(fixture("bad-name")).map((f) => f.rule);
  assert.ok(rules.includes("name"));
});

test("flags a SKILL.md over the 200-line budget", () => {
  const findings = validateSkills(fixture("bad-budget"));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "budget");
  assert.match(findings[0].message, /214 lines/);
});

test("flags a relative link that resolves to nothing", () => {
  const findings = validateSkills(fixture("bad-link"));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "link");
  assert.match(findings[0].message, /references\/gone\.md/);
});

test("ignores external and anchor links", () => {
  // The good fixture links to https://example.com/page.md and to #body. Neither
  // exists on disk; a checker that resolved them would report two findings.
  assert.deepEqual(validateSkills(fixture("good")), []);
});

test("ignores a broken-looking link inside a fenced code block", () => {
  // The fixture's fence contains [fake](references/not-real.md) as illustrative
  // markdown syntax, not a real link. A checker that scanned fenced code would
  // report a finding here.
  assert.deepEqual(validateSkills(fixture("fenced-code-link")), []);
});

test("flags a reference-style link definition that resolves to nothing", () => {
  const findings = validateSkills(fixture("bad-ref-link"));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "link");
  assert.match(findings[0].message, /references\/missing-ref\.md/);
});

test("accepts a reference-style link definition that resolves correctly", () => {
  assert.deepEqual(validateSkills(fixture("good-ref-link")), []);
});

test("ignores a broken-looking link inside a fence indented under a list item", () => {
  // A fence indented two spaces under a list item is one of the most common
  // shapes in this kind of document. A single-regex stripper anchored to
  // column 0 misses it entirely.
  assert.deepEqual(validateSkills(fixture("indented-fence-link")), []);
});

test("ignores a broken-looking link inside a fence that is never closed", () => {
  // An opener with no closer runs to end of file; everything after it is
  // still inside the fence, including the broken-looking link.
  assert.deepEqual(validateSkills(fixture("unclosed-fence-link")), []);
});

test("does not let a mismatched fence character close a fence", () => {
  // A ``` fence is only closed by a ``` line; a ~~~ line in between does not
  // close it, so the broken-looking link after the ~~~ stays inside the fence.
  assert.deepEqual(validateSkills(fixture("fence-char-mismatch-link")), []);
});

test("does not let a shorter fence run close a longer one", () => {
  // A four-backtick fence is only closed by a line of 4+ backticks; a
  // three-backtick line does not close it.
  assert.deepEqual(validateSkills(fixture("fence-length-mismatch-link")), []);
});

test("still flags a real broken link outside a fence in a file that also has one", () => {
  // Proves the scanner distinguishes in-fence from out-of-fence content
  // rather than degenerating into "strip everything."
  const findings = validateSkills(fixture("mixed-fence-link"));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "link");
  assert.match(findings[0].message, /references\/really-gone\.md/);
});
