import { FileSystemAdapter, type CachedMetadata, type TFile } from "obsidian";
import {
  clampLimit,
  clampOffset,
  isPathIncluded,
  makeSnippet,
  normalizeVaultScope,
  normalizeVaultPath,
  parseMarkdown,
  titleFromPath,
  truncateText,
  type BridgeExportResponse,
  type BridgeListResponse,
  type BridgeStatus,
  type NoteMetadata,
  type SearchResult,
  type VaultNote,
  type VaultNoteSummary
} from "@obsidian-mcp/shared";
import type ObsidianMcpPlugin from "./main.js";
import { buildVaultScopePreview } from "./settings.js";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

export interface BridgeServerHandle {
  close(): Promise<void>;
}

const BRIDGE_VERSION = "0.1.0";

interface NodeHttp {
  createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

type JsonRecord = Record<string, unknown>;

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

  const body = request.method === "POST" ? await readJsonBody(request) : {};
  const route = url.pathname.replace(/\/+$/, "") || "/";

  switch (route) {
    case "/status":
      sendJson(response, 200, await buildStatus(plugin));
      await plugin.audit({ route, allowed: true });
      return;
    case "/notes/list":
      sendJson(response, 200, await listNotes(plugin, body));
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
    default:
      await plugin.audit({ route, allowed: false, reason: "unknown_route" });
      sendJson(response, 404, { error: "Unknown bridge route." });
  }
}

async function buildStatus(plugin: ObsidianMcpPlugin): Promise<BridgeStatus> {
  const files = await getAllowedMarkdownFiles(plugin);
  const pluginDirectory = getPluginDirectory(plugin);
  return {
    ok: true,
    vaultName: plugin.app.vault.getName(),
    pluginVersion: BRIDGE_VERSION,
    bridgeVersion: BRIDGE_VERSION,
    readOnly: true,
    pluginDirectory,
    scope: normalizeVaultScope(plugin.settings),
    vaultPreview: buildVaultScopePreview(plugin),
    includedNoteCount: files.length,
    maxNoteBytes: plugin.settings.maxNoteBytes,
    auditEnabled: plugin.settings.auditEnabled
  };
}

