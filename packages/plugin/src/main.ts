import { Notice, Platform, Plugin } from "obsidian";
import type { BridgeAuditEntry } from "@obsidian-mcp/shared";
import { createBridgeServer, type BridgeServerHandle } from "./server.js";
import { DEFAULT_SETTINGS, ObsidianMcpSettingTab, type ObsidianMcpSettings } from "./settings.js";

interface SecretStorageLike {
  getSecret(name: string): string | null | Promise<string | null>;
  setSecret(name: string, value: string): void | Promise<void>;
}

interface PersistedPluginData extends Partial<ObsidianMcpSettings> {
  auditLog?: BridgeAuditEntry[];
  fallbackToken?: string;
}

export default class ObsidianMcpPlugin extends Plugin {
  settings: ObsidianMcpSettings = { ...DEFAULT_SETTINGS };
  bridge: BridgeServerHandle | null = null;
  auditLog: BridgeAuditEntry[] = [];
  private fallbackToken: string | null = null;

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
      new Notice("Obsidian MCP is desktop-only.");
      return;
    }

    try {
      await this.ensureToken();
    } catch (error) {
      console.error("Unable to initialize MCP bridge token", error);
      new Notice("Obsidian MCP could not access Obsidian SecretStorage.");
      return;
    }

    this.app.workspace.onLayoutReady(() => {
      void this.startBridge();
    });
  }

  async onunload(): Promise<void> {
    await this.stopBridge();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as PersistedPluginData | null;
    const { auditLog, fallbackToken, ...settings } = data ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.auditLog = Array.isArray(data?.auditLog) ? data.auditLog.slice(-100) : [];
    this.fallbackToken = typeof fallbackToken === "string" ? fallbackToken : null;
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.settings, auditLog: this.auditLog.slice(-100), fallbackToken: this.fallbackToken });
  }

  async ensureToken(): Promise<string> {
    const storage = this.getSecretStorage();
    if (!storage) {
      return this.ensureFallbackToken();
    }
    const existing = await Promise.resolve(storage.getSecret(this.settings.tokenSecretName));
    if (existing) {
      return existing;
    }
    const token = generateToken();
    await Promise.resolve(storage.setSecret(this.settings.tokenSecretName, token));
    return token;
  }

  async regenerateToken(): Promise<string> {
    const token = generateToken();
    const storage = this.getSecretStorage();
    if (storage) {
      await Promise.resolve(storage.setSecret(this.settings.tokenSecretName, token));
      this.fallbackToken = null;
    } else {
      this.fallbackToken = token;
      await this.saveSettings();
    }
    await this.restartBridge();
    return token;
  }

  getTokenStorageLabel(): string {
    return this.getSecretStorage() ? "Obsidian SecretStorage" : "plugin data fallback";
  }

  async startBridge(): Promise<void> {
    if (!this.settings.bridgeEnabled || this.bridge) {
      return;
    }
    const token = await this.ensureToken();
    this.bridge = await createBridgeServer(this, token);
    new Notice(`Obsidian MCP listening on 127.0.0.1:${this.settings.port}.`);
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
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
