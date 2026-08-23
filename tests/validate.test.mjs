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
