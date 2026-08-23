#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LINK = /\[[^\]]*\]\(([^)]+)\)/g;
// Link-reference definitions: `[label]: target` optionally followed by a
// "title", 'title', or (title) — e.g. `[1]: references/notes.md "See also"`.
const REF_DEF = /^[ \t]{0,3}\[[^\]]+\]:\s*(\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/gm;
// A line that, after at most 3 leading spaces, is a run of 3+ backticks or
// tildes — a candidate fence opener or closer. `rest` is whatever follows the
// run (an info string on an opener; must be blank on a closer).
const FENCE_MARK = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SKILL_MAX_LINES = 200;
const REFERENCE_MAX_LINES = 300;
const DESCRIPTION_MAX = 500;

const countLines = (text) => text.replace(/\n$/, "").split("\n").length;

function markdownFilesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return markdownFilesIn(full);
      return entry.name.endsWith(".md") ? [full] : [];
    });
}

function fenceMark(line) {
  const match = FENCE_MARK.exec(line);
  if (!match) return null;
  return { char: match[1][0], length: match[1].length, rest: match[2] };
}

// Fence rules are stateful (CommonMark), not a single regex: walk the lines
// once, tracking whether we are inside a fence. A line opens a fence when it
// is a fence mark and we are not already inside one; while inside, only a
// mark with the SAME character and a run at least as long, with nothing but
// the mark on the line, closes it. An opener with an info string still opens;
// a closer may not carry one. If the file ends while still open, everything
// to EOF stays inside. In-fence lines (including the delimiters themselves)
// are replaced with blank lines so line-based logic elsewhere is unaffected.
function stripFencedCode(text) {
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;
  const lines = text.split("\n").map((line) => {
    const mark = fenceMark(line);
    if (!inFence) {
      if (!mark) return line;
      inFence = true;
      fenceChar = mark.char;
      fenceLength = mark.length;
      return "";
    }
    if (mark && mark.char === fenceChar && mark.length >= fenceLength && mark.rest.trim() === "") {
      inFence = false;
    }
    return "";
  });
  return lines.join("\n");
}

function checkLinkTarget(file, target, findings) {
  if (/^(https?:|mailto:|#)/.test(target)) return;
  const [path] = target.split("#");
  if (path === "") return;
  if (!existsSync(resolve(dirname(file), path))) {
    findings.push({ file, rule: "link", message: `link target does not exist: ${target}` });
  }
}

function checkLinks(file, text, findings) {
  const scannable = stripFencedCode(text);
  for (const [, target] of scannable.matchAll(LINK)) {
    checkLinkTarget(file, target, findings);
  }
  for (const [, target] of scannable.matchAll(REF_DEF)) {
    checkLinkTarget(file, target, findings);
  }
}

export function validateSkills(rootDir) {
  const findings = [];
  const skillsDir = join(rootDir, "skills");
  if (!existsSync(skillsDir)) return findings;

  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    const skillFile = join(dir, "SKILL.md");

    if (!existsSync(skillFile)) {
      findings.push({ file: dir, rule: "frontmatter", message: "no SKILL.md in skill directory" });
      continue;
    }

    const text = readFileSync(skillFile, "utf8");
    let data;
    try {
      ({ data } = parseFrontmatter(text));
    } catch (error) {
      findings.push({ file: skillFile, rule: "frontmatter", message: error.message });
      continue;
    }

    if (!data.name) {
      findings.push({ file: skillFile, rule: "name", message: "frontmatter is missing name" });
    } else if (!NAME.test(data.name)) {
      findings.push({ file: skillFile, rule: "name", message: `name must be kebab-case: ${data.name}` });
    } else if (data.name !== entry.name) {
      findings.push({
        file: skillFile,
        rule: "name",
        message: `name ${data.name} does not match directory ${entry.name}`,
      });
    }

    if (!data.description) {
      findings.push({ file: skillFile, rule: "description", message: "frontmatter is missing description" });
    } else if (data.description.length > DESCRIPTION_MAX) {
      findings.push({
        file: skillFile,
        rule: "description",
        message: `description is ${data.description.length} characters, over ${DESCRIPTION_MAX}`,
      });
    } else if (!data.description.startsWith("Use when")) {
      findings.push({
        file: skillFile,
        rule: "description",
        message: 'description must begin "Use when" so the trigger is explicit',
      });
    }

    const skillLines = countLines(text);
    if (skillLines > SKILL_MAX_LINES) {
      findings.push({
        file: skillFile,
        rule: "budget",
        message: `SKILL.md is ${skillLines} lines, over the ${SKILL_MAX_LINES}-line budget`,
      });
    }
    checkLinks(skillFile, text, findings);

    for (const file of markdownFilesIn(join(dir, "references"))) {
      const body = readFileSync(file, "utf8");
      const lines = countLines(body);
      if (lines > REFERENCE_MAX_LINES) {
        findings.push({
          file,
          rule: "budget",
          message: `reference is ${lines} lines, over the ${REFERENCE_MAX_LINES}-line budget`,
        });
      }
      checkLinks(file, body, findings);
    }
  }
  return findings;
}

// realpathSync matters: import.meta.filename resolves symlinks and process.argv[1]
// does not, so a plain comparison is false under any symlinked path (/tmp on macOS)
// and the CLI silently does nothing.
if (import.meta.filename === realpathSync(process.argv[1])) {
  const root = resolve(process.argv[2] ?? ".");
  const findings = validateSkills(root);
  for (const { file, rule, message } of findings) {
    console.error(`${relative(root, file)}: [${rule}] ${message}`);
  }
  if (findings.length > 0) {
    console.error(`\n${findings.length} finding(s).`);
    process.exit(1);
  }
  console.log("validate: all skills pass.");
}
