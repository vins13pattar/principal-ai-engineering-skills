// The separator may carry trailing spaces or tabs — an invisible one on the
// CLOSING fence otherwise falls through to PAIR and is reported as a bad
// key-value line, which sends the author looking in the wrong place.
const FENCE = /^---[ \t]*$/;
// One or more spaces after the colon, all of them consumed: `key:  value` used
// to yield " value", a leading space that then travelled silently into the
// name or description.
const PAIR = /^([a-z][a-zA-Z0-9_]*):[ \t]+(.*\S)[ \t]*$/;
// Constructs a real YAML parser reads DIFFERENTLY from the regex above. This
// parser is narrower than YAML in what shapes it allows, but it was silently
// WIDER in what it accepted inside a value, which is the dangerous direction:
// every actual consumer (skills.sh, Claude Code, Codex, Cursor) parses real
// YAML, so a value this accepts and YAML rejects installs nowhere. That
// shipped once — a description containing "provider-SDK skill: SDK retry
// settings" passed every gate here and was skipped at install with "Nested
// mappings are not allowed in compact mappings".
//
// Hand-rolled rather than delegated to js-yaml on purpose: CI runs
// `npm run check` on a clean clone with no `npm install`, so this file must
// have no dependencies.
const YAML_HOSTILE = [
  [/:[ \t]/, 'a colon followed by a space — YAML reads the rest as a nested mapping; use an em dash'],
  [/:$/, "a trailing colon — YAML reads the value as a mapping key"],
  [/[ \t]#/, "a space before # — YAML starts a comment there"],
  [/^[-?:,[\]{}#&*!|>'"%@`]/, "a leading YAML indicator character; rephrase so it starts with a letter"],
];

/**
 * Parse a strict, flat frontmatter block. Deliberately narrower than YAML:
 * only `key: value` pairs are legal, so a skill cannot grow structure the
 * skills.sh indexer would not read. Values are additionally checked against
 * YAML_HOSTILE so this parser never accepts a value real YAML would reject.
 */
export function parseFrontmatter(text) {
  const lines = text.split("\n");
  // Named before anything else: a CRLF file fails the opening-fence test on an
  // invisible \r, and "must open with ---" is exactly the wrong thing to tell
  // an author whose first line IS ---.
  if (lines.some((line) => line.endsWith("\r"))) {
    throw new Error("this file has CRLF line endings; skill files must use LF");
  }
  if (!FENCE.test(lines[0])) {
    throw new Error("line 1: a skill file must open with --- on its own line");
  }
  const data = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const humanLine = i + 1;
    if (FENCE.test(line)) {
      return { data, bodyStartLine: humanLine + 1 };
    }
    if (line.trim() === "") continue;
    const match = PAIR.exec(line);
    if (!match) {
      throw new Error(
        `line ${humanLine}: expected a flat "key: value" pair, got ${JSON.stringify(line)}`,
      );
    }
    const [, key, value] = match;
    if (Object.hasOwn(data, key)) {
      throw new Error(`line ${humanLine}: duplicate key ${JSON.stringify(key)}`);
    }
    const hostile = YAML_HOSTILE.find(([pattern]) => pattern.test(value));
    if (hostile) {
      throw new Error(
        `line ${humanLine}: ${key} contains ${hostile[1]}. A real YAML parser would reject this file, so the skill would not install.`,
      );
    }
    data[key] = value;
  }
  throw new Error("unterminated frontmatter: no closing --- was found");
}
