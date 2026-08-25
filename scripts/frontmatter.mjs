// The separator may carry trailing spaces or tabs — an invisible one on the
// CLOSING fence otherwise falls through to PAIR and is reported as a bad
// key-value line, which sends the author looking in the wrong place.
const FENCE = /^---[ \t]*$/;
// One or more spaces after the colon, all of them consumed: `key:  value` used
// to yield " value", a leading space that then travelled silently into the
// name or description.
const PAIR = /^([a-z][a-zA-Z0-9_]*):[ \t]+(.*\S)[ \t]*$/;

/**
 * Parse a strict, flat frontmatter block. Deliberately narrower than YAML:
 * only `key: value` pairs are legal, so a skill cannot grow structure the
 * skills.sh indexer would not read.
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
    data[key] = value;
  }
  throw new Error("unterminated frontmatter: no closing --- was found");
}
