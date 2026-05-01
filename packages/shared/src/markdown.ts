import type { JsonValue, MarkdownChunk } from "./types.js";
import { normalizeTag, unique } from "./security.js";

export interface ParsedMarkdown {
  frontmatter: Record<string, JsonValue>;
  tags: string[];
  aliases: string[];
  wikilinks: string[];
  embeds: string[];
}

export function titleFromPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "");
}

export function parseMarkdown(_path: string, content: string): ParsedMarkdown {
  const frontmatter = parseFrontmatter(content);
  const aliases = extractAliases(frontmatter);
  const tags = unique([...extractTagsFromFrontmatter(frontmatter), ...extractInlineTags(content)].map(normalizeTag).filter(Boolean));
  const wiki = extractWikiLinks(content);
  return {
    frontmatter,
    tags,
    aliases,
    wikilinks: unique(wiki.filter((link) => !link.embed).map((link) => link.target)),
    embeds: unique(wiki.filter((link) => link.embed).map((link) => link.target))
  };
}

export function parseFrontmatter(content: string): Record<string, JsonValue> {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return {};
  }

  const endMatch = /\r?\n---\r?\n/.exec(content.slice(3));
  if (!endMatch || endMatch.index < 0) {
    return {};
  }

  const blockStart = content.startsWith("---\r\n") ? 5 : 4;
  const block = content.slice(blockStart, 3 + endMatch.index);
  return parseSimpleYamlObject(block);
}

export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return content;
  }
  const end = content.slice(3).search(/\r?\n---\r?\n/);
  if (end < 0) {
    return content;
  }
  return content.slice(3 + end).replace(/^\r?\n---\r?\n/, "");
}

export function chunkMarkdown(path: string, content: string, maxChars = 1600): MarkdownChunk[] {
  const body = stripFrontmatter(content).trim();
  if (!body) {
    return [];
  }

  const sections: Array<{ heading: string | null; content: string }> = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of body.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      pushSection(sections, currentHeading, currentLines);
      currentHeading = heading[2] ?? null;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  pushSection(sections, currentHeading, currentLines);

  const chunks: MarkdownChunk[] = [];
  for (const section of sections) {
    const text = section.content.trim();
    if (!text) {
      continue;
    }
    for (const part of splitLargeText(text, maxChars)) {
      chunks.push({
        path,
        index: chunks.length,
        heading: section.heading,
        content: part
      });
    }
  }
  return chunks;
}

export function extractWikiLinks(content: string): Array<{ target: string; alias: string | null; embed: boolean }> {
  const links: Array<{ target: string; alias: string | null; embed: boolean }> = [];
  const regex = /(!?)\[\[([^\]]+)]]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[2]?.trim();
    if (!raw) {
      continue;
    }
    const [target, alias] = raw.split("|", 2).map((item) => item.trim());
    if (!target) {
      continue;
    }
    links.push({
      target,
      alias: alias || null,
      embed: match[1] === "!"
    });
  }
  return links;
}

export function extractInlineTags(content: string): string[] {
  const withoutCodeBlocks = content.replace(/```[\s\S]*?```/g, " ");
  const tags: string[] = [];
  const regex = /(^|[\s([{])#([A-Za-z0-9_/-]+)(?=$|[\s.,;:!?)}\]])/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(withoutCodeBlocks)) !== null) {
    if (match[2]) {
      tags.push(match[2]);
    }
  }
  return unique(tags);
}

export function extractAliases(frontmatter: Record<string, JsonValue>): string[] {
  const aliases = frontmatter.aliases ?? frontmatter.alias;
  if (Array.isArray(aliases)) {
    return aliases.filter((item): item is string => typeof item === "string");
  }
  if (typeof aliases === "string") {
    return [aliases];
  }
  return [];
}

function extractTagsFromFrontmatter(frontmatter: Record<string, JsonValue>): string[] {
  const tags = frontmatter.tags ?? frontmatter.tag;
  if (Array.isArray(tags)) {
    return tags.flatMap((item) => (typeof item === "string" ? item.split(/[,\s]+/) : []));
  }
  if (typeof tags === "string") {
    return tags.split(/[,\s]+/);
  }
  return [];
}

function parseSimpleYamlObject(block: string): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  const lines = block.split(/\r?\n/);
  let activeKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }

    const listItem = /^\s*-\s+(.+)$/.exec(line);
    if (listItem && activeKey) {
      const existing = result[activeKey];
      const arr = Array.isArray(existing) ? existing : [];
      arr.push(parseScalar(listItem[1] ?? ""));
      result[activeKey] = arr;
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) {
      activeKey = null;
      continue;
    }

    const key = pair[1] ?? "";
    const value = pair[2] ?? "";
    activeKey = key;
    if (!value) {
      result[key] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => parseScalar(item.trim()));
    } else {
      result[key] = parseScalar(value);
    }
  }

  return result;
}

function parseScalar(value: string): JsonValue {
  const trimmed = value.trim();
  const unquoted = trimmed.replace(/^["']|["']$/g, "");
  if (unquoted === "true") {
    return true;
  }
  if (unquoted === "false") {
    return false;
  }
  if (unquoted === "null") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) {
    return Number(unquoted);
  }
  return unquoted;
}

function pushSection(sections: Array<{ heading: string | null; content: string }>, heading: string | null, lines: string[]): void {
  const content = lines.join("\n").trim();
  if (content) {
    sections.push({ heading, content });
  }
}

function splitLargeText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const splitAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), Math.floor(maxChars * 0.7));
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}
