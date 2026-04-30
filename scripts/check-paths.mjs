#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const privateUserName = String.fromCharCode(97, 108, 101, 120, 99, 100);
const banned = [
  { label: "private user path", pattern: new RegExp(`/Users/${privateUserName}\\b`, "g") },
  { label: "local test vault name", pattern: new RegExp(`\\b${"Library"}-01\\b`, "g") },
  { label: "local Obsidian drive path", pattern: new RegExp(`${"My Drive"}/Documents/Obsidian`, "g") }
];
const rootsToScan = [
  "README.md",
  "LICENSE",
  "package.json",
  "package-lock.json",
  "docs",
  "packages",
  "scripts",
  "tsconfig.json"
];
const ignoredDirs = new Set([".git", ".claude", "build", "dist", "node_modules"]);
const ignoredFiles = new Set(["packages/plugin/main.js"]);
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".json",
  ".js",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml"
]);

const findings = [];
for (const entry of rootsToScan) {
  scan(join(root, entry));
}

if (findings.length > 0) {
  console.error("Private/local paths found in source or docs:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line}: ${finding.label}`);
    console.error(`  ${finding.text.trim()}`);
  }
  process.exit(1);
}

console.log("No private/local paths found in source or docs.");

function scan(path) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }

  const rel = relative(root, path);
  if (ignoredFiles.has(rel)) {
    return;
  }

  if (stats.isDirectory()) {
    const name = path.split(/[\\/]/).pop();
    if (ignoredDirs.has(name)) {
      return;
    }
    for (const child of readdirSync(path)) {
      scan(join(path, child));
    }
    return;
  }

  if (!stats.isFile() || !isTextFile(path)) {
    return;
  }

  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const rule of banned) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(line)) {
        findings.push({
          file: rel,
          line: index + 1,
          label: rule.label,
          text: line
        });
      }
    }
  }
}

function isTextFile(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) {
    return false;
  }
  return textExtensions.has(path.slice(dot));
}
