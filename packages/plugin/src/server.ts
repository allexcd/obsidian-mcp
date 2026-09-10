import { WriteRetries, type WriteReply } from "./write-retries.js";
import { BridgeSyncState, contentRevision } from "./sync.js";
import { FileSystemAdapter, TFile, TFolder, parseYaml, stringifyYaml } from "obsidian";
import {
  buildBaseFileContent,
  clampLimit,
  clampOffset,
  appendNoteContent,
  deleteExactText,
  isHiddenOrConfigPath,
  isPathIncluded,
  makeSnippet,
  NoteEditError,
  normalizeBasePath,
  normalizeTag,
  normalizeVaultPath,
  normalizeVaultScope,
  normalizeBaseScope,
  parseMarkdown,
  replaceExactText,
  resolveBasePath,
  titleFromPath,
  truncateText,
  type CreateFolderResponse,
  type BaseFileInput,
  type BaseFileWriteResponse,
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

const writeRetries = new WeakMap<ObsidianMcpPlugin, WriteRetries>();
const capturedReplies = new WeakMap<ServerResponse, (reply: WriteReply) => void>();
const writeRoutes: Record<string, (plugin: ObsidianMcpPlugin, response: ServerResponse, route: string, body: JsonRecord) => Promise<void>> = {
  "/folders/create": routeCreateFolder,
  "/notes/create": routeCreateNote, "/notes/append": routeAppendNote,
  "/notes/replace": routeReplaceNoteText, "/notes/delete-text": routeDeleteNoteText,
  "/notes/rewrite": routeRewriteNote, "/notes/properties": routeSetNoteProperties,
  "/bases/create": routeCreateBaseFile
};

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

  plugin.syncState ??= new BridgeSyncState();
  const write = writeRoutes[route];
  if (write) {
    let retries = writeRetries.get(plugin);
    if (!retries) { retries = new WriteRetries(); writeRetries.set(plugin, retries); }
    const reply = await retries.run(body.operationId, { route, body }, async previous => {
      if (!plugin.settings.writeToolsEnabled) return false;
      // Recheck both the current file and the historical response before replaying content.
      const saved = previous?.body as { path?: string; note?: VaultNote } | undefined;
      const path = saved?.note?.path ?? saved?.path ?? normalizeVaultPath(stringField(body.path));
      if (route === "/bases/create" || route === "/folders/create") return isWritableItemPathAllowed(plugin, path);
      const file = getAllowedFileByPath(plugin, path);
      return !!file && (!saved?.note || isContentAllowedAfterWrite(plugin, path, saved.note.content)) && isContentAllowedAfterWrite(plugin, path, await plugin.app.vault.read(file));
    }, async () => {
      let result: WriteReply | undefined;
      capturedReplies.set(response, value => { result = value; });
      try { await write(plugin, response, route, body); }
      finally { capturedReplies.delete(response); }
      return result ?? { status: 500, body: { code: "write_result_unknown", error: "Read the file to verify the outcome before making another edit." } };
    }, contentRevision(JSON.stringify(normalizeVaultScope(plugin.settings))));
    sendJson(response, reply.status, reply.body);
    return;
  }
  switch (route) {
    case "/sync": {
      const allowedPaths = getAllowedMarkdownFiles(plugin).map(file => file.path);
      sendJson(response, 200, {
        epoch: plugin.syncState.epoch, revision: plugin.syncState.revision,
        policyRevision: contentRevision(JSON.stringify(normalizeVaultScope(plugin.settings))),
        ...plugin.syncState.changes(body.epoch, body.revision), allowedPaths,
        refreshRequest: plugin.syncState.refreshRequest
      });
      return;
    }
    case "/authorize": {
      const paths = Array.isArray(body.paths) ? body.paths.filter((path): path is string => typeof path === "string").slice(0, 10000) : [];
      const allowed: string[] = [];
      for (const path of paths) {
        const file = getAllowedFileByPath(plugin, path);
        if (file && isContentAllowedAfterWrite(plugin, path, await plugin.app.vault.read(file))) allowed.push(path);
      }
      sendJson(response, 200, { paths: allowed });
      return;
    }
    case "/adapter/report":
      plugin.syncState.report = {
        at: new Date().toISOString(), indexing: body.indexing === true,
        lastError: typeof body.lastError === "string" ? body.lastError.slice(0, 500) : null,
        lastSyncedAt: typeof body.lastSyncedAt === "string" ? body.lastSyncedAt : null,
        pending: typeof body.pending === "number" ? body.pending : 0,
        searchState: typeof body.searchState === "string" ? body.searchState.slice(0, 100) : undefined,
        embeddingError: typeof body.embeddingError === "string" ? body.embeddingError.slice(0, 500) : null
      };
      sendJson(response, 200, { ok: true });
      return;
    case "/search/config":
      sendJson(response, 200, { ...buildStatus(plugin).search, apiKey: await plugin.getEmbeddingKey() });
      return;
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
    policyRevision: contentRevision(JSON.stringify(normalizeVaultScope(plugin.settings))),
    search: { enabled: plugin.settings.semanticEnabled, baseUrl: plugin.settings.embeddingBaseUrl, model: plugin.settings.embeddingModel },
    toolProfile: plugin.settings.toolProfile,
    adapterReport: plugin.syncState?.report ?? null,
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
  sendJson(response, 200, (await buildVaultNote(plugin, file)).metadata);
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
  const metadata = (await buildVaultNote(plugin, file)).metadata;
  await plugin.audit({ route, path: file.path, allowed: true });
  sendJson(response, 200, {
    path: file.path,
    outlinks: metadata.outlinks,
    embeds: metadata.embeds,
    backlinks: metadata.backlinks
  });
}

async function routeCreateFolder(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord
): Promise<void> {
  const rawPath = stringField(body.path);
  if (!(await ensureWritesEnabled(plugin, response, route, rawPath))) return;
  let path: string;
  try {
    if (/^[\\/]/.test(rawPath.trim())) throw new Error("Use a vault-relative path such as Books.");
    path = normalizeVaultPath(rawPath);
  } catch {
    await plugin.audit({ route, path: rawPath, allowed: false, reason: "invalid_path" });
    sendJson(response, 400, { code: "invalid_path", error: "Use a nonempty vault-relative folder path without traversal, such as Books or Books/Fiction." });
    return;
  }
  if (!isWritableItemPathAllowed(plugin, path)) {
    await plugin.audit({ route, path, allowed: false, reason: "scope_denied" });
    sendJson(response, 403, { code: "scope_denied", error: "This folder path is excluded or reserved." });
    return;
  }
  const existing = plugin.app.vault.getAbstractFileByPath(path);
  if (existing && !(existing instanceof TFolder)) {
    await plugin.audit({ route, path, allowed: false, reason: "path_exists" });
    sendJson(response, 409, { code: "path_exists", error: "A file already occupies this folder path." });
    return;
  }
  let created = false;
  if (!existing) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (parent && !(plugin.app.vault.getAbstractFileByPath(parent) instanceof TFolder)) {
      await plugin.audit({ route, path, allowed: false, reason: "parent_missing" });
      sendJson(response, 409, { code: "parent_missing", error: `Parent folder ${parent} is missing or occupied by a file. Create the parent folder first.` });
      return;
    }
    try { await plugin.app.vault.createFolder(path); created = true; }
    catch {
      // An Obsidian user may create the same folder while this request is running.
      if (!(plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder)) {
        await plugin.audit({ route, path, allowed: false, reason: "write_failed" });
        sendJson(response, 400, { code: "write_failed", error: "Could not create the folder. Check its path and vault filesystem permissions." });
        return;
      }
    }
  }
  await plugin.audit({ route, path, allowed: true });
  sendJson(response, 200, { operation: "create_folder", path, status: created ? "created" : "already_exists" } satisfies CreateFolderResponse);
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
  if (!isContentAllowedAfterWrite(plugin, path, content)) {
    await plugin.audit({ route, path, allowed: false, reason: "post_write_scope_denied" });
    sendJson(response, 403, { error: "Written note content would be excluded by the current vault scope." });
    return;
  }

  const existing = plugin.app.vault.getAbstractFileByPath(path);
  const overwrite = booleanField(body.overwrite);
  if (existing && !(existing instanceof TFile && existing.extension === "md" && overwrite && isAllowedFile(plugin, existing))) {
    await plugin.audit({ route, path, allowed: false, reason: "path_exists" });
    sendJson(response, 409, { error: "A vault item already exists at this path." });
    return;
  }

  if (existing instanceof TFile) {
    if (typeof body.expectedRevision !== "string" || !body.expectedRevision) {
      sendJson(response, 409, { code: "revision_required", error: "Overwriting an existing note requires expectedRevision from read_note. Prefer rewrite_note for replacement." });
      return;
    }
    await routeMutateExistingNote(plugin, response, route, body, "create", () => content);
    return;
  }
  try {
    const file = await plugin.app.vault.create(path, content);
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

async function routeSetNoteProperties(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord
): Promise<void> {
  const rawPath = stringField(body.path);
  if (!(await ensureWritesEnabled(plugin, response, route, rawPath))) {
    return;
  }

  const file = getAllowedFileByPath(plugin, body.path);
  if (!file) {
    await plugin.audit({ route, path: rawPath, allowed: false, reason: "denied_or_missing" });
    sendJson(response, 404, { error: "Writable note not found." });
    return;
  }

  const properties = jsonRecordField(body.properties);
  if (!properties) {
    await plugin.audit({ route, path: file.path, allowed: false, reason: "invalid_properties" });
    sendJson(response, 400, { error: "properties must be a JSON object." });
    return;
  }

  if (propertiesIntroduceExcludedTags(plugin, properties)) {
    await plugin.audit({ route, path: file.path, allowed: false, reason: "post_write_scope_denied" });
    sendJson(response, 403, { error: "Written note properties would be excluded by the current vault scope." });
    return;
  }

  await routeMutateExistingNote(plugin, response, route, body, "properties", existing => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(existing);
    let frontmatter: Record<string, unknown> = {};
    if (match) {
      try {
        const parsed: unknown = parseYaml(match[1] ?? "");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed as Record<string, unknown>;
      } catch { /* Repair malformed frontmatter with the supplied properties. */ }
    }
    const yaml = stringifyYaml({ ...frontmatter, ...properties }).trimEnd();
    return `---\n${yaml}\n---\n${match ? existing.slice(match[0].length) : existing}`;
  });
}

async function routeCreateBaseFile(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord
): Promise<void> {
  const rawPath = stringField(body.path);
  if (!(await ensureWritesEnabled(plugin, response, route, rawPath))) {
    return;
  }

  let path: string;
  let content: string;
  try {
    if (!body.scope) {
      await plugin.audit({ route, path: rawPath, allowed: false, reason: "missing_base_scope" });
      sendJson(response, 400, {
        error:
          "Base scope is required. Resolve the user's intended folder or files first, or pass { kind: \"vault\" } only when the user explicitly asks for the whole vault."
      });
      return;
    }
    const baseInput: BaseFileInput = {
      scope: body.scope as BaseFileInput["scope"],
      filters: baseFilterField(body.filters),
      excludePaths: stringArrayField(body.excludePaths),
      includeExtensions: stringArrayField(body.includeExtensions),
      excludeExtensions: stringArrayField(body.excludeExtensions),
      includeBaseFiles: booleanField(body.includeBaseFiles),
      properties: jsonRecordField(body.properties) ?? undefined,
      formulas: stringRecordField(body.formulas) ?? undefined,
      summaries: jsonRecordField(body.summaries) ?? undefined,
      views: Array.isArray(body.views) ? (body.views as BaseFileInput["views"]) : undefined
    };
    const createFolder = booleanField(body.createFolder);
    const requestedScope = baseInput.scope;
    baseInput.scope = resolveBaseInputScope(plugin, requestedScope, createFolder);
    path = resolveBaseWritePath(rawPath, requestedScope, baseInput.scope);
    if (!isWritableItemPathAllowed(plugin, path)) {
      await plugin.audit({ route, path, allowed: false, reason: "denied_or_invalid" });
      sendJson(response, 404, { error: "Writable base file path is not allowed." });
      return;
    }
    content = buildBaseFileContent(baseInput);
  } catch (error) {
    await plugin.audit({ route, path: rawPath, allowed: false, reason: "invalid_base" });
    sendJson(response, 400, { error: formatWriteError(error) });
    return;
  }

  if (!isContentWithinLimit(content, plugin.settings.maxNoteBytes)) {
    await plugin.audit({ route, path, allowed: false, reason: "content_too_large" });
    sendJson(response, 413, { error: `Content exceeds maximum note size of ${plugin.settings.maxNoteBytes} bytes.` });
    return;
  }

  const existing = plugin.app.vault.getAbstractFileByPath(path);
  const overwrite = booleanField(body.overwrite);
  if (existing && !(existing instanceof TFile && existing.extension === "base" && overwrite)) {
    await plugin.audit({ route, path, allowed: false, reason: "path_exists" });
    sendJson(response, 409, { error: "A vault item already exists at this path." });
    return;
  }

  try {
    const createdFolders = await ensureParentFolders(plugin, path, booleanField(body.createFolder));
    const file = existing instanceof TFile ? existing : await plugin.app.vault.create(path, content);
    if (existing instanceof TFile) {
      await plugin.app.vault.modify(file, content);
    }
    await plugin.audit({ route, path, allowed: true });
    sendJson(response, 200, {
      operation: "create_base",
      path,
      content,
      overwritten: existing instanceof TFile,
      createdFolders
    } satisfies BaseFileWriteResponse);
  } catch (error) {
    await plugin.audit({ route, path, allowed: false, reason: "write_failed" });
    sendJson(response, 400, { error: formatWriteError(error) });
  }
}

async function routeMutateExistingNote(
  plugin: ObsidianMcpPlugin,
  response: ServerResponse,
  route: string,
  body: JsonRecord,
  operation: WriteOperation,
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
    const next = await plugin.app.vault.process(file, existing => {
      if (body.expectedRevision !== undefined && body.expectedRevision !== contentRevision(existing)) {
        throw new NoteEditError("The note changed since it was read. Read it again before editing.", "revision_conflict");
      }
      if (!getAllowedFileByPath(plugin, file.path) || !isContentAllowedAfterWrite(plugin, file.path, existing)) {
        throw new NoteEditError("The note is no longer within the allowed scope.", "scope_denied");
      }
      const updated = edit(existing);
      if (!isContentWithinLimit(updated, plugin.settings.maxNoteBytes)) {
        throw new NoteEditError(`Content exceeds maximum note size of ${plugin.settings.maxNoteBytes} bytes.`, "content_too_large");
      }
      if (!isContentAllowedAfterWrite(plugin, file.path, updated)) {
        throw new NoteEditError("Written note content would be excluded by the current vault scope.", "scope_denied");
      }
      return updated;
    });
    await sendWriteResponse(plugin, response, route, operation, file, next);
  } catch (error) {
    await plugin.audit({ route, path: file.path, allowed: false, reason: error instanceof NoteEditError ? error.code : "write_failed" });
    sendJson(response, error instanceof NoteEditError ? (error.code === "revision_conflict" ? 409 : error.code === "scope_denied" ? 403 : error.code === "content_too_large" ? 413 : 400) : 500, { error: formatWriteError(error), code: error instanceof NoteEditError ? error.code : "write_failed" });
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
  plugin.syncState?.changed(file.path);
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

function isContentAllowedAfterWrite(plugin: ObsidianMcpPlugin, path: string, content: string): boolean {
  const parsed = parseMarkdown(path, content);
  return isPathIncluded(path, parsed.tags, plugin.settings);
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
  const content = await plugin.app.vault.read(file);
  if (!isContentAllowedAfterWrite(plugin, file.path, content)) throw new Error("Note is no longer allowed by the current vault scope.");
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
    revision: contentRevision(content),
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

function isWritableItemPathAllowed(plugin: ObsidianMcpPlugin, path: string): boolean {
  const normalized = normalizeVaultPath(path);
  if (isHiddenOrConfigPath(normalized)) {
    return false;
  }
  const configDir = normalizeVaultPath(plugin.app.vault.configDir);
  if (normalized === configDir || normalized.startsWith(`${configDir}/`)) return false;
  const scope = normalizeVaultScope(plugin.settings);
  if (scope.excludedFiles.some((file) => normalized === file)) {
    return false;
  }
  return !scope.excludedFolders.some((folder) => normalized === folder || normalized.startsWith(`${folder}/`));
}

function resolveBaseInputScope(plugin: ObsidianMcpPlugin, scope: BaseFileInput["scope"], createFolder: boolean): BaseFileInput["scope"] {
  const normalizedScope = normalizeBaseScope(scope);
  if (normalizedScope.kind !== "folder") {
    return normalizedScope;
  }

  const requested = normalizeVaultPath(normalizedScope.folder);
  const detectedFolders = buildVaultScopePreview(plugin).detectedFolders;
  if (detectedFolders.includes(requested)) {
    return { kind: "folder", folder: requested };
  }

  const matches = detectedFolders.filter((folder) => folder.split("/").pop()?.toLowerCase() === requested.toLowerCase());
  if (matches.length === 1) {
    return { kind: "folder", folder: matches[0]! };
  }

  if (matches.length > 1) {
    throw new Error(`Folder "${requested}" is ambiguous. Use one exact folder path: ${matches.join(", ")}.`);
  }

  if (createFolder) {
    return { kind: "folder", folder: requested };
  }

  const containing = detectedFolders.filter((folder) => folder.toLowerCase().includes(requested.toLowerCase())).slice(0, 5);
  const hint =
    containing.length > 0
      ? ` Did you mean one of these existing folders? ${containing.join(", ")}.`
      : " Resolve the folder with vault_status detectedFolders or list_notes, or set createFolder true only for a new folder.";
  throw new Error(`Folder "${requested}" was not found.${hint}`);
}

function resolveBaseWritePath(
  rawPath: string,
  requestedScope: BaseFileInput["scope"],
  resolvedScope: BaseFileInput["scope"]
): string {
  const trimmed = rawPath.trim();
  const resolved = normalizeBaseScope(resolvedScope);
  if (resolved.kind !== "folder") {
    return resolveBasePath(trimmed || undefined, resolved);
  }

  const defaultPath = resolveBasePath(undefined, resolved);
  if (!trimmed) {
    return defaultPath;
  }

  const requested = normalizeBaseScope(requestedScope);
  if (requested.kind !== "folder") {
    return resolveBasePath(trimmed, resolved);
  }

  const requestedFolder = normalizeVaultPath(requested.folder);
  const resolvedFolder = normalizeVaultPath(resolved.folder);
  const candidate = normalizeBasePath(trimmed);
  if (candidateFolder(candidate) === resolvedFolder) {
    return candidate;
  }

  const requestedName = requestedFolder.split("/").pop()?.toLowerCase();
  const resolvedName = resolvedFolder.split("/").pop()?.toLowerCase();
  const resolvedParent = candidateFolder(resolvedFolder);
  const candidateName = candidateBasename(candidate).toLowerCase();
  const candidateParent = candidateFolder(candidate);
  const candidateParentName = candidateParent.split("/").pop()?.toLowerCase();
  const candidateNameDerived = isNameDerivedFromFolder(candidateName, requestedName, resolvedName);
  const candidateParentNameDerived = isNameDerivedFromFolder(candidateParentName ?? "", requestedName, resolvedName);
  const looksDerivedFromUnresolvedFolder =
    candidateParent === requestedFolder ||
    (candidateParent === resolvedParent && candidateNameDerived) ||
    (!candidateParent && candidateNameDerived) ||
    (candidateParentNameDerived && candidateNameDerived);

  return looksDerivedFromUnresolvedFolder ? defaultPath : candidate;
}

function candidateFolder(path: string): string {
  const parts = normalizeVaultPath(path).split("/");
  parts.pop();
  return parts.join("/");
}

function candidateBasename(path: string): string {
  const filename = normalizeVaultPath(path).split("/").pop() ?? path;
  return filename.replace(/\.base$/i, "");
}

function isNameDerivedFromFolder(name: string, requestedName: string | undefined, resolvedName: string | undefined): boolean {
  const normalizedName = normalizeLooseName(name);
  const candidates = [requestedName, resolvedName].map((value) => normalizeLooseName(value ?? "")).filter(Boolean);
  return candidates.some(
    (candidate) =>
      normalizedName === candidate ||
      normalizedName.startsWith(`${candidate} `) ||
      normalizedName.endsWith(` ${candidate}`) ||
      normalizedName.includes(` ${candidate} `)
  );
}

function normalizeLooseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
  const capture = capturedReplies.get(response);
  if (capture) { capture({ status, body }); return; }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function jsonRecordField(value: unknown): Record<string, JsonValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isJsonValue(entry)) {
      record[key] = entry;
    }
  }
  return record;
}

