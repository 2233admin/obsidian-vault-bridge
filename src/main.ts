import { Plugin } from "obsidian";
import { VaultBridgeSettings, DEFAULT_SETTINGS } from "./types";
import { VaultBridgeSettingTab, generateToken } from "./settings";
import { VaultBridge } from "./bridge";
import { WsServer } from "./server";
import { registerHandlers } from "./handlers";
import { registerVaultEvents } from "./events";
import { writePortFile, deletePortFile, cleanStalePortFile } from "./port-file";
import { getVaultBasePath } from "./fs-helpers";

export default class VaultBridgePlugin extends Plugin {
  settings: VaultBridgeSettings = { ...DEFAULT_SETTINGS };
  private server: WsServer | null = null;
  private actualPort: number = 0;

  async onload(): Promise<void> {
    const saved = await this.loadData();
    if (saved) this.settings = { ...DEFAULT_SETTINGS, ...saved };

    if (!this.settings.token) {
      this.settings.token = generateToken();
      await this.saveData(this.settings);
    }

    this.addSettingTab(new VaultBridgeSettingTab(this.app, this));

    cleanStalePortFile();

    this.app.workspace.onLayoutReady(() => this.startServer());

    console.log("LLM Wiki: plugin loaded");
  }

  onunload(): void {
    this.server?.stop();
    this.server = null;
    deletePortFile();
    this.actualPort = 0;
    console.log("LLM Wiki: plugin unloaded");
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  isServerRunning(): boolean {
    return this.server?.isRunning() ?? false;
  }

  getServerPort(): number {
    return this.actualPort;
  }

  private startServer(): void {
    const bridge = new VaultBridge(this.app);
    this.server = new WsServer(
      { port: this.settings.port, token: this.settings.token },
      (resolvedPort) => {
        this.actualPort = resolvedPort;
        writePortFile(
          resolvedPort,
          this.settings.token,
          getVaultBasePath(this.app) ?? "",
        );
        console.log("LLM Wiki: server ready on port " + resolvedPort);
      },
    );
    registerHandlers(this.server, bridge, this.settings);
    for (const ref of registerVaultEvents(this.app, this.server)) {
      this.registerEvent(ref);
    }
    this.server.start();
  }
}
