import {
  App,
  FileSystemAdapter,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  TFile,
  type ButtonComponent
} from "obsidian";
import {
  DEFAULT_MAX_NOTE_BYTES,
  isHiddenOrConfigPath,
  isPathIncluded,
  normalizeFolder,
  normalizeTag,
  normalizeVaultPath,
  parseDelimitedList,
  type VaultScopePreview
} from "@obsidian-mcp/shared";
import type ObsidianMcpPlugin from "./main.js";
import { materializeRuntimeFiles } from "./runtime-files.js";

export interface ObsidianMcpSettings {
  bridgeEnabled: boolean;
  port: number;
  excludedFolders: string[];
  excludedFiles: string[];
  excludedTags: string[];
  maxNoteBytes: number;
  auditEnabled: boolean;
  tokenSecretName: string;
  nodeCommandOverride: string;
  npmCommandOverride: string;
}

export const DEFAULT_SETTINGS: ObsidianMcpSettings = {
  bridgeEnabled: true,
  port: 27125,
  excludedFolders: [],
  excludedFiles: [],
  excludedTags: [],
  maxNoteBytes: DEFAULT_MAX_NOTE_BYTES,
  auditEnabled: true,
  tokenSecretName: "obsidian-mcp-bridge-token",
  nodeCommandOverride: "",
  npmCommandOverride: ""
};

const SEARCH_RESULT_LIMIT = 40;
const GITHUB_REPO_URL = "https://github.com/allexcd/obsidian-mcp";

type ExclusionKind = "folder" | "file" | "tag";
type StatusTone = "good" | "warning" | "neutral";
type SettingsTabId = "setup" | "vault" | "clients" | "advanced";

interface RuntimeStatus {
  pluginDirectory: string | null;
  mcpServerPath: string | null;
  sqliteRuntimePath: string | null;
  mcpServerPresent: boolean;
  sqliteRuntimePresent: boolean;
  runtimeFilesError?: string;
  nodeCommand?: CommandStatus;
  npmCommand?: CommandStatus;
}

interface CommandStatus {
  ok: boolean;
  detail: string;
  command?: string;
  source?: "direct" | "shell" | "override";
  envPath?: string;
  stdout?: string;
  stderr?: string;
}

interface NodeFsPromises {
  access(path: string): Promise<void>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void>;
}

interface NodePath {
  join(...paths: string[]): string;
}

interface ExecFileOptions {
  cwd?: string;
  timeout?: number;
  encoding?: BufferEncoding;
  windowsHide?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface ChildProcess {
  execFile(
    command: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: NodeJS.ErrnoException | null, stdout: string | Buffer, stderr: string | Buffer) => void
  ): void;
}

interface ScopeSummary {
  label: string;
  kind: ExclusionKind;
  total: number;
  excluded: number;
  description: string;
  refreshable: boolean;
}

interface SetupRowHandle {
  rowEl: HTMLElement;
  badgeEl: HTMLElement;
  detailEl: HTMLElement;
  actionsEl: HTMLElement;
}

export class ObsidianMcpSettingTab extends PluginSettingTab {
  private activeTab: SettingsTabId = "setup";

  constructor(app: App, private readonly plugin: ObsidianMcpPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("obsidian-mcp-settings");

    const preview = buildVaultScopePreview(this.plugin);
    renderHeader(containerEl);
    this.renderTabs(containerEl);

    switch (this.activeTab) {
      case "setup":
        this.renderSetup(containerEl, preview);
        break;
      case "vault":
        this.renderVaultScope(containerEl, preview);
        break;
      case "clients":
        this.renderClientSetup(containerEl);
        break;
      case "advanced":
        this.renderAdvanced(containerEl);
        break;
    }

    renderSettingsFooter(containerEl);
  }

  private renderTabs(containerEl: HTMLElement): void {
    const tabs = containerEl.createDiv({ cls: "obsidian-mcp-tabs" });
    const items: Array<{ id: SettingsTabId; label: string }> = [
      { id: "setup", label: "Setup" },
      { id: "vault", label: "Vault access" },
      { id: "clients", label: "MCP clients" },
      { id: "advanced", label: "Advanced" }
    ];

    for (const item of items) {
      const tab = tabs.createEl("button", {
        text: item.label,
        cls: item.id === this.activeTab ? "obsidian-mcp-tab is-active" : "obsidian-mcp-tab"
      });
      tab.setAttr("type", "button");
      tab.setAttr("aria-pressed", String(item.id === this.activeTab));
      tab.onClickEvent(() => {
        this.activeTab = item.id;
        this.display();
      });
    }
  }