function getPluginDirectory(plugin: ObsidianMcpPlugin): BridgeStatus["pluginDirectory"] {
  const vaultPath = plugin.manifest.dir ?? `.obsidian/plugins/${plugin.manifest.id}`;
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

async function listNotes(plugin: ObsidianMcpPlugin, body: JsonRecord): Promise<BridgeListResponse> {
  const limit = clampLimit(body.limit);
  const offset = clampOffset(body.offset);
  const files = await getAllowedMarkdownFiles(plugin);
  const notes = await Promise.all(files.slice(offset, offset + limit).map((file) => buildSummary(plugin, file)));
  return {
    notes,
    nextOffset: offset + limit < files.length ? offset + limit : null
  };
}

async function exportNotes(plugin: ObsidianMcpPlugin, body: JsonRecord): Promise<BridgeExportResponse> {
  const limit = clampLimit(body.limit, 20, 50);
  const offset = clampOffset(body.offset);
  const files = await getAllowedMarkdownFiles(plugin);
  const notes = await Promise.all(files.slice(offset, offset + limit).map((file) => buildVaultNote(plugin, file)));
  return {
    notes,
    nextOffset: offset + limit < files.length ? offset + limit : null
  };
}

async function searchNotes(plugin: ObsidianMcpPlugin, body: JsonRecord): Promise<{ results: SearchResult[] }> {
  const query = String(body.query ?? "").trim();
  const limit = clampLimit(body.limit);
  if (!query) {
    return { results: [] };
  }
  const files = await getAllowedMarkdownFiles(plugin);
  const results: SearchResult[] = [];
  for (const file of files) {
    const content = await plugin.app.vault.cachedRead(file);
    const index = content.toLowerCase().indexOf(query.toLowerCase());
    if (index < 0) {
      continue;
    }
    const summary = await buildSummary(plugin, file);
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
  const file = await getAllowedFileByPath(plugin, body.path);
  if (!file) {
    await plugin.audit({ route, path: String(body.path ?? ""), allowed: false, reason: "denied_or_missing" });
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
  const file = await getAllowedFileByPath(plugin, body.path);
  if (!file) {
    await plugin.audit({ route, path: String(body.path ?? ""), allowed: false, reason: "denied_or_missing" });
    sendJson(response, 404, { error: "Allowed note not found." });
    return;
  }
  await plugin.audit({ route, path: file.path, allowed: true });
  sendJson(response, 200, await buildMetadata(plugin, file));
}

async function routeLinks(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord
): Promise<void> {
  const file = await getAllowedFileByPath(plugin, body.path);
  if (!file) {
    await plugin.audit({ route, path: String(body.path ?? ""), allowed: false, reason: "denied_or_missing" });
    sendJson(response, 404, { error: "Allowed note not found." });
    return;
  }
  const metadata = await buildMetadata(plugin, file);
  await plugin.audit({ route, path: file.path, allowed: true });
  sendJson(response, 200, {
    path: file.path,
    outlinks: metadata.outlinks,
    embeds: metadata.embeds,
    backlinks: metadata.backlinks
  });
}

async function getAllowedMarkdownFiles(plugin: ObsidianMcpPlugin): Promise<TFile[]> {
  const files = plugin.app.vault
    .getMarkdownFiles()
    .filter((file) => isAllowedFile(plugin, file))
    .sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function getAllowedFileByPath(plugin: ObsidianMcpPlugin, rawPath: unknown): Promise<TFile | null> {
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
  if (!abstract || !("extension" in abstract) || abstract.extension !== "md") {
    return null;
  }
  const file = abstract as TFile;
  return isAllowedFile(plugin, file) ? file : null;
}

function isAllowedFile(plugin: ObsidianMcpPlugin, file: TFile): boolean {
  const cache = plugin.app.metadataCache.getFileCache(file);
  const tags = extractCacheTags(cache);
  return isPathIncluded(file.path, tags, plugin.settings);
}

async function buildSummary(plugin: ObsidianMcpPlugin, file: TFile): Promise<VaultNoteSummary> {
  const metadata = await buildMetadata(plugin, file);
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
  const truncated = truncateText(content, maxBytes);
  const metadata = await buildMetadata(plugin, file, content);
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

async function buildMetadata(plugin: ObsidianMcpPlugin, file: TFile, content?: string): Promise<NoteMetadata> {
  const cache = plugin.app.metadataCache.getFileCache(file);
  const parsed = content ? parseMarkdown(file.path, content) : null;
  const cacheTags = extractCacheTags(cache);
  const frontmatter = (cache?.frontmatter as Record<string, never> | undefined) ?? parsed?.frontmatter ?? {};
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

function extractCacheTags(cache: CachedMetadata | null): string[] {
  const direct = cache?.tags?.map((tag) => tag.tag.replace(/^#/, "")) ?? [];
  const frontmatterTags = cache?.frontmatter?.tags;
  const fm = Array.isArray(frontmatterTags)
    ? frontmatterTags.filter((tag): tag is string => typeof tag === "string")
    : typeof frontmatterTags === "string"
      ? frontmatterTags.split(/[,\s]+/)
      : [];
  return Array.from(new Set([...direct, ...fm].map((tag) => tag.replace(/^#/, "").toLowerCase()).filter(Boolean))).sort();
}

function extractAliases(cache: CachedMetadata | null, parsedAliases: string[]): string[] {
  const aliases = cache?.frontmatter?.aliases ?? cache?.frontmatter?.alias;
  const cacheAliases = Array.isArray(aliases)
    ? aliases.filter((alias): alias is string => typeof alias === "string")
    : typeof aliases === "string"
      ? [aliases]
      : [];
  return Array.from(new Set([...cacheAliases, ...parsedAliases])).sort();
}

function extractOutlinks(cache: CachedMetadata | null, parsedLinks: string[]): string[] {
  const cacheLinks = cache?.links?.map((link) => link.link).filter(Boolean) ?? [];
  return Array.from(new Set([...cacheLinks, ...parsedLinks])).sort();
}

function extractEmbeds(cache: CachedMetadata | null, parsedEmbeds: string[]): string[] {
  const cacheEmbeds = cache?.embeds?.map((embed) => embed.link).filter(Boolean) ?? [];
  return Array.from(new Set([...cacheEmbeds, ...parsedEmbeds])).sort();
}

function extractBacklinks(plugin: ObsidianMcpPlugin, file: TFile): string[] {
  const resolvedLinks = plugin.app.metadataCache.resolvedLinks as Record<string, Record<string, number>>;
  return Object.entries(resolvedLinks)
    .filter(([source, targets]) => source !== file.path && targets[file.path] && isAllowedPathOnly(plugin, source))
    .map(([source]) => source)
    .sort();
}

function isAllowedPathOnly(plugin: ObsidianMcpPlugin, path: string): boolean {
  const abstract = plugin.app.vault.getAbstractFileByPath(path);
  if (!abstract || !("extension" in abstract) || abstract.extension !== "md") {
    return false;
  }
  return isAllowedFile(plugin, abstract as TFile);
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  return header === `Bearer ${token}`;
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > 64_000) {
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

function loadNodeHttp(): NodeHttp {
  const requireFn =
    (globalThis as unknown as { require?: (module: string) => unknown }).require ??
    (new Function("return require")() as (module: string) => unknown);
  return requireFn("http") as NodeHttp;
}
