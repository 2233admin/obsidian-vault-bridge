import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PORT_FILE = path.join(os.homedir(), ".obsidian-ws-port");

export function writePortFile(port: number, token: string, vaultPath: string): void {
  const data = JSON.stringify({
    port,
    token,
    pid: process.pid,
    vault: vaultPath,
    startedAt: new Date().toISOString(),
  });
  try {
    const tmp = PORT_FILE + ".tmp";
    fs.writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, PORT_FILE);
  } catch (e) {
    console.error("Vault Bridge: failed to write port file", e);
  }
}

export function deletePortFile(): void {
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {
    // file might not exist on crash recovery
  }
}

export function cleanStalePortFile(): void {
  try {
    const raw = fs.readFileSync(PORT_FILE, "utf-8");
    const info = JSON.parse(raw);
    const pid = info.pid as number;
    if (pid === process.pid) {
      fs.unlinkSync(PORT_FILE);
      return;
    }
    try {
      process.kill(pid, 0);
    } catch {
      // pid not alive -- stale file
      fs.unlinkSync(PORT_FILE);
    }
  } catch {
    // no file or corrupt JSON -- nothing to clean
  }
}
