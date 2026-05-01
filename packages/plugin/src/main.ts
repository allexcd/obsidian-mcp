import { Notice, Platform, Plugin } from "obsidian";
import type { BridgeAuditEntry } from "@obsidian-mcp/shared";
import { createBridgeServer, type BridgeServerHandle } from "./server.js";
import {
  DEFAULT_SETTINGS,
  ensureInstalledRuntimeFiles,
  ObsidianMcpSettingTab,
  type ObsidianMcpSettings
} from "./settings.js";

interface SecretStorageLike {
  getSecret(name: string): string | null | Promise<string | null>;
  setSecret(name: string, value: string): void | Promise<void>;
}

interface PersistedPluginData extends Partial<ObsidianMcpSettings> {
  auditLog?: BridgeAuditEntry[];
  fallbackToken?: string;
  installId?: string;
}

export default class ObsidianMcpPlugin extends Plugin {
  settings: ObsidianMcpSettings = { ...DEFAULT_SETTINGS };
  bridge: BridgeServerHandle | null = null;
  auditLog: BridgeAuditEntry[] = [];
  lastBridgeError: string | null = null;
  lastTokenError: string | null = null;
  private fallbackToken: string | null = null;
  private installId = "";
  private secretStorageFailed = false;

  get bridgeRunning(): boolean {
    return this.bridge !== null;
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ObsidianMcpSettingTab(this.app, this));

    this.addCommand({
      id: "restart-bridge",
      name: "Restart local MCP bridge",
      callback: () => {
        void this.restartBridge();
      }
    });

    if (!Platform.isDesktopApp) {
      new Notice("MCP Vault Bridge is desktop-only.");
      return;
    }

    try {
      await this.ensureToken();
    } catch (error) {
      console.error("Unable to initialize MCP bridge token", error);
      new Notice("MCP Vault Bridge could not access Obsidian SecretStorage.");
      return;
    }

    this.app.workspace.onLayoutReady(() => {
      ensureInstalledRuntimeFiles(this).catch((error: unknown) => {
        console.error("Unable to materialize MCP runtime files", error);
        new Notice("MCP Vault Bridge could not create local runtime files. Check plugin folder permissions.");
      });
      void this.startBridge();
    });
  }

  async onunload(): Promise<void> {
    await this.stopBridge();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as PersistedPluginData | null;
    const { auditLog, fallbackToken, installId, ...settings } = data ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.auditLog = Array.isArray(data?.auditLog) ? data.auditLog.slice(-100) : [];
    this.fallbackToken = typeof fallbackToken === "string" ? fallbackToken : null;
    this.installId = typeof installId === "string" && installId.length > 0 ? installId : generateInstallId();
    if (!installId) {
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData({
      ...this.settings,
      auditLog: this.auditLog.slice(-100),
      fallbackToken: this.fallbackToken,
      installId: this.installId
    });
  }

  async ensureToken(): Promise<string> {
    const storage = this.getSecretStorage();
    if (!storage) {
      return this.ensureFallbackToken();
    }
    try {
      const existing = await Promise.resolve(storage.getSecret(this.getTokenSecretName()));
      if (existing) {
        this.lastTokenError = null;
        return existing;
      }
      const token = generateToken();
      await Promise.resolve(storage.setSecret(this.getTokenSecretName(), token));
      this.lastTokenError = null;
      return token;
    } catch (error) {
      this.secretStorageFailed = true;
      this.lastTokenError = formatTokenError(error);
      console.error("Unable to access MCP Vault Bridge token in SecretStorage; using plugin data fallback", error);
      return this.ensureFallbackToken();
    }
  }

  async regenerateToken(): Promise<string> {
    const token = generateToken();
    const storage = this.getSecretStorage();
    if (storage && !this.secretStorageFailed) {
      try {
        await Promise.resolve(storage.setSecret(this.getTokenSecretName(), token));
        this.fallbackToken = null;
        this.lastTokenError = null;
        await this.restartBridge();
        return token;
      } catch (error) {
        this.secretStorageFailed = true;
        this.lastTokenError = formatTokenError(error);
        console.error("Unable to regenerate MCP Vault Bridge token in SecretStorage; using plugin data fallback", error);
      }
    }

    this.fallbackToken = token;
    await this.saveSettings();
    await this.restartBridge();
    return token;
  }

  getTokenStorageLabel(): string {
    return this.getSecretStorage() && !this.secretStorageFailed ? "Obsidian SecretStorage for this install" : "plugin data fallback";
  }

  async startBridge(): Promise<void> {
    if (!this.settings.bridgeEnabled || this.bridge) {
      return;
    }
    try {
      const token = await this.ensureToken();
      this.bridge = await createBridgeServer(this, token);
      this.lastBridgeError = null;
      new Notice(`MCP Vault Bridge listening on 127.0.0.1:${this.settings.port}.`);
    } catch (error) {
      this.bridge = null;
      this.lastBridgeError = formatBridgeError(error);
      console.error("Unable to start MCP bridge", error);
      new Notice(`MCP Vault Bridge could not start: ${this.lastBridgeError}`);
    }
  }

  async stopBridge(): Promise<void> {
    if (!this.bridge) {
      return;
    }
    const bridge = this.bridge;
    this.bridge = null;
    await bridge.close();
  }

  async restartBridge(): Promise<void> {
    await this.stopBridge();
    await this.startBridge();
  }

  async audit(entry: Omit<BridgeAuditEntry, "at">): Promise<void> {
    if (!this.settings.auditEnabled) {
      return;
    }
    this.auditLog.push({ at: new Date().toISOString(), ...entry });
    this.auditLog = this.auditLog.slice(-100);
    await this.saveSettings();
  }

  private getSecretStorage(): SecretStorageLike | null {
    const appWithSecrets = this.app as unknown as { secretStorage?: SecretStorageLike };
    return appWithSecrets.secretStorage ?? null;
  }

  private async ensureFallbackToken(): Promise<string> {
    if (this.fallbackToken) {
      return this.fallbackToken;
    }
    this.fallbackToken = generateToken();
    await this.saveSettings();
    return this.fallbackToken;
  }

  private getTokenSecretName(): string {
    return `${normalizeSecretId(this.settings.tokenSecretName)}-${this.installId}`;
  }
}

function generateInstallId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatBridgeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code);
    if (code === "EADDRINUSE") {
      return "Port is already in use. Change the loopback port in Advanced settings or stop the other process.";
    }
    if (code === "EACCES") {
      return "Permission denied while opening the loopback port. Try a different port above 1024.";
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function formatTokenError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSecretId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "obsidian-mcp-bridge-token";
}
