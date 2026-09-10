export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface VaultScopeConfig {
  excludedFolders: string[];
  excludedFiles: string[];
  excludedTags: string[];
}

export interface VaultScopePreview {
  detectedFolders: string[];
  detectedFiles: string[];
  detectedTags: string[];
  includedNoteCount: number;
  excludedNoteCount: number;
}

export interface BridgeSync {
  epoch: string;
  revision: number;
  policyRevision: string;
  reset: boolean;
  paths: string[];
  allowedPaths: string[];
  refreshRequest: number;
}

export interface AdapterReport {
  at: string;
  indexing: boolean;
  lastError: string | null;
  lastSyncedAt?: string | null;
  pending?: number;
  searchState?: string;
  embeddingError?: string | null;
}

export interface BridgeStatus {
  policyRevision?: string;
  search?: { enabled: boolean; baseUrl: string; model: string };
  toolProfile?: "full" | "compact";
  adapterReport?: AdapterReport | null;
  ok: true;
  vaultName: string;
  pluginVersion: string;
  bridgeVersion: string;
  readOnly: boolean;
  writeToolsEnabled: boolean;
  autoPruneEmbeddings: boolean;
  pluginDirectory: {
    vaultPath: string;
    filesystemPath: string | null;
    defaultDatabasePath: string | null;
  };
  scope: VaultScopeConfig;
  vaultPreview: VaultScopePreview;
  includedNoteCount: number;
  maxNoteBytes: number;
  auditEnabled: boolean;
}

export interface NoteMetadata {
  path: string;
  title: string;
  basename: string;
  extension: string;
  stat: {
    ctime: number;
    mtime: number;
    size: number;
  };
  frontmatter: Record<string, JsonValue>;
  tags: string[];
  aliases: string[];
  outlinks: string[];
  embeds: string[];
  backlinks: string[];
}

export interface VaultNoteSummary {
  path: string;
  title: string;
  mtime: number;
  size: number;
  tags: string[];
  aliases: string[];
  frontmatter: Record<string, JsonValue>;
}

export interface VaultNote extends VaultNoteSummary {
  revision?: string;
  content: string;
  truncated: boolean;
  metadata: NoteMetadata;
}

export interface SearchResult {
  heading?: string | null;
  startLine?: number;
  endLine?: number;
  revision?: string;
  truncated?: boolean;
  evidence?: "direct" | "linked";
  passages?: Array<{ heading: string | null; text: string }>;
  path: string;
  title: string;
  score: number;
  snippet: string;
  tags: string[];
  mtime: number;
}

export interface MarkdownChunk {
  path: string;
  index: number;
  heading: string | null;
  content: string;
}

export interface BridgeListResponse {
  notes: VaultNoteSummary[];
  nextOffset: number | null;
}

export interface BridgeExportResponse {
  notes: VaultNote[];
  nextOffset: number | null;
}

export interface BridgeAuditEntry {
  at: string;
  route: string;
  path?: string;
  allowed: boolean;
  reason?: string;
}

export interface WriteNoteResponse {
  operation: "create" | "append" | "replace" | "delete_text" | "rewrite" | "properties";
  note: VaultNote;
}

export interface PruneEmbeddingsResult {
  beforeCount: number;
  afterCount: number;
  orphanedBeforeCount: number;
  orphanedAfterCount: number;
  deletedEmbeddings: number;
  estimatedBytesFreed: number;
}

export interface CreateFolderResponse {
  operation: "create_folder";
  path: string;
  status: "created" | "already_exists";
  replayed?: boolean;
}
