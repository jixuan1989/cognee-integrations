import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  isPerAgentDataset,
  resolveConfig,
  resolveDatasetName,
  type CogneePluginConfig,
  type CogneeSearchType,
} from "./config.js";

// ---------------------------------------------------------------------------
// Types (config types live in config.ts to isolate env access from network code)
// ---------------------------------------------------------------------------

type CogneeAddResponse = {
  dataset_id: string;
  dataset_name: string;
  message: string;
  data_id?: unknown;
  data_ingestion_info?: unknown;
};

type CogneeSearchResult = {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
};

type CogneeSearchResponse = {
  results: CogneeSearchResult[];
};

type DatasetState = Record<string, string>;

type SyncIndex = {
  datasetId?: string;
  datasetName?: string;
  entries: Record<string, { hash: string; dataId?: string }>;
};

type MemoryFile = {
  /** Relative path from workspace root (e.g. "MEMORY.md", "memory/tools.md") */
  path: string;
  /** Absolute path on disk */
  absPath: string;
  /** File content */
  content: string;
  /** SHA-256 hex hash of content */
  hash: string;
};

type SyncResult = {
  added: number;
  updated: number;
  skipped: number;
  errors: number;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "http://localhost:8000";
const DEFAULT_DATASET_NAME = "openclaw";
const DEFAULT_SEARCH_TYPE: CogneeSearchType = "GRAPH_COMPLETION";
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0;
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_AUTO_RECALL = true;
const DEFAULT_AUTO_INDEX = true;
const DEFAULT_AUTO_COGNIFY = true;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const COGNEE_MEMORY_DIR = join(homedir(), ".openclaw", "memory", "cognee");
const STATE_PATH = join(COGNEE_MEMORY_DIR, "datasets.json");

function getSyncIndexPath(agentId: string | undefined): string {
  return agentId != null
    ? join(COGNEE_MEMORY_DIR, `sync-index-${agentId}.json`)
    : join(COGNEE_MEMORY_DIR, "sync-index.json");
}

/** Glob patterns for memory files, relative to workspace root. */
const MEMORY_FILE_PATTERNS = ["MEMORY.md", "memory.md", "memory"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// Persistence — dataset state & sync index
// ---------------------------------------------------------------------------

async function loadDatasetState(): Promise<DatasetState> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as DatasetState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function saveDatasetState(state: DatasetState): Promise<void> {
  await fs.mkdir(dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

async function loadSyncIndex(agentId: string | undefined): Promise<SyncIndex> {
  const path = getSyncIndexPath(agentId);
  try {
    const raw = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { entries: {} };
    }
    const record = parsed as SyncIndex;
    record.entries ??= {};
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: {} };
    }
    throw error;
  }
}

async function saveSyncIndex(state: SyncIndex, agentId: string | undefined): Promise<void> {
  const path = getSyncIndexPath(agentId);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

/** Extract agentId from hook/CLI context. Session key format: agent:<agentId>:... */
function getAgentIdFromCtx(ctx: { agentId?: string; sessionKey?: string; workspaceDir?: string }): string {
  if (ctx.agentId) return ctx.agentId;
  const sk = ctx.sessionKey;
  if (typeof sk === "string" && sk.startsWith("agent:")) {
    const parts = sk.split(":");
    if (parts.length >= 2) return parts[1];
  }
  const wd = ctx.workspaceDir;
  if (typeof wd === "string") {
    const base = basename(wd);
    if (base.startsWith("workspace-")) return base.slice("workspace-".length);
    const agentsMatch = wd.match(/[/\\]agents[/\\]([^/\\]+)([/\\]|$)/);
    if (agentsMatch) return agentsMatch[1];
  }
  return "main";
}

// ---------------------------------------------------------------------------
// File collection — scan workspace for memory markdown files
// ---------------------------------------------------------------------------

async function collectMemoryFiles(workspaceDir: string): Promise<MemoryFile[]> {
  const files: MemoryFile[] = [];

  for (const pattern of MEMORY_FILE_PATTERNS) {
    const target = resolve(workspaceDir, pattern);

    try {
      const stat = await fs.stat(target);

      if (stat.isFile() && target.endsWith(".md")) {
        const content = await fs.readFile(target, "utf-8");
        files.push({
          path: relative(workspaceDir, target),
          absPath: target,
          content,
          hash: hashText(content),
        });
      } else if (stat.isDirectory()) {
        // Recursively scan the memory/ directory for .md files
        const entries = await scanDir(target, workspaceDir);
        files.push(...entries);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      // File/dir doesn't exist — skip silently
    }
  }

  return files;
}

async function scanDir(dir: string, workspaceDir: string): Promise<MemoryFile[]> {
  const files: MemoryFile[] = [];

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const nested = await scanDir(absPath, workspaceDir);
      files.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const content = await fs.readFile(absPath, "utf-8");
      files.push({
        path: relative(workspaceDir, absPath),
        absPath,
        content,
        hash: hashText(content),
      });
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Cognee HTTP client
// ---------------------------------------------------------------------------

class CogneeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly timeoutMs: number = 30_000,
  ) {}

  private buildHeaders(): Record<string, string> {
    if (!this.apiKey) return {};
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "X-Api-Key": this.apiKey,
    };
  }

  private async fetchJson<T>(path: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cognee request failed (${response.status}): ${errorText}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async add(params: {
    data: string;
    datasetName: string;
    datasetId?: string;
    filename?: string;
  }): Promise<{ datasetId: string; datasetName: string; dataId?: string }> {
    const formData = new FormData();
    const filename = params.filename?.trim() || "openclaw-memory.txt";
    formData.append("data", new Blob([params.data], { type: "text/plain" }), filename);
    formData.append("datasetName", params.datasetName);
    if (params.datasetId) {
      formData.append("datasetId", params.datasetId);
    }

    const data = await this.fetchJson<CogneeAddResponse>("/api/v1/add", {
      method: "POST",
      headers: this.buildHeaders(),
      body: formData,
    });

    const dataId = this.extractDataId(data.data_id ?? data.data_ingestion_info);
    if (!dataId) {
      console.warn(
        "memory-cognee: add response missing data_id",
        JSON.stringify(
          {
            keys: Object.keys(data),
            data_id: data.data_id ?? null,
            data_ingestion_info: data.data_ingestion_info ?? null,
          },
          null,
          2,
        ),
      );
    }

    return {
      datasetId: data.dataset_id,
      datasetName: data.dataset_name,
      dataId,
    };
  }

  async update(params: {
    dataId: string;
    datasetId: string;
    data: string;
  }): Promise<{ datasetId: string; datasetName: string; dataId?: string }> {
    const query = new URLSearchParams({
      data_id: params.dataId,
      dataset_id: params.datasetId,
    });

    const formData = new FormData();
    formData.append("data", new Blob([params.data], { type: "text/plain" }), "openclaw-memory.txt");

    const data = await this.fetchJson<CogneeAddResponse>(`/api/v1/update?${query.toString()}`, {
      method: "PATCH",
      headers: this.buildHeaders(),
      body: formData,
    });

    return {
      datasetId: data.dataset_id,
      datasetName: data.dataset_name,
      dataId: this.extractDataId(data.data_id ?? data.data_ingestion_info),
    };
  }

  async cognify(params: { datasetIds?: string[] } = {}): Promise<{ status?: string }> {
    return this.fetchJson<{ status?: string }>("/api/v1/cognify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.buildHeaders(),
      },
      body: JSON.stringify({ datasets: params.datasetIds, runInBackground: true, chunksPerBatch: 10 }),
    });
  }

  async search(params: {
    queryText: string;
    searchType: CogneeSearchType;
    datasetIds: string[];
    maxTokens: number;
    maxResults?: number;
  }): Promise<CogneeSearchResult[]> {
    const data = await this.fetchJson<unknown>("/api/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.buildHeaders(),
      },
      body: JSON.stringify({
        query: params.queryText,
        searchType: params.searchType,
        datasetIds: params.datasetIds,
        topK: params.maxResults ?? 6,
        onlyContext: false,
        verbose: true,
      }),
    });

    return this.normalizeSearchResults(data);
  }

  /**
   * Normalize Cognee search response to consistent format.
   * Cognee returns a direct array of strings: ["answer text here"]
   * We convert to: [{ id, text, score }]
   */
  private normalizeSearchResults(data: unknown): CogneeSearchResult[] {
    // Handle direct array (Cognee's actual format)
    if (Array.isArray(data)) {
      return data.map((item, index) => {
        if (typeof item === "string") {
          return { id: `result-${index}`, text: item, score: 1 };
        }
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          return {
            id: typeof record.id === "string" ? record.id : `result-${index}`,
            text: typeof record.text === "string" ? record.text : JSON.stringify(record),
            score: typeof record.score === "number" ? record.score : 1,
            metadata: record.metadata as Record<string, unknown> | undefined,
          };
        }
        return { id: `result-${index}`, text: String(item), score: 1 };
      });
    }

    // Handle wrapped format { results: [...] }
    if (data && typeof data === "object" && "results" in data) {
      return this.normalizeSearchResults((data as { results: unknown }).results);
    }

    return [];
  }

  private extractDataId(value: unknown): string | undefined {
    if (!value) return undefined;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const id = this.extractDataId(entry);
        if (id) return id;
      }
      return undefined;
    }
    if (typeof value !== "object") return undefined;
    const record = value as { data_id?: unknown; data_ingestion_info?: unknown };
    if (typeof record.data_id === "string") return record.data_id;
    return this.extractDataId(record.data_ingestion_info);
  }
}

