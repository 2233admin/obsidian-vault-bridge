/**
 * Compile trigger -- dirty queue + auto-batch compilation.
 *
 * Tracks vault file changes (create/modify in raw/ paths).
 * When dirty count >= threshold, spawns compile.py as subprocess.
 * Also supports manual trigger via compile.run MCP method.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const exec = promisify(execFile);

export interface CompileTriggerConfig {
  /** Path to vault root */
  vaultPath: string;
  /** Path to compiler directory (where compile.py lives) */
  compilerPath: string;
  /** Python executable (default: "python") */
  python?: string;
  /** Dirty count threshold for auto-compile (default: 3) */
  threshold?: number;
  /** Model tier for LLM extraction (default: "haiku") */
  tier?: string;
  /** Auto-compile enabled (default: true) */
  autoCompile?: boolean;
}

export interface CompileStatus {
  dirty: string[];
  dirtyCount: number;
  threshold: number;
  running: boolean;
  lastRun: string | null;
  lastResult: CompileResult | null;
  autoCompile: boolean;
}

export interface CompileResult {
  ok: boolean;
  topic: string;
  sourcesCompiled: number;
  conceptsCreated: number;
  contradictions: number;
  error?: string;
  timestamp: string;
}

export class CompileTrigger {
  private dirty = new Set<string>();
  private running = false;
  private lastRun: string | null = null;
  private lastResult: CompileResult | null = null;

  private readonly vaultPath: string;
  private readonly compilerPath: string;
  private readonly python: string;
  private readonly threshold: number;
  private readonly tier: string;
  private readonly autoCompile: boolean;

  constructor(config: CompileTriggerConfig) {
    this.vaultPath = config.vaultPath;
    this.compilerPath = config.compilerPath;
    this.python = config.python ?? "python";
    this.threshold = config.threshold ?? 3;
    this.tier = config.tier ?? "haiku";
    this.autoCompile = config.autoCompile ?? true;
  }

  /**
   * Called when a vault file is created or modified.
   * Enqueues to dirty set; triggers auto-compile if threshold reached.
   */
  onFileChange(path: string, type: "create" | "modify"): void {
    // Only track raw/ or top-level md files (not wiki/ output)
    if (path.includes("/wiki/") || path.includes("\\wiki\\")) return;
    if (!path.endsWith(".md")) return;

    this.dirty.add(path);
    process.stderr.write(`vault-mind: [compile] dirty +1: ${path} (${this.dirty.size}/${this.threshold})\n`);

    if (this.autoCompile && this.dirty.size >= this.threshold && !this.running) {
      this.autoTrigger();
    }
  }

  /** Manual trigger for a specific topic. */
  async run(topic?: string): Promise<CompileResult> {
    if (this.running) {
      return {
        ok: false,
        topic: topic ?? "unknown",
        sourcesCompiled: 0,
        conceptsCreated: 0,
        contradictions: 0,
        error: "Compilation already running",
        timestamp: new Date().toISOString(),
      };
    }

    const targetTopic = topic ?? this.detectTopic();
    if (!targetTopic) {
      return {
        ok: false,
        topic: "",
        sourcesCompiled: 0,
        conceptsCreated: 0,
        contradictions: 0,
        error: "No topic specified and no dirty files to detect topic from",
        timestamp: new Date().toISOString(),
      };
    }

    return this.compile(targetTopic);
  }

  /** Get current status. */
  status(): CompileStatus {
    return {
      dirty: [...this.dirty],
      dirtyCount: this.dirty.size,
      threshold: this.threshold,
      running: this.running,
      lastRun: this.lastRun,
      lastResult: this.lastResult,
      autoCompile: this.autoCompile,
    };
  }

  /** Abort: just resets running flag (compile.py subprocess isn't killable cleanly). */
  abort(): { ok: boolean; message: string } {
    if (!this.running) return { ok: false, message: "No compilation running" };
    this.running = false;
    return { ok: true, message: "Compilation abort requested" };
  }

  // --- Internal ---

  private autoTrigger(): void {
    if (this.running) return;
    const topic = this.detectTopic();
    if (!topic) return;
    this.running = true; // claim lock synchronously before async work
    process.stderr.write(`vault-mind: [compile] auto-trigger for topic "${topic}" (${this.dirty.size} dirty)\n`);
    this.compile(topic).catch((e) => {
      this.running = false;
      process.stderr.write(`vault-mind: [compile] auto-trigger error: ${(e as Error).message}\n`);
    });
  }

  private detectTopic(): string | null {
    // Infer topic from the first dirty file's top-level directory
    for (const path of this.dirty) {
      const normalized = path.replace(/\\/g, "/");
      const parts = normalized.split("/");
      if (parts.length >= 2) return parts[0];
    }
    return null;
  }

  private async compile(topic: string): Promise<CompileResult> {
    this.running = true;
    const topicPath = resolve(this.vaultPath, topic);
    const compilePy = resolve(this.compilerPath, "compile.py");
    const args = [compilePy, topicPath, "--tier", this.tier];
    const timestamp = new Date().toISOString();

    try {
      const { stdout, stderr } = await exec(this.python, args, {
        timeout: 120_000, // 2 min max
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      });

      // Parse compile report from stdout
      const result = this.parseCompileOutput(topic, stdout, timestamp);

      if (stderr) {
        process.stderr.write(`vault-mind: [compile] stderr: ${stderr.slice(0, 500)}\n`);
      }

      // Clear dirty files for this topic
      for (const path of [...this.dirty]) {
        if (path.startsWith(topic + "/") || path.startsWith(topic + "\\")) {
          this.dirty.delete(path);
        }
      }

      this.lastRun = timestamp;
      this.lastResult = result;
      this.running = false;
      return result;
    } catch (e) {
      const result: CompileResult = {
        ok: false,
        topic,
        sourcesCompiled: 0,
        conceptsCreated: 0,
        contradictions: 0,
        error: (e as Error).message,
        timestamp,
      };
      this.lastRun = timestamp;
      this.lastResult = result;
      this.running = false;
      return result;
    }
  }

  private parseCompileOutput(topic: string, stdout: string, timestamp: string): CompileResult {
    // Parse the "=== Compilation Report ===" section from compile.py output
    const sources = this.extractNumber(stdout, "Sources compiled");
    const concepts = this.extractNumber(stdout, "Concepts created");
    const contradictions = this.extractNumber(stdout, "Contradictions");

    return {
      ok: true,
      topic,
      sourcesCompiled: sources,
      conceptsCreated: concepts,
      contradictions,
      timestamp,
    };
  }

  private extractNumber(text: string, label: string): number {
    const re = new RegExp(label + "\\s*:\\s*(\\d+)");
    const m = text.match(re);
    return m ? parseInt(m[1], 10) : 0;
  }
}
