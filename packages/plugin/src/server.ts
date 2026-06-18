import { FileSystemAdapter, TFile } from "obsidian";
import {
  clampLimit,
  clampOffset,
  appendNoteContent,
  deleteExactText,
  isPathIncluded,
  makeSnippet,
  NoteEditError,
  normalizeVaultScope,
  normalizeVaultPath,
  parseMarkdown,
  replaceExactText,
  titleFromPath,
  truncateText,
  type BridgeExportResponse,
  type BridgeListResponse,
  type BridgeStatus,
  type JsonValue,
  type NoteMetadata,
  type SearchResult,
  type VaultNote,
  type VaultNoteSummary,
  type WriteNoteResponse
} from "@obsidian-mcp/shared";
import type ObsidianMcpPlugin from "./main.js";
import { buildVaultScopePreview } from "./settings.js";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

export interface BridgeServerHandle {
  close(): Promise<void>;
}

interface NodeHttp {
  createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

type JsonRecord = Record<string, unknown>;

interface BridgeCache {
  tags?: { tag: string }[];
  frontmatter?: Record<string, JsonValue>;
  links?: { link: string }[];
  embeds?: { link: string }[];
}

type WriteOperation = WriteNoteResponse["operation"];

export async function createBridgeServer(plugin: ObsidianMcpPlugin, token: string): Promise<BridgeServerHandle> {
  const http = loadNodeHttp();
  const server = http.createServer((request, response) => {
    void handleRequest(plugin, token, request, response).catch((error) => {
      console.error("MCP bridge request failed", error);
      sendJson(response, 500, { error: "Internal bridge error." });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(plugin.settings.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function handleRequest(
  plugin: ObsidianMcpPlugin,
  token: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (!isAuthorized(request, token)) {
    await plugin.audit({ route: url.pathname, allowed: false, reason: "unauthorized" });
    sendJson(response, 401, { error: "Unauthorized." });
    return;
  }

  const body = request.method === "POST" ? await readJsonBody(request, plugin.settings.maxNoteBytes + 16_384) : {};
  const route = url.pathname.replace(/\/+$/, "") || "/";

  switch (route) {
    case "/status":
      sendJson(response, 200, buildStatus(plugin));
      await plugin.audit({ route, allowed: true });
      return;
    case "/notes/list":
      sendJson(response, 200, listNotes(plugin, body));
      await plugin.audit({ route, allowed: true });
      return;
    case "/notes/export":
      sendJson(response, 200, await exportNotes(plugin, body));
      await plugin.audit({ route, allowed: true });
      return;
    case "/notes/search":
      sendJson(response, 200, await searchNotes(plugin, body));
      await plugin.audit({ route, allowed: true });
      return;
    case "/notes/read":
      await routeReadNote(plugin, response, route, body);
      return;
    case "/notes/metadata":
      await routeMetadata(plugin, response, route, body);
      return;
    case "/notes/links":
      await routeLinks(plugin, response, route, body);
      return;
    case "/notes/create":
      await routeCreateNote(plugin, response, route, body);
      return;
    case "/notes/append":
      await routeAppendNote(plugin, response, route, body);
      return;
    case "/notes/replace":
      await routeReplaceNoteText(plugin, response, route, body);
      return;
    case "/notes/delete-text":
      await routeDeleteNoteText(plugin, response, route, body);
      return;
    case "/notes/rewrite":
      await routeRewriteNote(plugin, response, route, body);
      return;
    default:
      await plugin.audit({ route, allowed: false, reason: "unknown_route" });
      sendJson(response, 404, { error: "Unknown bridge route." });
  }
}

function buildStatus(plugin: ObsidianMcpPlugin): BridgeStatus {
  const files = getAllowedMarkdownFiles(plugin);
  const pluginDirectory = getPluginDirectory(plugin);
  return {
    ok: true,
    vaultName: plugin.app.vault.getName(),
    pluginVersion: plugin.manifest.version,
    bridgeVersion: plugin.manifest.version,
    readOnly: !plugin.settings.writeToolsEnabled,
    writeToolsEnabled: plugin.settings.writeToolsEnabled,
    autoPruneEmbeddings: plugin.settings.autoPruneEmbeddings,
    pluginDirectory,
    scope: normalizeVaultScope(plugin.settings),
    vaultPreview: buildVaultScopePreview(plugin),
    includedNoteCount: files.length,
    maxNoteBytes: plugin.settings.maxNoteBytes,
    auditEnabled: plugin.settings.auditEnabled
  };
}

function getPluginDirectory(plugin: ObsidianMcpPlugin): BridgeStatus["pluginDirectory"] {
  const vaultPath = plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
  const adapter = plugin.app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) {
    const basePath = adapter.getBasePath();
    const filesystemPath = `${basePath}/${vaultPath}`;
    return {
      vaultPath,
      filesystemPath,
      defaultDatabasePath: `${filesystemPath}/index.sqlite`
    };
  }
  return {
    vaultPath,
    filesystemPath: null,
    defaultDatabasePath: null
  };
}

function listNotes(plugin: ObsidianMcpPlugin, body: JsonRecord): BridgeListResponse {
  const limit = clampLimit(body.limit);
  const offset = clampOffset(body.offset);
  const files = getAllowedMarkdownFiles(plugin);
  const notes = files.slice(offset, offset + limit).map((file) => buildSummary(plugin, file));
  return {
    notes,
    nextOffset: offset + limit < files.length ? offset + limit : null
  };
}

async function exportNotes(plugin: ObsidianMcpPlugin, body: JsonRecord): Promise<BridgeExportResponse> {
  const limit = clampLimit(body.limit, 20, 50);
  const offset = clampOffset(body.offset);
  const files = getAllowedMarkdownFiles(plugin);
  const notes = await Promise.all(files.slice(offset, offset + limit).map((file) => buildVaultNote(plugin, file)));
  return {
    notes,
    nextOffset: offset + limit < files.length ? offset + limit : null
  };
}

async function searchNotes(plugin: ObsidianMcpPlugin, body: JsonRecord): Promise<{ results: SearchResult[] }> {
  const query = stringField(body.query).trim();
  const limit = clampLimit(body.limit);
  if (!query) {
    return { results: [] };
  }
  const files = getAllowedMarkdownFiles(plugin);
  const results: SearchResult[] = [];
  for (const file of files) {
    const content = await plugin.app.vault.cachedRead(file);
    const index = content.toLowerCase().indexOf(query.toLowerCase());
    if (index < 0) {
      continue;
    }
    const summary = buildSummary(plugin, file);
    results.push({
      path: file.path,
      title: summary.title,
      score: index,
      snippet: makeSnippet(content, query),
      tags: summary.tags,
      mtime: file.stat.mtime
    });
    if (results.length >= limit) {
      break;
    }
  }
  return { results };
}

async function routeReadNote(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord
): Promise<void> {
  const file = getAllowedFileByPath(plugin, body.path);
  const rawPath = stringField(body.path);
  if (!file) {
    await plugin.audit({ route, path: rawPath, allowed: false, reason: "denied_or_missing" });
    sendJson(response, 404, { error: "Allowed note not found." });
    return;
  }
  const note = await buildVaultNote(plugin, file, clampLimit(body.maxBytes, plugin.settings.maxNoteBytes, plugin.settings.maxNoteBytes));
  await plugin.audit({ route, path: file.path, allowed: true });
  sendJson(response, 200, note);
}

async function routeMetadata(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord
): Promise<void> {
  const file = getAllowedFileByPath(plugin, body.path);
  const rawPath = stringField(body.path);
  if (!file) {
    await plugin.audit({ route, path: rawPath, allowed: false, reason: "denied_or_missing" });
    sendJson(response, 404, { error: "Allowed note not found." });
    return;
  }
  await plugin.audit({ route, path: file.path, allowed: true });
  sendJson(response, 200, buildMetadata(plugin, file));
}

async function routeLinks(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord
): Promise<void> {
  const file = getAllowedFileByPath(plugin, body.path);
  const rawPath = stringField(body.path);
  if (!file) {
    await plugin.audit({ route, path: rawPath, allowed: false, reason: "denied_or_missing" });
    sendJson(response, 404, { error: "Allowed note not found." });
    return;
  }
  const metadata = buildMetadata(plugin, file);
  await plugin.audit({ route, path: file.path, allowed: true });
  sendJson(response, 200, {
    path: file.path,
    outlinks: metadata.outlinks,
    embeds: metadata.embeds,
    backlinks: metadata.backlinks
  });
}

async function routeCreateNote(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord
): Promise<void> {
  if (!(await ensureWritesEnabled(plugin, response, route, stringField(body.path)))) {
    return;
  }

  const path = getWritableNewPath(plugin, body.path);
  const rawPath = stringField(body.path);
  if (!path) {
    await plugin.audit({ route, path: rawPath, allowed: false, reason: "denied_or_invalid" });
    sendJson(response, 404, { error: "Writable Markdown path is not allowed." });
    return;
  }

  const content = stringField(body.content);
  if (!isContentWithinLimit(content, plugin.settings.maxNoteBytes)) {
    await plugin.audit({ route, path, allowed: false, reason: "content_too_large" });
    sendJson(response, 413, { error: `Content exceeds maximum note size of ${plugin.settings.maxNoteBytes} bytes.` });
    return;
  }

  const existing = plugin.app.vault.getAbstractFileByPath(path);
  const overwrite = booleanField(body.overwrite);
  if (existing && !(existing instanceof TFile && existing.extension === "md" && overwrite && isAllowedFile(plugin, existing))) {
    await plugin.audit({ route, path, allowed: false, reason: "path_exists" });
    sendJson(response, 409, { error: "A vault item already exists at this path." });
    return;
  }

  try {
    const file = existing instanceof TFile ? existing : await plugin.app.vault.create(path, content);
    if (existing instanceof TFile) {
      await plugin.app.vault.modify(file, content);
    }
    await sendWriteResponse(plugin, response, route, "create", file, content);
  } catch (error) {
    await plugin.audit({ route, path, allowed: false, reason: "write_failed" });
    sendJson(response, 400, { error: formatWriteError(error) });
  }
}

async function routeAppendNote(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord
): Promise<void> {
  if (!(await ensureWritesEnabled(plugin, response, route, stringField(body.path)))) {
    return;
  }

  const content = stringField(body.content);
  if (!content) {
    await plugin.audit({ route, path: stringField(body.path), allowed: false, reason: "empty_append" });
    sendJson(response, 400, { error: "Append content must not be empty." });
    return;
  }
  await routeMutateExistingNote(plugin, response, route, body, "append", (existing) =>
    appendNoteContent(existing, content)
  );
}

async function routeReplaceNoteText(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord
): Promise<void> {
  await routeMutateExistingNote(plugin, response, route, body, "replace", (existing) =>
    replaceExactText(existing, stringField(body.oldText), stringField(body.newText), optionalOccurrenceIndex(body.occurrenceIndex))
  );
}

async function routeDeleteNoteText(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord
): Promise<void> {
  await routeMutateExistingNote(plugin, response, route, body, "delete_text", (existing) =>
    deleteExactText(existing, stringField(body.text), optionalOccurrenceIndex(body.occurrenceIndex))
  );
}

async function routeRewriteNote(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord
): Promise<void> {
  await routeMutateExistingNote(plugin, response, route, body, "rewrite", () => stringField(body.content));
}

async function routeMutateExistingNote(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord,
  operation: Exclude<WriteOperation, "create">,
  edit: (existing: string) => string
): Promise<void> {
  const rawPath = stringField(body.path);
  if (!plugin.settings.writeToolsEnabled) {
    await plugin.audit({ route, path: rawPath, allowed: false, reason: "writes_disabled" });
    sendJson(response, 403, { error: "Write tools are disabled in the Obsidian plugin settings." });
    return;
  }

  const file = getAllowedFileByPath(plugin, body.path);
  if (!file) {
    await plugin.audit({ route, path: rawPath, allowed: false, reason: "denied_or_missing" });
    sendJson(response, 404, { error: "Writable note not found." });
    return;
  }

  try {
    const existing = await plugin.app.vault.cachedRead(file);
    const next = edit(existing);
    if (!isContentWithinLimit(next, plugin.settings.maxNoteBytes)) {
      await plugin.audit({ route, path: file.path, allowed: false, reason: "content_too_large" });
      sendJson(response, 413, { error: `Content exceeds maximum note size of ${plugin.settings.maxNoteBytes} bytes.` });
      return;
    }
    await plugin.app.vault.modify(file, next);
    await sendWriteResponse(plugin, response, route, operation, file, next);
  } catch (error) {
    await plugin.audit({ route, path: file.path, allowed: false, reason: error instanceof NoteEditError ? error.code : "write_failed" });
    sendJson(response, error instanceof NoteEditError ? 400 : 500, { error: formatWriteError(error) });
  }
}

async function sendWriteResponse(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  operation: WriteOperation,
  file: TFile,
  content: string
): Promise<void> {
  const note = buildVaultNoteFromContent(plugin, file, content, plugin.settings.maxNoteBytes);
  await plugin.audit({ route, path: file.path, allowed: true });
  sendJson(response, 200, { operation, note } satisfies WriteNoteResponse);
}

async function ensureWritesEnabled(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  path?: string
): Promise<boolean> {
  if (plugin.settings.writeToolsEnabled) {
    return true;
  }
  await plugin.audit({ route, path, allowed: false, reason: "writes_disabled" });
  sendJson(response, 403, { error: "Write tools are disabled in the Obsidian plugin settings." });
  return false;
}

function getAllowedMarkdownFiles(plugin: ObsidianMcpPlugin): TFile[] {
  const files = plugin.app.vault
    .getMarkdownFiles()
    .filter((file) => isAllowedFile(plugin, file))
    .sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function getWritableNewPath(plugin: ObsidianMcpPlugin, rawPath: unknown): string | null {
  if (typeof rawPath !== "string") {
    return null;
  }
  try {
    const normalized = normalizeVaultPath(rawPath);
    return isPathIncluded(normalized, [], plugin.settings) ? normalized : null;
  } catch {
    return null;
  }
}

function getAllowedFileByPath(plugin: ObsidianMcpPlugin, rawPath: unknown) {
  if (typeof rawPath !== "string") {
    return null;
  }
  let normalized: string;
  try {
    normalized = normalizeVaultPath(rawPath);
  } catch {
    return null;
  }
  const abstract = plugin.app.vault.getAbstractFileByPath(normalized);
  if (!(abstract instanceof TFile) || abstract.extension !== "md") {
    return null;
  }
  return isAllowedFile(plugin, abstract) ? abstract : null;
}

function isAllowedFile(plugin: ObsidianMcpPlugin, file: TFile): boolean {
  const cache = plugin.app.metadataCache.getFileCache(file);
  const tags = extractCacheTags(cache);
  return isPathIncluded(file.path, tags, plugin.settings);
}

function buildSummary(plugin: ObsidianMcpPlugin, file: TFile): VaultNoteSummary {
  const metadata = buildMetadata(plugin, file);
  return {
    path: file.path,
    title: metadata.title,
    mtime: file.stat.mtime,
    size: file.stat.size,
    tags: metadata.tags,
    aliases: metadata.aliases,
    frontmatter: metadata.frontmatter
  };
}

async function buildVaultNote(plugin: ObsidianMcpPlugin, file: TFile, maxBytes = plugin.settings.maxNoteBytes): Promise<VaultNote> {
  const content = await plugin.app.vault.cachedRead(file);
  return buildVaultNoteFromContent(plugin, file, content, maxBytes);
}

function buildVaultNoteFromContent(plugin: ObsidianMcpPlugin, file: TFile, content: string, maxBytes = plugin.settings.maxNoteBytes): VaultNote {
  const truncated = truncateText(content, maxBytes);
  const metadata = buildMetadata(plugin, file, content);
  return {
    path: file.path,
    title: metadata.title,
    mtime: file.stat.mtime,
    size: file.stat.size,
    tags: metadata.tags,
    aliases: metadata.aliases,
    frontmatter: metadata.frontmatter,
    content: truncated.text,
    truncated: truncated.truncated,
    metadata
  };
}

function buildMetadata(plugin: ObsidianMcpPlugin, file: TFile, content?: string): NoteMetadata {
  const cache = plugin.app.metadataCache.getFileCache(file);
  const parsed = content ? parseMarkdown(file.path, content) : null;
  const cacheTags = extractCacheTags(cache);
  const frontmatter = parsed?.frontmatter ?? cache?.frontmatter ?? {};
  const tags = Array.from(new Set([...(parsed?.tags ?? []), ...cacheTags])).sort();
  const aliases = extractAliases(cache, parsed?.aliases ?? []);
  const outlinks = extractOutlinks(cache, parsed?.wikilinks ?? []);
  const embeds = extractEmbeds(cache, parsed?.embeds ?? []);
  const backlinks = extractBacklinks(plugin, file);

  return {
    path: file.path,
    title: titleFromPath(file.path),
    basename: file.basename,
    extension: file.extension,
    stat: {
      ctime: file.stat.ctime,
      mtime: file.stat.mtime,
      size: file.stat.size
    },
    frontmatter,
    tags,
    aliases,
    outlinks,
    embeds,
    backlinks
  };
}

function extractCacheTags(cache: BridgeCache | null): string[] {
  const direct = cache?.tags?.map((tag) => tag.tag.replace(/^#/, "")) ?? [];
  const fm = stringList(cache?.frontmatter?.tags);
  return Array.from(new Set([...direct, ...fm].map((tag) => tag.replace(/^#/, "").toLowerCase()).filter(Boolean))).sort();
}

function extractAliases(cache: BridgeCache | null, parsedAliases: string[]): string[] {
  const cacheAliases = stringList(cache?.frontmatter?.aliases ?? cache?.frontmatter?.alias);
  return Array.from(new Set([...cacheAliases, ...parsedAliases])).sort();
}

function extractOutlinks(cache: BridgeCache | null, parsedLinks: string[]): string[] {
  const cacheLinks = cache?.links?.map((link) => link.link).filter(Boolean) ?? [];
  return Array.from(new Set([...cacheLinks, ...parsedLinks])).sort();
}

function extractEmbeds(cache: BridgeCache | null, parsedEmbeds: string[]): string[] {
  const cacheEmbeds = cache?.embeds?.map((embed) => embed.link).filter(Boolean) ?? [];
  return Array.from(new Set([...cacheEmbeds, ...parsedEmbeds])).sort();
}

function extractBacklinks(plugin: ObsidianMcpPlugin, file: TFile): string[] {
  const resolvedLinks = plugin.app.metadataCache.resolvedLinks;
  return Object.entries(resolvedLinks)
    .filter(([source, targets]) => source !== file.path && targets[file.path] && isAllowedPathOnly(plugin, source))
    .map(([source]) => source)
    .sort();
}

function isAllowedPathOnly(plugin: ObsidianMcpPlugin, path: string): boolean {
  const abstract = plugin.app.vault.getAbstractFileByPath(path);
  if (!(abstract instanceof TFile) || abstract.extension !== "md") {
    return false;
  }
  return isAllowedFile(plugin, abstract);
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  return header === `Bearer ${token}`;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<JsonRecord> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > Math.max(64_000, maxBytes)) {
      throw new Error("Request body too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRecord;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanField(value: unknown): boolean {
  return value === true;
}

function optionalOccurrenceIndex(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new NoteEditError("occurrenceIndex must be a non-negative integer when provided.", "invalid_occurrence");
}

function isContentWithinLimit(value: string, maxBytes: number): boolean {
  return new TextEncoder().encode(value).byteLength <= maxBytes;
}

function formatWriteError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? value.split(/[,\s]+/) : [];
}

function loadNodeHttp(): NodeHttp {
  const requireFn = (window as unknown as { require?: (module: string) => unknown }).require;
  if (!requireFn) {
    throw new Error("Node require is not available in Obsidian desktop.");
  }
  return requireFn("http") as NodeHttp;
}
