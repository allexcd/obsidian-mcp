import type { VaultScopeConfig } from "./types.js";

export const DEFAULT_MAX_NOTE_BYTES = 120_000;
export const DEFAULT_MAX_TOOL_TEXT_BYTES = 24_000;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

const ALWAYS_DENIED_SEGMENTS = new Set([".obsidian", ".trash", ".git"]);

export function normalizeVaultPath(input: string): string {
  const raw = input.trim().replace(/\\/g, "/");
  if (!raw || raw.includes("\0")) {
    throw new Error("Path is empty or invalid.");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    throw new Error("URL-style paths are not allowed.");
  }
  const parts = raw.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      throw new Error("Path traversal is not allowed.");
    }
    normalized.push(part);
  }
  if (normalized.length === 0) {
    throw new Error("Path must point to a vault item.");
  }
  return normalized.join("/");
}

export function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("#") ? trimmed.slice(1).toLowerCase() : trimmed.toLowerCase();
}

export function normalizeFolder(folder: string): string {
  const trimmed = folder.trim();
  if (!trimmed) {
    return "";
  }
  const normalized = normalizeVaultPath(trimmed);
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function normalizeVaultScope(config: VaultScopeConfig): VaultScopeConfig {
  return {
    excludedFolders: unique(config.excludedFolders.map(safeNormalizeFolder).filter(Boolean)),
    excludedFiles: unique(config.excludedFiles.map(safeNormalizePath).filter(Boolean)),
    excludedTags: unique(config.excludedTags.map(normalizeTag).filter(Boolean))
  };
}

export function isHiddenOrConfigPath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  return normalized.split("/").some((segment) => segment.startsWith(".") || ALWAYS_DENIED_SEGMENTS.has(segment));
}

export function isMarkdownPath(path: string): boolean {
  return normalizeVaultPath(path).toLowerCase().endsWith(".md");
}

export function isPathIncluded(path: string, noteTags: string[], config: VaultScopeConfig): boolean {
  const normalized = normalizeVaultPath(path);
  if (!isMarkdownPath(normalized) || isHiddenOrConfigPath(normalized)) {
    return false;
  }

  const scope = normalizeVaultScope(config);
  const fileExcluded = scope.excludedFiles.some((file) => normalized === file);
  if (fileExcluded) {
    return false;
  }

  const folderExcluded = scope.excludedFolders.some((folder) => normalized === folder || normalized.startsWith(`${folder}/`));
  if (folderExcluded) {
    return false;
  }

  const normalizedTags = new Set(noteTags.map(normalizeTag).filter(Boolean));
  const tagExcluded = scope.excludedTags.some((tag) => normalizedTags.has(tag));
  return !tagExcluded;
}

export function clampLimit(value: unknown, fallback = DEFAULT_PAGE_LIMIT, max = MAX_PAGE_LIMIT): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

export function clampOffset(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.floor(parsed));
}

export function truncateText(text: string, maxBytes = DEFAULT_MAX_TOOL_TEXT_BYTES): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) {
    return { text, truncated: false };
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (encoder.encode(text.slice(0, mid)).byteLength <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return { text: `${text.slice(0, low)}\n\n[truncated]`, truncated: true };
}

export function makeSnippet(content: string, query: string, maxChars = 360): string {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return trimSnippet(content.slice(0, maxChars));
  }
  const lower = content.toLowerCase();
  const index = lower.indexOf(normalizedQuery);
  if (index < 0) {
    return trimSnippet(content.slice(0, maxChars));
  }
  const start = Math.max(0, index - Math.floor(maxChars / 3));
  const end = Math.min(content.length, start + maxChars);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return trimSnippet(`${prefix}${content.slice(start, end)}${suffix}`);
}

export function parseDelimitedList(value: string): string[] {
  return unique(
    value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function trimSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function safeNormalizeFolder(folder: string): string {
  try {
    return normalizeFolder(folder);
  } catch {
    return "";
  }
}

function safeNormalizePath(path: string): string {
  try {
    return normalizeVaultPath(path);
  } catch {
    return "";
  }
}