  private renderSetup(containerEl: HTMLElement, preview: VaultScopePreview): void {
    const section = createSection(containerEl, "Setup", "Follow these steps to connect Claude Desktop or LM Studio.");
    const rows = section.createDiv({ cls: "obsidian-mcp-setup-table" });

    const runtimeRow = createSetupRow(rows, 1, "Runtime", "Checking", "neutral", "Looking for mcp-server.cjs and SQLite runtime.");
    addSetupButton(runtimeRow.actionsEl, "Check runtime", "search", async (button) => {
      await withBusyButton(button, "Checking", "Check runtime", async () => {
        const status = await getRuntimeStatus(this.plugin, true);
        updateRuntimeSetupRow(runtimeRow, status);
        new Notice(runtimeSummary(status));
      });
    });
    addSetupButton(runtimeRow.actionsEl, "Install SQLite", "download", async (button) => {
      await withBusyButton(button, "Installing", "Install SQLite", async () => {
        try {
          await installRuntimeDependencies(this.plugin);
          const status = await getRuntimeStatus(this.plugin, true);
          updateRuntimeSetupRow(runtimeRow, status);
          new Notice("SQLite runtime dependencies installed.");
        } catch (error) {
          console.error("Unable to install MCP runtime dependencies", error);
          const status = await getRuntimeStatus(this.plugin, true);
          updateRuntimeSetupRow(runtimeRow, status);
          new Notice("Could not install SQLite runtime. Check Node.js, npm, network access, and the developer console.");
        }
      });
    });
    void getRuntimeStatus(this.plugin, false).then((status) => updateRuntimeSetupRow(runtimeRow, status));

    const bridgeStatus = this.plugin.bridgeRunning
      ? "Running"
      : this.plugin.settings.bridgeEnabled
        ? "Stopped"
        : "Disabled";
    const bridgeDetail = this.plugin.bridgeRunning
      ? `Listening at http://127.0.0.1:${this.plugin.settings.port}.`
      : this.plugin.lastBridgeError
        ? this.plugin.lastBridgeError
        : this.plugin.settings.bridgeEnabled
          ? "The bridge is enabled but currently stopped."
          : "The bridge is disabled in Advanced settings.";
    const bridgeAction = this.plugin.bridgeRunning
      ? "Restart bridge"
      : this.plugin.settings.bridgeEnabled
        ? "Start bridge"
        : "Enable bridge";
    const bridgeRow = createSetupRow(
      rows,
      2,
      "Bridge",
      bridgeStatus,
      this.plugin.bridgeRunning ? "good" : "warning",
      bridgeDetail
    );
    addSetupButton(bridgeRow.actionsEl, bridgeAction, "refresh-cw", async (button) => {
      await withBusyButton(button, "Starting", bridgeAction, async () => {
        if (!this.plugin.settings.bridgeEnabled) {
          this.plugin.settings.bridgeEnabled = true;
          await this.plugin.saveSettings();
        }
        await this.plugin.restartBridge();
        new Notice(
          this.plugin.bridgeRunning
            ? "MCP bridge is running."
            : `MCP bridge is stopped${this.plugin.lastBridgeError ? `: ${this.plugin.lastBridgeError}` : "."}`
        );
        this.display();
      });
    });

    const tokenRow = createSetupRow(
      rows,
      3,
      "Token",
      "Checking",
      "neutral",
      "Copy token reuses this install's token; it only creates one if none exists yet."
    );
    addSetupButton(tokenRow.actionsEl, "Copy token", "key-round", async (button) => {
      try {
        const token = await this.plugin.ensureToken();
        await copyText(token);
        updateSetupRow(tokenRow, "Ready", "good", `${tokenFingerprint(token)} in ${this.plugin.getTokenStorageLabel()}. Not regenerated.`);
        await flashButton(button, "Copied", "Copy token");
        new Notice("MCP bridge token copied. It was not regenerated.");
      } catch (error) {
        console.error("Unable to copy MCP token", error);
        new Notice("Could not copy MCP bridge token.");
      }
    });
    addSetupButton(tokenRow.actionsEl, "Regenerate", "rotate-cw", async (button) => {
      try {
        const token = await this.plugin.regenerateToken();
        updateSetupRow(tokenRow, "Ready", "good", `${tokenFingerprint(token)} in ${this.plugin.getTokenStorageLabel()}. Update every MCP host config.`);
        await flashButton(button, "Regenerated", "Regenerate");
        new Notice("MCP bridge token regenerated. Update MCP host configs.");
      } catch (error) {
        console.error("Unable to regenerate MCP token", error);
        new Notice("Could not regenerate MCP bridge token.");
      }
    });
    void this.plugin
      .ensureToken()
      .then((token) => {
        updateSetupRow(tokenRow, "Ready", "good", `${tokenFingerprint(token)} in ${this.plugin.getTokenStorageLabel()}. Copy token does not rotate it.`);
      })
      .catch((error) => {
        console.error("Unable to read MCP token", error);
        updateSetupRow(
          tokenRow,
          "Unavailable",
          "warning",
          this.plugin.lastTokenError ? `Token storage error: ${this.plugin.lastTokenError}` : "Check the developer console for details."
        );
      });

    const serverPath = getMcpServerPath(this.plugin);
    const clientRow = createSetupRow(
      rows,
      4,
      "Client config",
      serverPath ? "Ready" : "Missing",
      serverPath ? "good" : "warning",
      serverPath ? "Copy a JSON-safe config for your MCP client." : "Plugin folder unavailable in this vault adapter."
    );
    addSetupButton(clientRow.actionsEl, "Copy LM Studio", "copy", async (button) => {
      await this.copyClientConfig("lm-studio", button);
    });
    addSetupButton(clientRow.actionsEl, "Copy Claude", "copy", async (button) => {
      await this.copyClientConfig("claude", button);
    });

    const vaultRow = createSetupRow(
      rows,
      5,
      "Vault access",
      `${preview.includedNoteCount} included`,
      "good",
      `${preview.excludedNoteCount} excluded. Protected folders such as .obsidian, .trash, .git, and hidden paths are always denied.`
    );
    addSetupButton(vaultRow.actionsEl, "Folders", "folder", async () => {
      new ExclusionManagerModal(this.app, this.plugin, "folder", () => this.display()).open();
    });
    addSetupButton(vaultRow.actionsEl, "Tags", "tag", async () => {
      new ExclusionManagerModal(this.app, this.plugin, "tag", () => this.display()).open();
    });
    addSetupButton(vaultRow.actionsEl, "Files", "file", async () => {
      new ExclusionManagerModal(this.app, this.plugin, "file", () => this.display()).open();
    });
  }

  private renderVaultScope(containerEl: HTMLElement, preview: VaultScopePreview): void {
    const section = createSection(
      containerEl,
      "Vault access",
      "Regular Markdown notes are included by default. Use exclusions for private areas or notes that should never be sent to an MCP host."
    );

    const cards = section.createDiv({ cls: "obsidian-mcp-scope-grid" });
    const summaries: ScopeSummary[] = [
      {
        label: "Folders",
        kind: "folder",
        total: preview.detectedFolders.length,
        excluded: this.plugin.settings.excludedFolders.length,
        description: "Exclude whole areas like Private or Archive.",
        refreshable: true
      },
      {
        label: "Tags",
        kind: "tag",
        total: preview.detectedTags.length,
        excluded: this.plugin.settings.excludedTags.length,
        description: "Exclude any note carrying a sensitive tag.",
        refreshable: false
      },
      {
        label: "Files",
        kind: "file",
        total: preview.detectedFiles.length,
        excluded: this.plugin.settings.excludedFiles.length,
        description: "Exclude exact Markdown note paths.",
        refreshable: true
      }
    ];

    for (const summary of summaries) {
      this.renderScopeCard(cards, summary);
    }

    section.createEl("p", {
      text: `${preview.includedNoteCount} notes are currently exposed to MCP tools; ${preview.excludedNoteCount} are denied. Protected folders such as .obsidian, .trash, .git, and hidden paths are always denied.`,
      cls: "obsidian-mcp-muted obsidian-mcp-compact-note"
    });
  }

  private renderScopeCard(containerEl: HTMLElement, summary: ScopeSummary): void {
    const card = containerEl.createDiv({ cls: "obsidian-mcp-scope-card" });
    const header = card.createDiv({ cls: "obsidian-mcp-card-header" });
    header.createEl("h4", { text: summary.label });
    header.createSpan({ text: `${summary.total} detected`, cls: "obsidian-mcp-chip obsidian-mcp-chip-neutral" });
    card.createEl("p", { text: summary.description, cls: "obsidian-mcp-muted" });

    const countRow = card.createDiv({ cls: "obsidian-mcp-count-row" });
    countRow.createDiv({ text: String(summary.excluded), cls: "obsidian-mcp-count" });
    countRow.createSpan({ text: "excluded", cls: "obsidian-mcp-muted" });

    const controls = card.createDiv({ cls: "obsidian-mcp-inline-actions" });
    new Setting(controls)
      .setClass("obsidian-mcp-inline-setting")
      .addButton((button) => {
        button.setButtonText("Manage").onClick(() => {
          new ExclusionManagerModal(this.app, this.plugin, summary.kind, () => this.display()).open();
        });
      });

    if (summary.refreshable) {
      new Setting(controls)
        .setClass("obsidian-mcp-inline-setting")
        .addButton((button) => {
          button.setButtonText("Refresh").onClick(async () => {
            await flashButton(button, "Refreshed", "Refresh");
            new Notice(`${summary.label} refreshed from the active vault.`);
            this.display();
          });
        });
    }
  }

