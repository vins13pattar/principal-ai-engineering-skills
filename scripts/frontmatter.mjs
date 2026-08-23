const PAIR = /^([a-z][a-zA-Z0-9_]*): (.*\S)\s*$/;

/**
 * Parse a strict, flat frontmatter block. Deliberately narrower than YAML:
 * only `key: value` pairs are legal, so a skill cannot grow structure the
 * skills.sh indexer would not read.
 */
export function parseFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    throw new Error("line 1: a skill file must open with --- on its own line");
  }
  const data = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const humanLine = i + 1;
    if (line === "---") {
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
