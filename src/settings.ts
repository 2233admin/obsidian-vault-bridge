import { App, PluginSettingTab, Setting } from "obsidian";
import type VaultBridgePlugin from "./main";

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

    new Setting(containerEl)
      .setName("Dry-run by default")
      .setDesc("Write operations require explicit dryRun: false to execute.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.dryRunDefault).onChange(async (v) => {
          this.plugin.settings.dryRunDefault = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Server Status")
      .setDesc(
        this.plugin.isServerRunning()
          ? "Running on port " + this.plugin.getServerPort()
          : "Not running",
      );
  }
}
