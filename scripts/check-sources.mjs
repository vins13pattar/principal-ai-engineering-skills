#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";

function skillFilesIn(rootDir) {
  const skillsDir = join(rootDir, "skills");
  if (!existsSync(skillsDir)) return [];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".md") ? [relative(rootDir, full)] : [];
    });
  return walk(skillsDir).sort();
}

export function readManifest(rootDir) {
  return JSON.parse(readFileSync(join(rootDir, "sources.json"), "utf8"));
}

export function checkCoverage(rootDir) {
  const findings = [];
  const manifest = readManifest(rootDir);
  const present = new Set(skillFilesIn(rootDir));

  for (const file of present) {
    if (!Object.hasOwn(manifest.files, file)) {
      findings.push({ file, rule: "uncovered", message: "skill file has no sources.json entry" });
    }
  }
  for (const [file, sources] of Object.entries(manifest.files)) {
    if (!present.has(file)) {
      findings.push({ file, rule: "missing-source", message: "sources.json names a file that does not exist" });
    } else if (!Array.isArray(sources) || sources.length === 0) {
      findings.push({ file, rule: "manifest", message: "entry lists no handbook sources" });
    }
  }
  return findings;
}

/** Distinct manifest source paths that no longer exist in the handbook checkout. */
export function checkSourcePaths(rootDir, handbookDir) {
  const manifest = readManifest(rootDir);
  const referencedBy = new Map();
  for (const [file, sources] of Object.entries(manifest.files)) {
    for (const source of sources) {
      if (!referencedBy.has(source)) referencedBy.set(source, []);
      referencedBy.get(source).push(file);
    }
  }

  const findings = [];
  for (const [source, files] of referencedBy) {
    if (!existsSync(join(handbookDir, source))) {
      findings.push({
        file: source,
        rule: "stale-source",
        message: `handbook source does not exist, referenced by ${files.sort().join(", ")}`,
      });
    }
  }
  return findings;
}

/** Which skill files derive from handbook sources changed since the pinned SHA. */
export function reportDrift(rootDir, handbookDir) {
  const manifest = readManifest(rootDir);
  const changed = new Set(
    execFileSync("git", ["diff", "--name-only", `${manifest.handbookSha}..HEAD`], {
      cwd: handbookDir,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean),
  );
  return Object.entries(manifest.files)
    .map(([file, sources]) => ({ file, changedSources: sources.filter((s) => changed.has(s)) }))
    .filter((entry) => entry.changedSources.length > 0);
}

// See the note in validate.mjs: realpathSync is required, not stylistic.
if (import.meta.filename === realpathSync(process.argv[1])) {
  const root = resolve(".");
  const findings = checkCoverage(root);
  for (const { file, rule, message } of findings) console.error(`${file}: [${rule}] ${message}`);
  if (findings.length > 0) {
    console.error(`\n${findings.length} finding(s).`);
    process.exit(1);
  }
  console.log("check-sources: every skill file is attributed.");

  const flag = process.argv.indexOf("--handbook");
  if (flag !== -1) {
    const handbook = process.argv[flag + 1];
    if (!handbook || !existsSync(handbook)) {
      console.error("--handbook needs a path to a handbook checkout; skipping drift report.");
      process.exit(1);
    }
    const staleSources = checkSourcePaths(root, handbook);
    for (const { file, rule, message } of staleSources) console.error(`${file}: [${rule}] ${message}`);

    const drifted = reportDrift(root, handbook);
    if (drifted.length === 0) {
      console.log("check-sources: no upstream drift since the pinned SHA.");
    } else {
      console.log(`\nDrift since ${readManifest(root).handbookSha}:`);
      for (const { file, changedSources } of drifted) {
        console.log(`  ${file}`);
        for (const source of changedSources) console.log(`    <- ${source}`);
      }
      console.log("\nThese need rewriting by hand. Nothing was changed.");
    }

    if (staleSources.length > 0) {
      console.error(`\n${staleSources.length} stale source path(s).`);
      process.exit(1);
    }
  }
}
