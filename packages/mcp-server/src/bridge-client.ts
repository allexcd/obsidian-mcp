import type {
  CreateFolderResponse,
  BridgeSync,
  AdapterReport,
  BaseFileInput,
  BaseFileWriteResponse,
  BridgeExportResponse,
  BridgeListResponse,
  BridgeStatus,
  NoteMetadata,
  SearchResult,
  VaultNote,
  WriteNoteResponse
} from "@obsidian-mcp/shared";
import { requestJson } from "./http-json.js";

export class BridgeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`Obsidian bridge ${status}: ${message}`);
  }
}

export class BridgeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null
  ) {}

  async sync(epoch?: string, revision?: number): Promise<BridgeSync> {
    return this.request("/sync", { epoch, revision });
  }

  async authorize(paths: string[]): Promise<string[]> {
    const allowed: string[] = [];
    for (let offset = 0; offset < paths.length; offset += 500) {
      const result = await this.request<{ paths: string[] }>("/authorize", { paths: paths.slice(offset, offset + 500) });
      allowed.push(...result.paths);
    }
    return allowed;
  }

  async report(status: Omit<AdapterReport, "at">): Promise<void> {
    await this.request("/adapter/report", status);
  }

  async searchConfig(): Promise<{ enabled: boolean; baseUrl: string; model: string; apiKey: string }> {
    return this.request("/search/config", {});
  }

  async status(): Promise<BridgeStatus> {
    return this.request<BridgeStatus>("/status", {});
  }

  async listNotes(limit: number, offset: number): Promise<BridgeListResponse> {
    return this.request<BridgeListResponse>("/notes/list", { limit, offset });
  }

  async exportNotes(limit: number, offset: number): Promise<BridgeExportResponse> {
    return this.request<BridgeExportResponse>("/notes/export", { limit, offset });
  }

  async searchNotes(query: string, limit: number): Promise<{ results: SearchResult[] }> {
    return this.request<{ results: SearchResult[] }>("/notes/search", { query, limit });
  }

  async readNote(path: string, maxBytes?: number): Promise<VaultNote> {
    return this.request<VaultNote>("/notes/read", { path, maxBytes });
  }

  async metadata(path: string): Promise<NoteMetadata> {
    return this.request<NoteMetadata>("/notes/metadata", { path });
  }

  async links(path: string): Promise<{ path: string; outlinks: string[]; embeds: string[]; backlinks: string[] }> {
    return this.request<{ path: string; outlinks: string[]; embeds: string[]; backlinks: string[] }>("/notes/links", { path });
  }

  async createFolder(path: string, operationId?: string): Promise<CreateFolderResponse> {
    return this.request<CreateFolderResponse>("/folders/create", { path, operationId });
  }

  async createNote(path: string, content: string, overwrite: boolean, expectedRevision?: string, operationId?: string): Promise<WriteNoteResponse> {
    return this.request<WriteNoteResponse>("/notes/create", { path, content, overwrite, expectedRevision, operationId });
  }

  async createBaseFile(
    path: string | undefined,
    base: BaseFileInput,
    overwrite: boolean,
    createFolder: boolean,
    operationId?: string
  ): Promise<BaseFileWriteResponse> {
    return this.request<BaseFileWriteResponse>("/bases/create", { path, ...base, overwrite, createFolder, operationId });
  }

  async appendNote(path: string, content: string, expectedRevision?: string, operationId?: string): Promise<WriteNoteResponse> {
    return this.request<WriteNoteResponse>("/notes/append", { path, content, expectedRevision, operationId });
  }

  async replaceNoteText(path: string, oldText: string, newText: string, occurrenceIndex?: number, expectedRevision?: string, operationId?: string): Promise<WriteNoteResponse> {
    return this.request<WriteNoteResponse>("/notes/replace", { path, oldText, newText, occurrenceIndex, expectedRevision, operationId });
  }

  async deleteNoteText(path: string, text: string, occurrenceIndex?: number, expectedRevision?: string, operationId?: string): Promise<WriteNoteResponse> {
    return this.request<WriteNoteResponse>("/notes/delete-text", { path, text, occurrenceIndex, expectedRevision, operationId });
  }

  async rewriteNote(path: string, content: string, expectedRevision?: string, operationId?: string): Promise<WriteNoteResponse> {
    return this.request<WriteNoteResponse>("/notes/rewrite", { path, content, expectedRevision, operationId });
  }

  async setNoteProperties(path: string, properties: Record<string, unknown>, expectedRevision?: string, operationId?: string): Promise<WriteNoteResponse> {
    return this.request<WriteNoteResponse>("/notes/properties", { path, properties, expectedRevision, operationId });
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    if (!this.token) {
      throw new Error("OBSIDIAN_MCP_TOKEN is required. Copy it from the Obsidian plugin settings.");
    }
    const url = new URL(path, this.baseUrl);
    const response = await requestJson<{ error?: string; code?: string } & T>(url, {
      headers: {
        Authorization: `Bearer ${this.token}`
      },
      body
    });

    if (!response.ok) {
      const parsed = response.body;
      const message = typeof parsed === "object" && parsed && "error" in parsed ? String(parsed.error) : response.statusText;
      throw new BridgeError(response.status, response.body.code ?? "bridge_error", message);
    }
    return response.body;
  }
}
