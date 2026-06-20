import { normalizeTag, normalizeVaultPath } from "./security.js";
import type { JsonValue } from "./types.js";

export type BaseFilter = string | { and?: BaseFilter[]; or?: BaseFilter[]; not?: BaseFilter[] };

export type BaseScope =
  | { kind: "vault" }
  | { kind: "folder"; folder: string }
  | { kind: "files"; files: string[] }
  | { kind: "tag"; tag: string }
  | { kind: "custom"; filter: BaseFilter };

export type BaseYamlValue = JsonValue | BaseYamlValue[] | { [key: string]: BaseYamlValue };

export interface BaseViewInput {
  type?: string;
  name?: string;
  order?: string[];
  filters?: BaseFilter;
  [key: string]: BaseYamlValue | undefined;
}

export interface BaseFileInput {
  scope?: BaseScope | BaseScopeShorthand;
  filters?: BaseFilter;
  excludePaths?: string[];
  includeExtensions?: string[];
  excludeExtensions?: string[];
  includeBaseFiles?: boolean;
  properties?: Record<string, BaseYamlValue>;
  formulas?: Record<string, string>;
  summaries?: Record<string, BaseYamlValue>;
  views?: BaseViewInput[];
}

export type BaseScopeShorthand =
  | { folder: string; kind?: undefined }
  | { files: string[]; kind?: undefined }
  | { tag: string; kind?: undefined }
  | { filter: BaseFilter; kind?: undefined };

export interface BaseFileWriteResponse {
  operation: "create_base";
  path: string;
  content: string;
  overwritten: boolean;
  createdFolders: string[];
}

const DEFAULT_BASE_ORDER = ["file.name", "file.folder", "file.mtime", "file.tags"];

export function normalizeBasePath(input: string): string {
  const normalized = normalizeVaultPath(input);
  if (normalized.toLowerCase().endsWith(".base")) {
    return normalized;
  }
  const basename = normalized.split("/").pop() ?? normalized;
  if (basename.includes(".")) {
    throw new Error("Base file path must end with .base or have no extension.");
  }
  return `${normalized}.base`;
}

export function resolveBasePath(input: string | undefined, scope: BaseFileInput["scope"]): string {
  const trimmed = input?.trim() ?? "";
  if (trimmed) {
    return normalizeBasePath(trimmed);
  }
  const normalizedScope = normalizeBaseScope(scope);
  if (normalizedScope.kind === "folder") {
    const folder = normalizeVaultPath(normalizedScope.folder);
    return `${folder}/${folder.split("/").pop()}.base`;
  }
  return "Vault.base";
}

export function buildBaseFileContent(input: BaseFileInput = {}): string {
  const document: Record<string, BaseYamlValue> = {};
  const filter = buildBaseFilters(input);
  if (filter) {
    document.filters = filter;
  }
  const formulas = input.formulas;
  if (formulas && Object.keys(formulas).length > 0) {
    document.formulas = formulas;
  }
  const properties = input.properties;
  if (properties && Object.keys(properties).length > 0) {
    document.properties = properties;
  }
  const summaries = input.summaries;
  if (summaries && Object.keys(summaries).length > 0) {
    document.summaries = summaries;
  }
  document.views = normalizeViews(input.views);
  return `${serializeYaml(document)}\n`;
}

export function normalizeBaseScope(scope: BaseFileInput["scope"]): BaseScope {
  if (!scope) {
    return { kind: "vault" };
  }
  if ("kind" in scope && scope.kind) {
    return scope;
  }
  if ("folder" in scope && typeof scope.folder === "string") {
    return { kind: "folder", folder: scope.folder };
  }
  if ("files" in scope && Array.isArray(scope.files)) {
    return { kind: "files", files: scope.files };
  }
  if ("tag" in scope && typeof scope.tag === "string") {
    return { kind: "tag", tag: scope.tag };
  }
  if ("filter" in scope) {
    return { kind: "custom", filter: scope.filter };
  }
  throw new Error("Base scope is invalid.");
}