function stringRecordField(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      record[key] = entry;
    }
  }
  return record;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string");
}

function baseFilterField(value: unknown): BaseFileInput["filters"] {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value) && isJsonValue(value)) {
    return value as BaseFileInput["filters"];
  }
  return undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function propertiesIntroduceExcludedTags(plugin: ObsidianMcpPlugin, properties: Record<string, JsonValue>): boolean {
  const excluded = new Set(normalizeVaultScope(plugin.settings).excludedTags.map((tag) => normalizeTag(tag)).filter(Boolean));
  if (excluded.size === 0) {
    return false;
  }
  const tags = [...stringList(properties.tags), ...stringList(properties.tag)].map((tag) => normalizeTag(tag)).filter(Boolean);
  return tags.some((tag) => excluded.has(tag));
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

async function ensureParentFolders(plugin: ObsidianMcpPlugin, path: string, createFolder: boolean): Promise<string[]> {
  const folders = parentFolders(path);
  const created: string[] = [];
  for (const folder of folders) {
    const existing = plugin.app.vault.getAbstractFileByPath(folder);
    if (existing instanceof TFolder) {
      continue;
    }
    if (existing) {
      throw new Error(`A vault item already exists at parent folder path ${folder}.`);
    }
    if (!createFolder) {
      throw new Error(`Parent folder ${folder} does not exist.`);
    }
    await plugin.app.vault.createFolder(folder);
    created.push(folder);
  }
  return created;
}

function parentFolders(path: string): string[] {
  const parts = normalizeVaultPath(path).split("/");
  parts.pop();
  const folders: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) {
    folders.push(parts.slice(0, index).join("/"));
  }
  return folders;
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
