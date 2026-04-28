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

export interface BridgeStatus {
  ok: true;
  vaultName: string;
  pluginVersion: string;
  bridgeVersion: string;
  readOnly: true;
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
  content: string;
  truncated: boolean;
  metadata: NoteMetadata;
}

export interface SearchResult {
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