  private renderClientSetup(containerEl: HTMLElement): void {
    const section = createSection(
      containerEl,
      "MCP clients",
      "Claude Desktop and LM Studio launch the same local MCP server. Copy the config first, then copy the token into the placeholder."
    );

    const path = getMcpServerPath(this.plugin);
    const pathBlock = section.createDiv({ cls: "obsidian-mcp-path-block" });
    pathBlock.createEl("span", { text: "Server path", cls: "obsidian-mcp-label" });
    pathBlock.createEl("code", {
      text: path ?? "Plugin folder unavailable in this vault adapter.",
      cls: "obsidian-mcp-code"
    });

    new Setting(section)
      .setName("MCP server path")
      .setDesc("Use this exact absolute path as the first value in args.")
      .addButton((button) =>
        button
          .setButtonText("Copy path")
          .onClick(async () => {
            try {
              const serverPath = getMcpServerPath(this.plugin);
              if (!serverPath) {
                throw new Error("Plugin folder is not available through the filesystem adapter.");
              }
              await copyText(serverPath);
              await flashButton(button, "Copied", "Copy path");
              new Notice("MCP server path copied.");
            } catch (error) {
              console.error("Unable to copy MCP server path", error);
              new Notice("Could not copy MCP server path.");
            }
          })
      );

    const snippets = section.createDiv({ cls: "obsidian-mcp-config-actions" });
    createConfigPreview(snippets, "LM Studio mcp.json", buildClientConfig(this.plugin, "lm-studio"), async (button) => {
      await this.copyClientConfig("lm-studio", button);
    });
    createConfigPreview(snippets, "Claude Desktop", buildClientConfig(this.plugin, "claude"), async (button) => {
      await this.copyClientConfig("claude", button);
    });
  }

  private renderRuntimeDiagnostics(containerEl: HTMLElement): void {
    const details = containerEl.createEl("details", { cls: "obsidian-mcp-runtime-details" });
    details.createEl("summary", { text: "Runtime diagnostics" });
    details.createEl("p", {
      text: "Detailed runtime checks for troubleshooting Node.js, npm, mcp-server.cjs, and the SQLite runtime.",
      cls: "obsidian-mcp-muted"
    });

    const statusEl = details.createDiv({
      text: "Checking runtime...",
      cls: "obsidian-mcp-runtime-status obsidian-mcp-muted"
    });
    statusEl.setAttr("aria-live", "polite");

    const refreshRuntime = async (includeCommands: boolean): Promise<RuntimeStatus> => {
      statusEl.setText(includeCommands ? "Checking runtime and commands..." : "Checking runtime...");
      const status = await getRuntimeStatus(this.plugin, includeCommands);
      renderRuntimeStatus(statusEl, status);
      return status;
    };

    void refreshRuntime(false);

    new Setting(details)
      .setName("Runtime diagnostics")
      .setDesc("Checks mcp-server.cjs, the SQLite runtime, and whether node/npm are visible from Obsidian.")
      .addButton((button) =>
        button
          .setButtonText("Check runtime")
          .onClick(async () => {
            await withBusyButton(button, "Checking", "Check runtime", async () => {
              await refreshRuntime(true);
            });
          })
      )
      .addButton((button) =>
        button
          .setButtonText("Install SQLite runtime")
          .onClick(async () => {
            await withBusyButton(button, "Installing", "Install SQLite runtime", async () => {
              try {
                await installRuntimeDependencies(this.plugin);
                await refreshRuntime(true);
                new Notice("SQLite runtime dependencies installed.");
              } catch (error) {
                console.error("Unable to install MCP runtime dependencies", error);
                await refreshRuntime(true);
                new Notice("Could not install SQLite runtime. Check Node.js, npm, network access, and the developer console.");
              }
            });
          })
      );
  }