export function buildBaseFilter(scope: BaseScope): BaseFilter | undefined {
  switch (scope.kind) {
    case "vault":
      return undefined;
    case "folder":
      return { and: [`file.inFolder(${expressionString(normalizeVaultPath(scope.folder))})`] };
    case "tag": {
      const tag = normalizeTag(scope.tag);
      if (!tag) {
        throw new Error("Base tag scope requires a non-empty tag.");
      }
      return { and: [`file.hasTag(${expressionString(tag)})`] };
    }
    case "files": {
      const files = scope.files.map(normalizeVaultPath);
      if (files.length === 0) {
        throw new Error("Base files scope requires at least one file.");
      }
      const filters = files.map((path) => `file.path == ${expressionString(path)}`);
      return filters.length === 1 ? { and: filters } : { or: filters };
    }
    case "custom":
      return scope.filter;
    default:
      throw new Error("Base scope kind is invalid.");
  }
}

export function buildBaseFilters(input: BaseFileInput): BaseFilter | undefined {
  const filters: BaseFilter[] = [];
  const scopeFilter = buildBaseFilter(normalizeBaseScope(input.scope));
  if (scopeFilter) {
    filters.push(scopeFilter);
  }
  if (input.filters) {
    filters.push(input.filters);
  }
  for (const path of input.excludePaths ?? []) {
    filters.push(`file.path != ${expressionString(normalizeVaultPath(path))}`);
  }
  for (const extension of input.includeExtensions ?? []) {
    filters.push(`file.ext == ${expressionString(normalizeExtension(extension))}`);
  }
  const excludedExtensions = new Set((input.excludeExtensions ?? []).map(normalizeExtension).filter(Boolean));
  if (!input.includeBaseFiles) {
    excludedExtensions.add("base");
  }
  for (const extension of excludedExtensions) {
    filters.push(`file.ext != ${expressionString(extension)}`);
  }
  if (filters.length === 0) {
    return undefined;
  }
  if (filters.length === 1) {
    return filters[0];
  }
  return { and: filters };
}

function normalizeViews(views: BaseViewInput[] | undefined): BaseYamlValue[] {
  const source = views && views.length > 0 ? views : [{ type: "table", name: "Table", order: DEFAULT_BASE_ORDER }];
  return source.map((view) => {
    const normalized: Record<string, BaseYamlValue> = {
      type: view.type || "table",
      name: view.name || "Table"
    };
    for (const [key, value] of Object.entries(view)) {
      if (key === "type" || key === "name" || value === undefined) {
        continue;
      }
      normalized[key] = value;
    }
    if (!("order" in normalized) && normalized.type === "table") {
      normalized.order = DEFAULT_BASE_ORDER;
    }
    return normalized;
  });
}

function normalizeExtension(value: string): string {
  return value.trim().replace(/^\./, "").toLowerCase();
}

function serializeYaml(value: BaseYamlValue, indent = 0): string {
  if (Array.isArray(value)) {
    return value.map((item) => `${spaces(indent)}- ${serializeYamlListItem(item, indent)}`).join("\n");
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, entry]) => {
        if (Array.isArray(entry) || isRecord(entry)) {
          return `${spaces(indent)}${key}:\n${serializeYaml(entry, indent + 2)}`;
        }
        return `${spaces(indent)}${key}: ${serializeYamlScalar(entry)}`.trimEnd();
      })
      .join("\n");
  }
  return `${spaces(indent)}${serializeYamlScalar(value)}`;
}

function serializeYamlListItem(value: BaseYamlValue, indent: number): string {
  if (Array.isArray(value)) {
    return `\n${serializeYaml(value, indent + 2)}`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }
    const [firstKey, firstValue] = entries[0]!;
    const rest = entries.slice(1);
    const first =
      Array.isArray(firstValue) || isRecord(firstValue)
        ? `${firstKey}:\n${serializeYaml(firstValue, indent + 4)}`
        : `${firstKey}: ${serializeYamlScalar(firstValue)}`.trimEnd();
    const remaining = rest
      .map(([key, entry]) =>
        Array.isArray(entry) || isRecord(entry)
          ? `${spaces(indent + 2)}${key}:\n${serializeYaml(entry, indent + 4)}`
          : `${spaces(indent + 2)}${key}: ${serializeYamlScalar(entry)}`.trimEnd()
      )
      .join("\n");
    return remaining ? `${first}\n${remaining}` : first;
  }
  return serializeYamlScalar(value);
}

function serializeYamlScalar(value: BaseYamlValue): string {
  if (value === null) {
    return "";
  }
  if (typeof value === "string") {
    return quoteYamlString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return quoteYamlString(JSON.stringify(value));
}

function quoteYamlString(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function expressionString(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, BaseYamlValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function spaces(count: number): string {
  return " ".repeat(count);
}