// ---------------------------------------------------------------------------
// Unified sync logic
//
// For each memory file:
//   - New file (no sync index entry)        → add + cognify
//   - Changed file with dataId              → update (no re-cognify)
//   - Changed file without dataId           → add + cognify
//   - Unchanged file                        → skip
//
// Matches clawdbot cognee-provider.ts syncFiles() (lines 422-513).
// ---------------------------------------------------------------------------

async function syncFiles(
  client: CogneeClient,
  files: MemoryFile[],
  syncIndex: SyncIndex,
  cfg: Required<CogneePluginConfig>,
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
  effectiveDatasetName: string,
  agentId: string | undefined,
): Promise<SyncResult & { datasetId?: string }> {
  const result: SyncResult = { added: 0, updated: 0, skipped: 0, errors: 0 };
  let datasetId = syncIndex.datasetId;
  let needsCognify = false;

  for (const file of files) {
    const existing = syncIndex.entries[file.path];

    // Skip unchanged files
    if (existing && existing.hash === file.hash) {
      result.skipped++;
      continue;
    }

    const dataWithMetadata = `# ${file.path}\n\n${file.content}\n\n---\nMetadata: ${JSON.stringify({ path: file.path, source: "memory" })}`;

    try {
      // Changed file with prior dataId → try update first
      if (existing?.dataId && datasetId) {
        try {
          await client.update({
            dataId: existing.dataId,
            datasetId,
            data: dataWithMetadata,
          });

          syncIndex.entries[file.path] = { hash: file.hash, dataId: existing.dataId };
          syncIndex.datasetId = datasetId;
          syncIndex.datasetName = effectiveDatasetName;
          result.updated++;

          logger.info?.(`memory-cognee: updated ${file.path}`);
          continue; // Success, move to next file
        } catch (updateError) {
          // If update fails (404/409 - document not found), fall back to add
          const errorMsg = updateError instanceof Error ? updateError.message : String(updateError);
          if (errorMsg.includes("404") || errorMsg.includes("409") || errorMsg.includes("not found")) {
            logger.info?.(`memory-cognee: update failed for ${file.path}, falling back to add`);
            // Clear the stale dataId and fall through to add
            delete existing.dataId;
          } else {
            throw updateError; // Re-throw other errors
          }
        }
      }

      // New file, or changed file without dataId, or update failed → add
      const safeFilename = file.path.replace(/[\\/]/g, "__") || "openclaw-memory.txt";
      const response = await client.add({
        data: dataWithMetadata,
        datasetName: effectiveDatasetName,
        datasetId,
        filename: safeFilename,
      });

      if (response.datasetId && response.datasetId !== datasetId) {
        datasetId = response.datasetId;

        // Persist dataset ID mapping (global state: all dataset names -> id)
        const state = await loadDatasetState();
        state[effectiveDatasetName] = response.datasetId;
        await saveDatasetState(state);
      }

      syncIndex.entries[file.path] = {
        hash: file.hash,
        dataId: response.dataId,
      };
      syncIndex.datasetId = datasetId;
      syncIndex.datasetName = effectiveDatasetName;
      needsCognify = true;
      result.added++;

      logger.info?.(`memory-cognee: added ${file.path}`);
    } catch (error) {
      result.errors++;
      logger.warn?.(`memory-cognee: failed to sync ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Cognify only after adds (not after updates — those are already processed)
  if (needsCognify && cfg.autoCognify && datasetId) {
    try {
      await client.cognify({ datasetIds: [datasetId] });
      logger.info?.("memory-cognee: cognify completed");
    } catch (error) {
      logger.warn?.(`memory-cognee: cognify failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Save sync index to disk (per-agent or legacy path)
  await saveSyncIndex(syncIndex, agentId);

  return { ...result, datasetId };
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

const memoryCogneePlugin = {
  id: "cognee-openclaw",
  name: "Memory (Cognee)",
  description: "Cognee-backed memory: indexes workspace memory files, auto-recalls before agent runs",
  kind: "memory" as const,
  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig);
    const client = new CogneeClient(cfg.baseUrl, cfg.apiKey, cfg.requestTimeoutMs);
    /** Global dataset name -> datasetId (persisted in datasets.json) */
    let datasetState: DatasetState = {};
    let resolvedWorkspaceDir: string | undefined;

    const stateReady = loadDatasetState()
      .then((state) => {
        datasetState = state;
      })
      .catch((error) => {
        api.logger.warn?.(`memory-cognee: failed to load dataset state: ${String(error)}`);
      });

    const perAgent = isPerAgentDataset(cfg.datasetName);

    async function runSync(
      workspaceDir: string,
      logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
      agentId?: string,
    ): Promise<SyncResult> {
      await stateReady;

      const effectiveAgentId = perAgent ? (agentId ?? "main") : undefined;
      const effectiveDatasetName = resolveDatasetName(cfg.datasetName, agentId ?? "main");

      const files = await collectMemoryFiles(workspaceDir);
      if (files.length === 0) {
        logger.info?.("memory-cognee: no memory files found");
        return { added: 0, updated: 0, skipped: 0, errors: 0 };
      }

      logger.info?.(`memory-cognee: found ${files.length} memory file(s), syncing...`);

      const syncIndex = await loadSyncIndex(effectiveAgentId);
      const result = await syncFiles(
        client,
        files,
        syncIndex,
        cfg,
        logger,
        effectiveDatasetName,
        effectiveAgentId,
      );
      if (result.datasetId) {
        datasetState[effectiveDatasetName] = result.datasetId;
      }

      return result;
    }

    function extractPathFromText(text: string): string {
      const match = text.match(/^Path:\s*(.+)$/m);
      if (match?.[1]) return match[1].trim();
      return "cognee-memory";
    }

    function buildCogneeSearchManager(agentId: string, workspaceDir: string) {
      const effectiveDatasetName = resolveDatasetName(cfg.datasetName, agentId);
      const effectiveAgentId = perAgent ? agentId : undefined;

      return {
        status() {
          return {
            backend: "builtin" as const,
            provider: "cognee-openclaw",
            model: cfg.searchType,
            workspaceDir,
            files: 0,
            chunks: 0,
            dirty: false,
            sources: ["memory" as const],
            extraPaths: [COGNEE_MEMORY_DIR],
          };
        },
        async probeEmbeddingAvailability() {
          try {
            const response = await fetch(`${cfg.baseUrl}/health`);
            if (!response.ok) {
              return { ok: false, error: `Cognee health check failed (${response.status})` };
            }
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
        async probeVectorAvailability() {
          try {
            const response = await fetch(`${cfg.baseUrl}/api/v1/datasets`, {
              headers: client["buildHeaders"](),
            });
            if (!response.ok) {
              return { ok: false, error: `Cognee datasets probe failed (${response.status})` };
            }
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
        async search(query: string, opts?: { maxResults?: number; signal?: AbortSignal }) {
          await stateReady;
          const privateId = datasetState[effectiveDatasetName];
          const sharedId = cfg.sharedDatasetName ? datasetState[cfg.sharedDatasetName] : undefined;
          const datasetIds = [privateId, sharedId].filter(Boolean) as string[];
          if (datasetIds.length === 0) return [];

          const results = await client.search({
            queryText: query,
            searchType: cfg.searchType,
            datasetIds,
            maxTokens: cfg.maxTokens,
            maxResults: opts?.maxResults ?? cfg.maxResults,
          });

          return results
            .filter((r) => r.score >= cfg.minScore)
            .slice(0, opts?.maxResults ?? cfg.maxResults)
            .map((r, index) => {
              const relPath = extractPathFromText(r.text);
              const lines = r.text.split(/\r?\n/);
              return {
                path: relPath,
                startLine: 1,
                endLine: Math.max(1, lines.length),
                snippet: r.text,
                score: r.score,
                source: "memory" as const,
                metadata: { id: r.id, ...(r.metadata ?? {}), rank: index + 1 },
              };
            });
        },
        async readFile(params: { relPath: string; from?: number; lines?: number }) {
          const absPath = resolve(workspaceDir, params.relPath);
          try {
            const content = await fs.readFile(absPath, "utf-8");
            const allLines = content.split(/\r?\n/);
            const from = Math.max(1, params.from ?? 1);
            const maxLines = Math.max(1, params.lines ?? allLines.length);
            const slice = allLines.slice(from - 1, from - 1 + maxLines);
            return {
              relPath: params.relPath,
              from,
              lines: slice.length,
              content: slice.join("\n"),
            };
          } catch {
            return null;
          }
        },
        async close() {
          return;
        },
      };
    }

    api.logger.info?.(`memory-cognee: registerMemoryRuntime available=${typeof (api as any).registerMemoryRuntime === "function"}`);
    (api as any).registerMemoryRuntime?.({
      getMemorySearchManager(params) {
        const ctxAgentId = params.agentId ?? getAgentIdFromCtx({
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
        });
        const ctxWorkspaceDir = params.workspaceDir || resolvedWorkspaceDir || process.cwd();
        return buildCogneeSearchManager(ctxAgentId, ctxWorkspaceDir);
      },
      resolveMemoryBackendConfig(params) {
        const slot = params.config?.plugins?.slots?.memory;
        const entry = params.config?.plugins?.entries?.["cognee-openclaw"];
        if (slot !== "cognee-openclaw" || entry?.enabled === false) {
          return null;
        }
        return {
          backend: "builtin" as const,
          provider: "cognee-openclaw",
          model: cfg.searchType,
          requestedProvider: "cognee-openclaw",
        };
      },
      async closeAllMemorySearchManagers() {
        return;
      },
    });

    // ------------------------------------------------------------------
    // CLI: openclaw cognee index / openclaw cognee status
    // ------------------------------------------------------------------

    api.registerCli((ctx) => {
      const cognee = ctx.program.command("cognee").description("Cognee memory management");
      const resolvedWorkspaceDir = ctx.workspaceDir || process.cwd();
      const cliAgentId = getAgentIdFromCtx(ctx);

      cognee
        .command("index")
        .description("Sync memory files to Cognee (add new, update changed, skip unchanged)")
        .option("--agent <id>", "Agent id (per-agent mode; default from context or main)", cliAgentId)
        .action(async (opts: { agent?: string }) => {
          const agentId = opts.agent ?? cliAgentId;
          const result = await runSync(resolvedWorkspaceDir, ctx.logger, agentId);
          const summary = `Sync complete: ${result.added} added, ${result.updated} updated, ${result.skipped} unchanged, ${result.errors} errors`;
          ctx.logger.info?.(summary);
          console.log(summary);
        });

      cognee
        .command("status")
        .description("Show Cognee sync state (files indexed, dataset info)")
        .option("--agent <id>", "Agent id (per-agent mode)", cliAgentId)
        .action(async (opts: { agent?: string }) => {
          await stateReady;

          const agentId = opts.agent ?? cliAgentId;
          const effectiveAgentId = perAgent ? agentId : undefined;
          const effectiveDatasetName = resolveDatasetName(cfg.datasetName, agentId);
          const syncIndex = await loadSyncIndex(effectiveAgentId);
          const datasetId = datasetState[effectiveDatasetName] ?? syncIndex.datasetId;

          const entryCount = Object.keys(syncIndex.entries).length;
          const entriesWithDataId = Object.values(syncIndex.entries).filter((e) => e.dataId).length;
          const files = await collectMemoryFiles(resolvedWorkspaceDir);

          let dirty = 0;
          let newCount = 0;
          for (const file of files) {
            const existing = syncIndex.entries[file.path];
            if (!existing) {
              newCount++;
            } else if (existing.hash !== file.hash) {
              dirty++;
            }
          }

          const lines = [
            perAgent ? `Agent: ${agentId}` : "",
            `Dataset: ${effectiveDatasetName}`,
            `Dataset ID: ${datasetId ?? "(not set)"}`,
            `Indexed files: ${entryCount} (${entriesWithDataId} with data ID)`,
            `Workspace files: ${files.length}`,
            `New (unindexed): ${newCount}`,
            `Changed (dirty): ${dirty}`,
            `Sync index: ${getSyncIndexPath(effectiveAgentId)}`,
          ].filter(Boolean);
          console.log(lines.join("\n"));
        });
    }, { commands: ["cognee"] });

    // ------------------------------------------------------------------
    // Auto-sync on startup
    // ------------------------------------------------------------------

    if (cfg.autoIndex) {
      api.registerService({
        id: "cognee-auto-sync",
        async start(ctx) {
          resolvedWorkspaceDir = ctx.workspaceDir || process.cwd();
          const agentId = getAgentIdFromCtx(ctx as { workspaceDir?: string; sessionKey?: string; agentId?: string });

          try {
            const result = await runSync(resolvedWorkspaceDir, ctx.logger, agentId);
            ctx.logger.info?.(
              `memory-cognee: auto-sync complete: ${result.added} added, ${result.updated} updated, ${result.skipped} unchanged`,
            );
          } catch (error) {
            ctx.logger.warn?.(`memory-cognee: auto-sync failed: ${String(error)}`);
          }
        },
      });
    }

    // ------------------------------------------------------------------
    // Auto-recall: inject memories before each agent run
    // ------------------------------------------------------------------

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        await stateReady;

        if (!event.prompt || event.prompt.length < 5) {
          api.logger.debug?.("memory-cognee: skipping recall (prompt too short)");
          return;
        }

        const agentId = getAgentIdFromCtx(ctx as { agentId?: string; sessionKey?: string; workspaceDir?: string });
        const effectiveDatasetName = resolveDatasetName(cfg.datasetName, agentId);
        const privateId = datasetState[effectiveDatasetName];
        const sharedId = cfg.sharedDatasetName ? datasetState[cfg.sharedDatasetName] : undefined;
        const datasetIds = [privateId, sharedId].filter(Boolean) as string[];

        if (datasetIds.length === 0) {
          api.logger.debug?.("memory-cognee: skipping recall (no datasetId for private or shared)");
          return;
        }

        try {
          const results = await client.search({
            queryText: event.prompt,
            searchType: cfg.searchType,
            datasetIds,
            maxTokens: cfg.maxTokens,
            maxResults: cfg.maxResults,
          });

          const filtered = results
            .filter((r) => r.score >= cfg.minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, cfg.maxResults);

          if (filtered.length === 0) {
            api.logger.debug?.("memory-cognee: search returned no results above minScore");
            return;
          }

          const payload = JSON.stringify(
            filtered.map((r) => ({
              id: r.id,
              score: r.score,
              text: r.text,
              metadata: r.metadata,
            })),
            null,
            2,
          );

          api.logger.info?.(
            `memory-cognee: injecting ${filtered.length} memories for session ${ctx.sessionKey ?? "unknown"}`,
          );

          return {
            prependContext: `<cognee_memories>\nRelevant memories:\n${payload}\n</cognee_memories>`,
          };
        } catch (error) {
          api.logger.warn?.(`memory-cognee: recall failed: ${String(error)}`);
        }
      });
    }

    // ------------------------------------------------------------------
    // Post-agent sync: detect file changes and sync to Cognee
    // ------------------------------------------------------------------

    if (cfg.autoIndex) {
      api.on("agent_end", async (event, ctx) => {
        if (!event.success) return;

        await stateReady;

        const workspaceDir = resolvedWorkspaceDir || process.cwd();
        const agentId = getAgentIdFromCtx(ctx as { agentId?: string; sessionKey?: string; workspaceDir?: string });
        const effectiveAgentId = perAgent ? agentId : undefined;

        try {
          const syncIndex = await loadSyncIndex(effectiveAgentId);
          const files = await collectMemoryFiles(workspaceDir);
          const changedFiles = files.filter((f) => {
            const existing = syncIndex.entries[f.path];
            return !existing || existing.hash !== f.hash;
          });

          if (changedFiles.length === 0) return;

          api.logger.info?.(`memory-cognee: detected ${changedFiles.length} changed file(s), syncing...`);

          const effectiveDatasetName = resolveDatasetName(cfg.datasetName, agentId);
          const result = await syncFiles(
            client,
            changedFiles,
            syncIndex,
            cfg,
            api.logger,
            effectiveDatasetName,
            effectiveAgentId,
          );
          if (result.datasetId) {
            datasetState[effectiveDatasetName] = result.datasetId;
          }

          api.logger.info?.(
            `memory-cognee: post-agent sync: ${result.added} added, ${result.updated} updated`,
          );
        } catch (error) {
          api.logger.warn?.(`memory-cognee: post-agent sync failed: ${String(error)}`);
        }
      });
    }

    // ------------------------------------------------------------------
    // Tool: write to shared dataset (when sharedDatasetName is set)
    // ------------------------------------------------------------------

    if (cfg.sharedDatasetName) {
      api.registerTool(
        {
          name: "cognee_memory_share",
          label: "Cognee Shared Memory",
          description:
            "Save a piece of information into the shared Cognee memory dataset. Use for facts or preferences that should be available to all agents.",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", description: "Content to remember in shared memory" },
            },
            required: ["text"],
          },
          async execute(_toolCallId, params) {
            const text = (params as { text: string }).text?.trim();
            if (!text) {
              return {
                content: [{ type: "text" as const, text: "Provide non-empty text to store." }],
                details: { error: "missing_text" },
              };
            }

            await stateReady;

            try {
              const sharedId = datasetState[cfg.sharedDatasetName];
              const uniqueFilename = `shared-memory-${Date.now()}.txt`;
              const response = await client.add({
                data: text,
                datasetName: cfg.sharedDatasetName,
                datasetId: sharedId,
                filename: uniqueFilename,
              });
              if (response.datasetId) {
                datasetState[cfg.sharedDatasetName] = response.datasetId;
                await saveDatasetState(datasetState).catch(() => {});
              }
              if (cfg.autoCognify && response.datasetId) {
                await client.cognify({ datasetIds: [response.datasetId] }).catch(() => {});
              }
              return {
                content: [{ type: "text" as const, text: `Stored in shared memory: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"` }],
                details: { action: "created", datasetName: cfg.sharedDatasetName },
              };
            } catch (error) {
              return {
                content: [{ type: "text" as const, text: `Failed to store: ${error instanceof Error ? error.message : String(error)}` }],
                details: { error: String(error) },
              };
            }
          },
        },
        { name: "cognee_memory_share" },
      );
    }
  },
};

export default memoryCogneePlugin;
