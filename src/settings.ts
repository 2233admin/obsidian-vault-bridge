import { App, PluginSettingTab, Setting } from "obsidian";
import type VaultBridgePlugin from "./main";
import { getVaultBasePath } from "./fs-helpers";

export function generateToken(): string {
  return require("crypto").randomBytes(32).toString("hex");
}

export class VaultBridgeSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VaultBridgePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // -- Header --
    containerEl.createEl("p", {
      text: "Connect AI agents (Claude Code, Cursor, Windsurf) to this vault via MCP.",
      cls: "setting-item-description",
    });

    // -- Status --
    const running = this.plugin.isServerRunning();
    const port = this.plugin.getServerPort();
    const statusSetting = new Setting(containerEl)
      .setName("Server Status")
      .setDesc(running ? `Running on port ${port}` : "Not running");
    if (running) {
      statusSetting.descEl.style.color = "var(--text-success)";
    }

    // -- MCP Config Copy --
    if (running) {
      const vaultPath = (getVaultBasePath(this.app) ?? "/path/to/vault").replace(/\\/g, "/");
      const mcpConfig = JSON.stringify({
        mcpServers: {
          "llm-wiki": {
            command: "node",
            args: ["<path-to>/connector.js", vaultPath],
          },
        },
      }, null, 2);

      new Setting(containerEl)
        .setName("MCP Config")
        .setDesc("Copy this to ~/.claude/settings.json or .cursor/mcp.json")
        .addButton((btn) =>
          btn.setButtonText("Copy to clipboard").onClick(() => {
            navigator.clipboard.writeText(mcpConfig);
            btn.setButtonText("Copied!");
            setTimeout(() => btn.setButtonText("Copy to clipboard"), 2000);
          }),
        );
    }

    // -- Port --
    new Setting(containerEl)
      .setName("WebSocket Port")
      .setDesc("Default: 48765. Requires plugin reload to take effect.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.port)).onChange(async (val) => {
          const n = parseInt(val, 10);
          if (n >= 1 && n <= 65535) {
            this.plugin.settings.port = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    // -- Token --
    new Setting(containerEl)
      .setName("Auth Token")
      .setDesc("Auto-generated. Shared via ~/.obsidian-ws-port discovery file.")
      .addText((text) => text.setValue(this.plugin.settings.token).setDisabled(true))
      .addButton((btn) =>
        btn.setButtonText("Regenerate").onClick(async () => {
          this.plugin.settings.token = generateToken();
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    // -- Dry-run --
    new Setting(containerEl)
      .setName("Dry-run by default")
      .setDesc("Write operations require explicit dryRun: false to execute.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.dryRunDefault).onChange(async (v) => {
          this.plugin.settings.dryRunDefault = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