  private renderAdvanced(containerEl: HTMLElement): void {
    const section = createSection(containerEl, "Advanced settings", "Connection, safety, and troubleshooting options.");

    new Setting(section)
      .setName("Enable local bridge")
      .setDesc("Starts a read-only HTTP bridge on 127.0.0.1 after Obsidian has loaded.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.bridgeEnabled).onChange(async (value) => {
          this.plugin.settings.bridgeEnabled = value;
          await this.plugin.saveSettings();
          await this.plugin.restartBridge();
          this.display();
        })
      );

    new Setting(section)
      .setName("Loopback port")
      .setDesc("The MCP adapter connects to this local port.")
      .addText((text) =>
        text
          .setPlaceholder("27125")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const port = Number(value);
            if (Number.isInteger(port) && port > 1024 && port < 65535) {
              this.plugin.settings.port = port;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(section)
      .setName("Maximum note bytes")
      .setDesc("Caps note content returned to the MCP adapter.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxNoteBytes)).onChange(async (value) => {
          const max = Number(value);
          if (Number.isInteger(max) && max >= 1024 && max <= 2_000_000) {
            this.plugin.settings.maxNoteBytes = max;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(section)
      .setName("Local audit log")
      .setDesc("Stores the last 100 bridge accesses in plugin data.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.auditEnabled).onChange(async (value) => {
          this.plugin.settings.auditEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(section)
      .setName("Node.js command override")
      .setDesc("Optional fallback when direct and shell-based detection cannot find Node.js. Leave empty unless Check runtime still fails.")
      .addText((text) =>
        text
          .setPlaceholder("/absolute/path/to/node")
          .setValue(this.plugin.settings.nodeCommandOverride)
          .onChange(async (value) => {
            this.plugin.settings.nodeCommandOverride = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(section)
      .setName("npm command override")
      .setDesc("Optional fallback when direct and shell-based detection cannot find npm. Leave empty unless Install SQLite runtime still fails.")
      .addText((text) =>
        text
          .setPlaceholder("/absolute/path/to/npm")
          .setValue(this.plugin.settings.npmCommandOverride)
          .onChange(async (value) => {
            this.plugin.settings.npmCommandOverride = value.trim();
            await this.plugin.saveSettings();
          })
      );

    this.renderRuntimeDiagnostics(section);
  }

  private async copyClientConfig(kind: "lm-studio" | "claude", button: ButtonComponent): Promise<void> {
    try {
      await copyText(buildClientConfig(this.plugin, kind));
      await flashButton(button, "Copied", kind === "lm-studio" ? "Copy LM Studio config" : "Copy Claude config");
      new Notice(kind === "lm-studio" ? "LM Studio MCP config copied." : "Claude Desktop MCP config copied.");
    } catch (error) {
      console.error("Unable to copy MCP client config", error);
      new Notice("Could not copy MCP client config.");
    }
  }
}

class ExclusionManagerModal extends Modal {
  private preview: VaultScopePreview;
  private query = "";
  private folderPrefix: string | null = null;

  constructor(
    app: App,
    private readonly plugin: ObsidianMcpPlugin,
    private readonly kind: ExclusionKind,
    private readonly onChanged: () => void
  ) {
    super(app);
    this.preview = buildVaultScopePreview(plugin);
  }

  onOpen(): void {
    this.modalEl.addClass("obsidian-mcp-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    this.onChanged();
  }

  private render(): void {
    this.contentEl.empty();
    this.titleEl.setText(`${kindLabel(this.kind)} exclusions`);

    this.contentEl.createEl("p", {
      text: managerDescription(this.kind),
      cls: "obsidian-mcp-muted"
    });

    this.renderExcludedChips();
    this.renderSearch();
    this.renderResults();
    this.renderManualEditor();
  }

  private renderExcludedChips(): void {
    const values = getExcludedValues(this.plugin, this.kind);
    const block = this.contentEl.createDiv({ cls: "obsidian-mcp-excluded-block" });
    block.createEl("h4", { text: `Excluded ${kindLabel(this.kind).toLowerCase()}` });

    const chips = block.createDiv({ cls: "obsidian-mcp-chip-list" });
    if (values.length === 0) {
      chips.createEl("span", { text: "Nothing excluded yet.", cls: "obsidian-mcp-muted" });
      return;
    }

    for (const value of values) {
      const chip = chips.createEl("button", {
        text: formatExclusion(this.kind, value),
        cls: "obsidian-mcp-removable-chip"
      });
      chip.setAttr("type", "button");
      chip.setAttr("aria-label", `Remove ${formatExclusion(this.kind, value)} from exclusions`);
      chip.onClickEvent(async () => {
        await removeExclusion(this.plugin, this.kind, value);
        this.render();
      });
    }
  }

  private renderSearch(): void {
    const searchWrap = this.contentEl.createDiv({ cls: "obsidian-mcp-manager-search" });
    const input = searchWrap.createEl("input", {
      value: this.query,
      cls: "obsidian-mcp-search-input"
    });
    input.setAttr("type", "search");
    input.setAttr("placeholder", searchPlaceholder(this.kind));
    input.addEventListener("input", () => {
      this.query = input.value;
      this.render();
      const nextInput = this.contentEl.querySelector<HTMLInputElement>(".obsidian-mcp-search-input");
      nextInput?.focus();
      nextInput?.setSelectionRange(nextInput.value.length, nextInput.value.length);
    });

    const refresh = searchWrap.createEl("button", { text: "Refresh", cls: "mod-cta" });
    refresh.setAttr("type", "button");
    refresh.onClickEvent(() => {
      this.preview = buildVaultScopePreview(this.plugin);
      new Notice(`${kindLabel(this.kind)} refreshed from the active vault.`);
      this.render();
    });
  }

  private renderResults(): void {
    const block = this.contentEl.createDiv({ cls: "obsidian-mcp-manager-results" });
    const candidates = this.getCandidates();
    const resultLabel = this.query.trim()
      ? `Showing ${candidates.length} matching ${kindLabel(this.kind).toLowerCase()}`
      : this.kind === "folder"
        ? "Browse top-level folders or search by path"
        : `Showing up to ${SEARCH_RESULT_LIMIT} ${kindLabel(this.kind).toLowerCase()}`;
    block.createEl("h4", { text: resultLabel });

    if (this.kind === "folder" && !this.query.trim()) {
      this.renderFolderBreadcrumb(block);
    }

    if (candidates.length === 0) {
      block.createEl("p", {
        text:
          this.kind === "file"
            ? "Search by exact note path to find files. For paths not currently detected, use Advanced manual edit below."
            : "No matches. Try a shorter search or refresh the vault preview.",
        cls: "obsidian-mcp-muted"
      });
      return;
    }

    for (const candidate of candidates) {
      this.renderCandidate(block, candidate);
    }

    const totalMatches = this.getTotalMatchCount();
    if (totalMatches > candidates.length) {
      block.createEl("p", {
        text: `${totalMatches - candidates.length} more matches hidden. Keep typing to narrow the list.`,
        cls: "obsidian-mcp-muted"
      });
    }
  }

  private renderFolderBreadcrumb(containerEl: HTMLElement): void {
    const row = containerEl.createDiv({ cls: "obsidian-mcp-breadcrumb" });
    const rootButton = row.createEl("button", { text: "Vault root" });
    rootButton.setAttr("type", "button");
    rootButton.disabled = this.folderPrefix === null;
    rootButton.onClickEvent(() => {
      this.folderPrefix = null;
      this.render();
    });

    if (!this.folderPrefix) {
      return;
    }

    row.createSpan({ text: this.folderPrefix, cls: "obsidian-mcp-code" });
    const parent = parentFolder(this.folderPrefix);
    const backButton = row.createEl("button", { text: "Back" });
    backButton.setAttr("type", "button");
    backButton.onClickEvent(() => {
      this.folderPrefix = parent;
      this.render();
    });
  }

  private renderCandidate(containerEl: HTMLElement, value: string): void {
    const row = containerEl.createDiv({ cls: "obsidian-mcp-result-row" });
    const info = row.createDiv({ cls: "obsidian-mcp-result-info" });
    info.createEl("code", { text: formatExclusion(this.kind, value), cls: "obsidian-mcp-code" });
    if (this.kind === "folder") {
      const childCount = immediateFolderChildren(this.preview.detectedFolders, value).length;
      if (childCount > 0) {
        info.createEl("span", { text: `${childCount} child folders`, cls: "obsidian-mcp-muted" });
      }
    }

    const controls = row.createDiv({ cls: "obsidian-mcp-result-actions" });
    if (this.kind === "folder" && !this.query.trim() && immediateFolderChildren(this.preview.detectedFolders, value).length > 0) {
      const openButton = controls.createEl("button", { text: "Open" });
      openButton.setAttr("type", "button");
      openButton.onClickEvent(() => {
        this.folderPrefix = value;
        this.render();
      });
    }

    const excluded = isExcluded(this.plugin, this.kind, value);
    const button = controls.createEl("button", { text: excluded ? "Include" : "Exclude" });
    button.setAttr("type", "button");
    button.toggleClass("mod-warning", excluded);
    button.onClickEvent(async () => {
      if (excluded) {
        await removeExclusion(this.plugin, this.kind, value);
      } else {
        await addExclusion(this.plugin, this.kind, value);
      }
      this.render();
    });
  }

  private renderManualEditor(): void {
    const details = this.contentEl.createEl("details", { cls: "obsidian-mcp-manual-edit" });
    details.createEl("summary", { text: "Advanced manual edit" });
    details.createEl("p", {
      text: "Paste one value per line or comma. Folder and file paths should be vault-relative.",
      cls: "obsidian-mcp-muted"
    });

    let draft = getExcludedValues(this.plugin, this.kind).map((value) => formatExclusion(this.kind, value)).join("\n");
    new Setting(details)
      .setName(`${kindLabel(this.kind)} list`)
      .addTextArea((textarea) => {
        textarea.setValue(draft).onChange((value) => {
          draft = value;
        });
        textarea.inputEl.rows = 7;
      });

    const controls = details.createDiv({ cls: "obsidian-mcp-inline-actions obsidian-mcp-manual-actions" });
    const applyButton = controls.createEl("button", { text: "Apply manual edits", cls: "mod-cta" });
    applyButton.setAttr("type", "button");
    applyButton.onClickEvent(async () => {
      setExcludedValues(this.plugin, this.kind, normalizeManualValues(this.kind, draft));
      await this.plugin.saveSettings();
      this.render();
      new Notice(`${kindLabel(this.kind)} exclusions updated.`);
    });
  }

  private getCandidates(): string[] {
    const query = this.query.trim().toLowerCase().replace(/^#/, "");
    const values = detectedValues(this.preview, this.kind);
    if (this.kind === "folder" && !query) {
      return immediateFolderChildren(values, this.folderPrefix).slice(0, SEARCH_RESULT_LIMIT);
    }
    if (!query) {
      return values.slice(0, SEARCH_RESULT_LIMIT);
    }
    return values.filter((value) => value.toLowerCase().includes(query)).slice(0, SEARCH_RESULT_LIMIT);
  }

  private getTotalMatchCount(): number {
    const query = this.query.trim().toLowerCase().replace(/^#/, "");
    const values = detectedValues(this.preview, this.kind);
    if (this.kind === "folder" && !query) {
      return immediateFolderChildren(values, this.folderPrefix).length;
    }
    if (!query) {
      return values.length;
    }
    return values.filter((value) => value.toLowerCase().includes(query)).length;
  }
}

export function buildVaultScopePreview(plugin: ObsidianMcpPlugin): VaultScopePreview {
  const folders = new Set<string>();
  const files: string[] = [];
  const tags = new Set<string>();
  let includedNoteCount = 0;
  let excludedNoteCount = 0;

  for (const file of plugin.app.vault.getMarkdownFiles().sort((left, right) => left.path.localeCompare(right.path))) {
    if (isHiddenOrConfigPath(file.path)) {
      continue;
    }

    files.push(file.path);
    for (const folder of foldersFromPath(file.path)) {
      folders.add(folder);
    }

    const noteTags = extractTags(plugin, file.path);
    for (const tag of noteTags) {
      tags.add(tag);
    }

    if (isPathIncluded(file.path, noteTags, plugin.settings)) {
      includedNoteCount += 1;
    } else {
      excludedNoteCount += 1;
    }
  }

  return {
    detectedFolders: Array.from(folders).sort(),
    detectedFiles: files,
    detectedTags: Array.from(tags).sort(),
    includedNoteCount,
    excludedNoteCount
  };
}

function renderHeader(containerEl: HTMLElement): void {
  const header = containerEl.createDiv({ cls: "obsidian-mcp-header" });
  header.createEl("h2", { text: "MCP Vault Bridge" });
  header.createEl("p", {
    text: "Expose your vault to local MCP clients through a read-only bridge. Returned note snippets can be sent to the model provider used by that client, so keep private areas excluded.",
    cls: "obsidian-mcp-muted"
  });
}

function renderSettingsFooter(containerEl: HTMLElement): void {
  const footer = containerEl.createDiv({ cls: "obsidian-mcp-footer" });
  footer.createSpan({ text: "Open source and built for local-first vault access." });

  const repoLink = footer.createEl("a", { text: "View GitHub repo", href: GITHUB_REPO_URL });
  repoLink.setAttr("target", "_blank");
  repoLink.setAttr("rel", "noopener noreferrer");

  const starLink = footer.createEl("a", { text: "Star on GitHub", href: `${GITHUB_REPO_URL}/stargazers` });
  starLink.setAttr("target", "_blank");
  starLink.setAttr("rel", "noopener noreferrer");
}

function createSection(containerEl: HTMLElement, title: string, description: string): HTMLElement {
  const section = containerEl.createDiv({ cls: "obsidian-mcp-section" });
  const heading = section.createDiv({ cls: "obsidian-mcp-section-heading" });
  heading.createEl("h3", { text: title });
  heading.createEl("p", { text: description, cls: "obsidian-mcp-muted" });
  return section;
}

function createSetupRow(
  containerEl: HTMLElement,
  step: number,
  title: string,
  badge: string,
  tone: StatusTone,
  detail: string
): SetupRowHandle {
  const rowEl = containerEl.createDiv({ cls: "obsidian-mcp-setup-row" });
  rowEl.createDiv({ text: String(step), cls: "obsidian-mcp-step-number" });
  const body = rowEl.createDiv({ cls: "obsidian-mcp-setup-body" });
  body.createEl("h4", { text: title });
  const detailEl = body.createEl("p", { text: detail, cls: "obsidian-mcp-muted" });
  const badgeEl = rowEl.createSpan({ text: badge, cls: `obsidian-mcp-chip obsidian-mcp-chip-${tone}` });
  const actionsEl = rowEl.createDiv({ cls: "obsidian-mcp-setup-actions" });
  return { rowEl, badgeEl, detailEl, actionsEl };
}

function updateSetupRow(row: SetupRowHandle, badge: string, tone: StatusTone, detail: string): void {
  row.badgeEl.setText(badge);
  row.badgeEl.className = `obsidian-mcp-chip obsidian-mcp-chip-${tone}`;
  row.detailEl.setText(detail);
}

function addSetupButton(
  containerEl: HTMLElement,
  label: string,
  icon: string,
  onClick: (button: ButtonComponent) => Promise<void>
): void {
  new Setting(containerEl)
    .setClass("obsidian-mcp-setup-action-setting")
    .addButton((button) => {
      button.setButtonText(label).setTooltip(label).onClick(() => onClick(button));
    });
}

function updateRuntimeSetupRow(row: SetupRowHandle, status: RuntimeStatus): void {
  const ready = status.mcpServerPresent && status.sqliteRuntimePresent;
  updateSetupRow(row, ready ? "Ready" : "Needs setup", ready ? "good" : "warning", runtimeSetupDetail(status));
}

function runtimeSetupDetail(status: RuntimeStatus): string {
  if (status.runtimeFilesError) {
    return `Could not create runtime files: ${status.runtimeFilesError}`;
  }
  const server = status.mcpServerPresent ? "mcp-server.cjs found" : "mcp-server.cjs missing";
  const sqlite = status.sqliteRuntimePresent ? "SQLite runtime found" : "SQLite runtime missing";
  const commands =
    status.nodeCommand || status.npmCommand
      ? ` Node: ${formatCommandStatus(status.nodeCommand)}. npm: ${formatCommandStatus(status.npmCommand)}.`
      : "";
  return `${server}; ${sqlite}.${commands}`;
}

function createConfigPreview(
  containerEl: HTMLElement,
  label: string,
  config: string,
  onCopy: (button: ButtonComponent) => Promise<void>
): void {
  const block = containerEl.createDiv({ cls: "obsidian-mcp-config-preview" });
  const header = block.createDiv({ cls: "obsidian-mcp-config-preview-header" });
  header.createEl("h4", { text: label });
  new Setting(header)
    .setClass("obsidian-mcp-inline-setting")
    .addButton((button) => {
      button.setButtonText("Copy config").onClick(() => onCopy(button));
    });
  block.createEl("pre").createEl("code", { text: config, cls: "obsidian-mcp-code" });
}

function renderRuntimeStatus(element: HTMLElement, status: RuntimeStatus): void {
  element.empty();
  if (!status.pluginDirectory) {
    element.createEl("p", {
      text: "Plugin folder unavailable. This plugin must run in the Obsidian desktop app with a filesystem vault.",
      cls: "obsidian-mcp-muted"
    });
    return;
  }

  renderStatusRow(element, "Plugin folder", status.pluginDirectory);
  if (status.runtimeFilesError) {
    renderStatusRow(element, "Runtime files", status.runtimeFilesError);
  }
  renderStatusRow(element, "MCP server", status.mcpServerPresent ? "found" : "missing");
  if (status.mcpServerPath) {
    renderStatusRow(element, "MCP path", status.mcpServerPath);
  }
  renderStatusRow(element, "SQLite runtime", status.sqliteRuntimePresent ? "found" : "missing");
  renderStatusRow(element, "node command", formatCommandStatus(status.nodeCommand));
  renderStatusRow(element, "npm command", formatCommandStatus(status.npmCommand));

  if (!status.mcpServerPresent || !status.sqliteRuntimePresent) {
    element.createEl("p", {
      text: "If SQLite runtime is missing, click Install SQLite runtime. If mcp-server.cjs is missing, click Check runtime to let the plugin repair local runtime files.",
      cls: "obsidian-mcp-muted"
    });
  }
}

function renderStatusRow(containerEl: HTMLElement, label: string, value: string): void {
  const row = containerEl.createEl("div", { cls: "obsidian-mcp-runtime-row" });
  row.createSpan({ text: `${label}: ` });
  row.createEl("code", { text: value, cls: "obsidian-mcp-code" });
}

function foldersFromPath(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  const folders: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) {
    folders.push(parts.slice(0, index).join("/"));
  }
  return folders.filter(Boolean);
}

function extractTags(plugin: ObsidianMcpPlugin, path: string): string[] {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    return [];
  }
  const cache = plugin.app.metadataCache.getFileCache(file);
  const direct = cache?.tags?.map((tag) => tag.tag.replace(/^#/, "").toLowerCase()) ?? [];
  const frontmatterTags = cache?.frontmatter?.tags;
  const fromFrontmatter = Array.isArray(frontmatterTags)
    ? frontmatterTags.filter((tag): tag is string => typeof tag === "string")
    : typeof frontmatterTags === "string"
      ? frontmatterTags.split(/[,\s]+/)
      : [];
  return Array.from(new Set([...direct, ...fromFrontmatter].map((tag) => tag.replace(/^#/, "").toLowerCase()).filter(Boolean)));
}

function buildClientConfig(plugin: ObsidianMcpPlugin, kind: "lm-studio" | "claude"): string {
  const mcpServerPath = getMcpServerPath(plugin) ?? "/ABSOLUTE/PATH/TO/Your Vault/.obsidian/plugins/mcp-vault-bridge/mcp-server.cjs";
  const baseConfig = {
    mcpServers: {
      "obsidian-vault": {
        command: plugin.settings.nodeCommandOverride.trim() || "node",
        args: [mcpServerPath],
        env: {
          OBSIDIAN_MCP_BRIDGE_URL: `http://127.0.0.1:${plugin.settings.port}`,
          OBSIDIAN_MCP_TOKEN: "PASTE_TOKEN_FROM_OBSIDIAN_PLUGIN"
        }
      }
    }
  };

  if (kind === "lm-studio") {
    return JSON.stringify(baseConfig, null, 2);
  }

  return JSON.stringify(baseConfig, null, 2);
}

function kindLabel(kind: ExclusionKind): string {
  switch (kind) {
    case "folder":
      return "Folders";
    case "file":
      return "Files";
    case "tag":
      return "Tags";
  }
}

function managerDescription(kind: ExclusionKind): string {
  switch (kind) {
    case "folder":
      return "Browse top-level folders, drill into child folders, or search by path. Excluding a folder denies every note inside it.";
    case "file":
      return "Search note paths and exclude exact Markdown files. This view never renders the whole vault at once.";
    case "tag":
      return "Search tags and exclude every note carrying that tag. Tags can be written with or without #.";
  }
}

function searchPlaceholder(kind: ExclusionKind): string {
  switch (kind) {
    case "folder":
      return "Search folders, for example Projects/Private";
    case "file":
      return "Search exact note paths, for example Inbox/Secret.md";
    case "tag":
      return "Search tags, for example private";
  }
}

function detectedValues(preview: VaultScopePreview, kind: ExclusionKind): string[] {
  switch (kind) {
    case "folder":
      return preview.detectedFolders;
    case "file":
      return preview.detectedFiles;
    case "tag":
      return preview.detectedTags;
  }
}

function getExcludedValues(plugin: ObsidianMcpPlugin, kind: ExclusionKind): string[] {
  switch (kind) {
    case "folder":
      return plugin.settings.excludedFolders;
    case "file":
      return plugin.settings.excludedFiles;
    case "tag":
      return plugin.settings.excludedTags;
  }
}

function setExcludedValues(plugin: ObsidianMcpPlugin, kind: ExclusionKind, values: string[]): void {
  switch (kind) {
    case "folder":
      plugin.settings.excludedFolders = values;
      return;
    case "file":
      plugin.settings.excludedFiles = values;
      return;
    case "tag":
      plugin.settings.excludedTags = values;
      return;
  }
}

function normalizeExclusion(kind: ExclusionKind, value: string): string {
  switch (kind) {
    case "folder":
      return normalizeFolder(value);
    case "file":
      return normalizeVaultPath(value);
    case "tag":
      return normalizeTag(value);
  }
}

function normalizeManualValues(kind: ExclusionKind, value: string): string[] {
  const values: string[] = [];
  for (const item of parseDelimitedList(value)) {
    try {
      const normalized = normalizeExclusion(kind, item);
      if (normalized && !values.includes(normalized)) {
        values.push(normalized);
      }
    } catch {
      // Invalid manual entries are ignored; detected values remain the safer path.
    }
  }
  return values;
}

async function addExclusion(plugin: ObsidianMcpPlugin, kind: ExclusionKind, value: string): Promise<void> {
  const normalized = tryNormalizeExclusion(kind, value);
  if (!normalized) {
    new Notice("Could not add that exclusion because the path or tag is invalid.");
    return;
  }
  const existing = getExcludedValues(plugin, kind)
    .map((item) => tryNormalizeExclusion(kind, item))
    .filter((item): item is string => item !== null);
  if (!existing.includes(normalized)) {
    setExcludedValues(plugin, kind, [...getExcludedValues(plugin, kind), normalized]);
    await plugin.saveSettings();
  }
}

async function removeExclusion(plugin: ObsidianMcpPlugin, kind: ExclusionKind, value: string): Promise<void> {
  const normalized = tryNormalizeExclusion(kind, value);
  if (!normalized) {
    setExcludedValues(
      plugin,
      kind,
      getExcludedValues(plugin, kind).filter((item) => item !== value)
    );
    await plugin.saveSettings();
    return;
  }
  setExcludedValues(
    plugin,
    kind,
    getExcludedValues(plugin, kind).filter((item) => tryNormalizeExclusion(kind, item) !== normalized)
  );
  await plugin.saveSettings();
}

function isExcluded(plugin: ObsidianMcpPlugin, kind: ExclusionKind, value: string): boolean {
  const normalized = tryNormalizeExclusion(kind, value);
  if (!normalized) {
    return false;
  }
  return getExcludedValues(plugin, kind).some((item) => tryNormalizeExclusion(kind, item) === normalized);
}

function formatExclusion(kind: ExclusionKind, value: string): string {
  return kind === "tag" ? `#${normalizeTag(value)}` : value;
}

function tryNormalizeExclusion(kind: ExclusionKind, value: string): string | null {
  try {
    const normalized = normalizeExclusion(kind, value);
    return normalized || null;
  } catch {
    return null;
  }
}

function immediateFolderChildren(folders: string[], prefix: string | null): string[] {
  const children = new Set<string>();
  const prefixWithSlash = prefix ? `${prefix}/` : "";

  for (const folder of folders) {
    if (prefix && !folder.startsWith(prefixWithSlash)) {
      continue;
    }
    const rest = prefix ? folder.slice(prefixWithSlash.length) : folder;
    if (!rest || rest.includes("/")) {
      const child = rest.split("/")[0];
      if (child) {
        children.add(prefix ? `${prefix}/${child}` : child);
      }
      continue;
    }
    children.add(prefix ? `${prefix}/${rest}` : rest);
  }

  return Array.from(children).sort();
}

function parentFolder(folder: string): string | null {
  const parts = folder.split("/");
  parts.pop();
  return parts.length > 0 ? parts.join("/") : null;
}

function tokenFingerprint(token: string): string {
  return `${"*".repeat(Math.max(0, Math.min(8, token.length - 8)))}${token.slice(-8)}`;
}

async function getRuntimeStatus(plugin: ObsidianMcpPlugin, includeCommands: boolean): Promise<RuntimeStatus> {
  const pluginDirectory = getPluginFilesystemDirectory(plugin);
  let runtimeFilesError: string | undefined;
  if (pluginDirectory) {
    try {
      await ensureInstalledRuntimeFiles(plugin);
    } catch (error) {
      runtimeFilesError = error instanceof Error ? error.message : String(error);
      console.error("Unable to materialize MCP runtime files", error);
    }
  }
  const mcpServerPath = getMcpServerPath(plugin);
  const sqliteRuntimePath = pluginDirectory
    ? joinFilesystemPath(pluginDirectory, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node")
    : null;

  const status: RuntimeStatus = {
    pluginDirectory,
    mcpServerPath,
    sqliteRuntimePath,
    mcpServerPresent: mcpServerPath ? await fileExists(mcpServerPath) : false,
    sqliteRuntimePresent: sqliteRuntimePath ? await fileExists(sqliteRuntimePath) : false,
    runtimeFilesError
  };

  if (includeCommands) {
    status.nodeCommand = await resolveRuntimeCommand(plugin, "node", ["--version"], plugin.settings.nodeCommandOverride);
    status.npmCommand = await resolveRuntimeCommand(plugin, "npm", ["--version"], plugin.settings.npmCommandOverride);
  }

  return status;
}

export async function ensureInstalledRuntimeFiles(plugin: ObsidianMcpPlugin): Promise<void> {
  const pluginDirectory = getPluginFilesystemDirectory(plugin);
  if (!pluginDirectory) {
    throw new Error("Plugin folder is not available through the filesystem adapter.");
  }

  const fs = loadNodeModule<NodeFsPromises>("fs/promises");
  const path = loadNodeModule<NodePath>("path");
  if (!fs || !path) {
    throw new Error("Node.js filesystem modules are not available inside Obsidian.");
  }

  await materializeRuntimeFiles(pluginDirectory, fs, path);
}

async function installRuntimeDependencies(plugin: ObsidianMcpPlugin): Promise<void> {
  const pluginDirectory = getPluginFilesystemDirectory(plugin);
  if (!pluginDirectory) {
    throw new Error("Plugin folder is not available through the filesystem adapter.");
  }

  const npmStatus = await resolveRuntimeCommand(plugin, "npm", ["--version"], plugin.settings.npmCommandOverride);
  if (!npmStatus.ok) {
    throw new Error(`npm is not available: ${npmStatus.detail}`);
  }

  await ensureInstalledRuntimeFiles(plugin);
  const result = await execFileAsync(
    npmStatus.command ?? "npm",
    ["install", "--omit=dev", "--no-audit", "--fund=false", "--package-lock=false"],
    {
      cwd: pluginDirectory,
      env: npmStatus.envPath ? { ...process.env, PATH: npmStatus.envPath } : process.env,
      timeout: 300_000
    }
  );
  if (!result.ok) {
    throw new Error(result.detail);
  }
}

function getPluginFilesystemDirectory(plugin: ObsidianMcpPlugin): string | null {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    return null;
  }

  const pluginVaultPath = plugin.manifest.dir ?? `.obsidian/plugins/${plugin.manifest.id}`;
  return joinFilesystemPath(adapter.getBasePath(), pluginVaultPath);
}

function getMcpServerPath(plugin: ObsidianMcpPlugin): string | null {
  const pluginDirectory = getPluginFilesystemDirectory(plugin);
  return pluginDirectory ? joinFilesystemPath(pluginDirectory, "mcp-server.cjs") : null;
}

function joinFilesystemPath(...parts: string[]): string {
  const path = loadNodeModule<NodePath>("path");
  if (path) {
    return path.join(...parts);
  }
  return parts.join("/");
}

async function fileExists(path: string): Promise<boolean> {
  const fs = loadNodeModule<NodeFsPromises>("fs/promises");
  if (!fs) {
    return false;
  }
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveRuntimeCommand(
  plugin: ObsidianMcpPlugin,
  command: "node" | "npm",
  args: readonly string[],
  overrideCommand: string
): Promise<CommandStatus> {
  const direct = await execFileAsync(command, args, { timeout: 5_000 });
  if (direct.ok) {
    return {
      ...direct,
      command,
      source: "direct",
      detail: `found directly: ${direct.detail}`
    };
  }

  const shell = await resolveCommandThroughShell(command, args);
  if (shell.ok) {
    return shell;
  }

  const override = overrideCommand.trim();
  if (override) {
    const overrideStatus = await execFileAsync(override, args, { timeout: 5_000 });
    if (overrideStatus.ok) {
      return {
        ...overrideStatus,
        command: override,
        source: "override",
        detail: `found via override: ${override} (${overrideStatus.detail})`
      };
    }
    return {
      ok: false,
      detail: `${command} direct lookup failed (${direct.detail}); shell lookup failed (${shell.detail}); override failed (${overrideStatus.detail}).`
    };
  }

  const overrideHint =
    command === "node"
      ? "Set a Node.js command override in Advanced settings if needed."
      : "Set an npm command override in Advanced settings if needed.";
  return {
    ok: false,
    detail: `${command} direct lookup failed (${direct.detail}); shell lookup failed (${shell.detail}). ${overrideHint}`,
    command: plugin.settings[command === "node" ? "nodeCommandOverride" : "npmCommandOverride"] || undefined
  };
}

async function resolveCommandThroughShell(command: "node" | "npm", args: readonly string[]): Promise<CommandStatus> {
  if (process.platform === "win32") {
    return { ok: false, detail: "shell lookup is only used on macOS/Linux." };
  }

  const shell = process.env.SHELL?.trim() || "/bin/zsh";
  const commandMarker = "__OBSIDIAN_MCP_COMMAND__=";
  const pathMarker = "__OBSIDIAN_MCP_PATH__=";
  const script = [
    `command_name=${shellQuote(command)}`,
    `shell_name="$(basename "$SHELL" 2>/dev/null || basename ${shellQuote(shell)})"`,
    `case "$shell_name" in`,
    `  zsh)`,
    `    [ -r "$HOME/.zshenv" ] && . "$HOME/.zshenv" >/dev/null 2>&1`,
    `    [ -r "$HOME/.zprofile" ] && . "$HOME/.zprofile" >/dev/null 2>&1`,
    `    [ -r "$HOME/.zshrc" ] && . "$HOME/.zshrc" >/dev/null 2>&1`,
    `    [ -r "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1`,
    `    ;;`,
    `  bash)`,
    `    [ -r "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" >/dev/null 2>&1`,
    `    [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1`,
    `    [ -r "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1`,
    `    ;;`,
    `  *)`,
    `    [ -r "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1`,
    `    [ -r "$HOME/.zprofile" ] && . "$HOME/.zprofile" >/dev/null 2>&1`,
    `    [ -r "$HOME/.zshrc" ] && . "$HOME/.zshrc" >/dev/null 2>&1`,
    `    [ -r "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" >/dev/null 2>&1`,
    `    [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1`,
    `    ;;`,
    `esac`,
    `resolved="$(command -v "$command_name" 2>/dev/null || true)"`,
    `if [ -z "$resolved" ]; then`,
    `  printf '%s\\n' "${command} was not found after loading shell profiles."`,
    `  exit 127`,
    `fi`,
    `printf '%s%s\\n' ${shellQuote(commandMarker)} "$resolved"`,
    `printf '%s%s\\n' ${shellQuote(pathMarker)} "$PATH"`,
    `"$resolved" ${args.map(shellQuote).join(" ")}`
  ].join("\n");

  const result = await execFileAsync(shell, ["-lc", script], { timeout: 10_000 });
  if (!result.ok) {
    return { ok: false, detail: result.detail };
  }

  const lines = (result.stdout ?? "").split(/\r?\n/);
  const resolved = lines.find((line) => line.startsWith(commandMarker))?.slice(commandMarker.length).trim();
  const envPath = lines.find((line) => line.startsWith(pathMarker))?.slice(pathMarker.length);
  const version = lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(commandMarker) && !line.startsWith(pathMarker))
    .pop();

  if (!resolved) {
    return { ok: false, detail: `${command} shell lookup returned no command path.` };
  }

  return {
    ok: true,
    command: resolved,
    source: "shell",
    envPath,
    stdout: result.stdout,
    stderr: result.stderr,
    detail: `found via shell: ${resolved}${version ? ` (${version})` : ""}`
  };
}

async function execFileAsync(command: string, args: readonly string[], options: ExecFileOptions = {}): Promise<CommandStatus> {
  const childProcess = loadNodeModule<ChildProcess>("child_process");
  if (!childProcess) {
    return { ok: false, detail: "Node child_process is not available." };
  }

  return new Promise((resolve) => {
    childProcess.execFile(
      command,
      args,
      {
        ...options,
        encoding: "utf8",
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const stdoutText = String(stdout ?? "").trim();
        const stderrText = String(stderr ?? "").trim();
        if (!error) {
          resolve({ ok: true, detail: stdoutText || "ok", command, stdout: stdoutText, stderr: stderrText });
          return;
        }

        if (error.code === "ENOENT") {
          resolve({ ok: false, detail: `${command} was not found in PATH.`, command, stdout: stdoutText, stderr: stderrText });
          return;
        }

        resolve({
          ok: false,
          detail: stderrText || stdoutText || error.message,
          command,
          stdout: stdoutText,
          stderr: stderrText
        });
      }
    );
  });
}

function formatCommandStatus(status: CommandStatus | undefined): string {
  if (!status) {
    return "not checked";
  }
  return status.ok ? status.detail : `unavailable (${status.detail})`;
}

function runtimeSummary(status: RuntimeStatus): string {
  if (!status.pluginDirectory) {
    return "Plugin folder unavailable. Use Obsidian desktop with a filesystem vault.";
  }
  if (status.runtimeFilesError) {
    return "Could not create MCP runtime files. Check plugin folder permissions and the developer console.";
  }
  if (status.mcpServerPresent && status.sqliteRuntimePresent && status.nodeCommand?.ok && status.npmCommand?.ok) {
    return "Runtime is ready.";
  }
  if (!status.nodeCommand?.ok || !status.npmCommand?.ok) {
    return "Runtime check found missing Node.js or npm.";
  }
  if (!status.sqliteRuntimePresent) {
    return "SQLite runtime is missing. Click Install SQLite runtime.";
  }
  if (!status.mcpServerPresent) {
    return "mcp-server.cjs is missing. Click Check runtime to repair local runtime files.";
  }
  return "Runtime check complete.";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function withBusyButton(
  button: ButtonComponent,
  busyLabel: string,
  originalLabel: string,
  callback: () => Promise<void>
): Promise<void> {
  button.setButtonText(busyLabel);
  button.setDisabled(true);
  try {
    await callback();
  } finally {
    button.setDisabled(false);
    button.setButtonText(originalLabel);
  }
}

async function flashButton(button: { setButtonText(text: string): unknown }, label: string, original: string): Promise<void> {
  button.setButtonText(label);
  await new Promise((resolve) => window.setTimeout(resolve, 900));
  button.setButtonText(original);
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      console.warn("navigator.clipboard.writeText failed; trying Electron clipboard.", error);
    }
  }

  if (copyWithHiddenTextarea(text)) {
    return;
  }

  const requireFn = (globalThis as unknown as { require?: (module: string) => unknown }).require;
  if (requireFn) {
    const electron = requireFn("electron") as { clipboard?: { writeText(value: string): void } };
    if (electron.clipboard?.writeText) {
      electron.clipboard.writeText(text);
      return;
    }
  }

  throw new Error("No clipboard API is available.");
}

function copyWithHiddenTextarea(text: string): boolean {
  const textarea = document.body.createEl("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.setAttr("readonly", "true");
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function loadNodeModule<T>(moduleName: string): T | null {
  try {
    const globalRequire = (globalThis as unknown as { require?: (module: string) => unknown }).require;
    const requireFn = globalRequire ?? (new Function("return require")() as (module: string) => unknown);
    return requireFn(moduleName) as T;
  } catch {
    return null;
  }
}
