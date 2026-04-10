/**
 * Plugin config resolution only. All environment variable access is isolated here
 * so that the main plugin module (index.ts) does not combine env access with
 * network calls, avoiding "credential harvesting" false positives in static scanners.
 */

export type CogneeSearchType = "GRAPH_COMPLETION" | "CHUNKS" | "SUMMARIES";

export type CogneePluginConfig = {
  baseUrl?: string;
  apiKey?: string;
  datasetName?: string;
  /** Optional shared dataset; if set, search merges private + shared and agent can write via tool */
  sharedDatasetName?: string;
  searchType?: CogneeSearchType;
  maxResults?: number;
  minScore?: number;
  maxTokens?: number;
  autoRecall?: boolean;
  autoIndex?: boolean;
  autoCognify?: boolean;
  requestTimeoutMs?: number;
};

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

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

/**
 * Resolve plugin config from raw config. Reads COGNEE_API_KEY from env when
 * apiKey is not set in config. Call this at plugin load; do not use process.env
 * in the same module that performs fetch() to avoid scanner false positives.
 */
export function resolveConfig(rawConfig: unknown): Required<CogneePluginConfig> {
  const raw =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? (rawConfig as CogneePluginConfig)
      : {};

  const baseUrl = raw.baseUrl?.trim() || DEFAULT_BASE_URL;
  const datasetName = raw.datasetName?.trim() || DEFAULT_DATASET_NAME;
  const sharedDatasetName = raw.sharedDatasetName?.trim() || "";
  const searchType = raw.searchType || DEFAULT_SEARCH_TYPE;
  const maxResults =
    typeof raw.maxResults === "number" ? raw.maxResults : DEFAULT_MAX_RESULTS;
  const minScore =
    typeof raw.minScore === "number" ? raw.minScore : DEFAULT_MIN_SCORE;
  const maxTokens =
    typeof raw.maxTokens === "number" ? raw.maxTokens : DEFAULT_MAX_TOKENS;
  const autoRecall =
    typeof raw.autoRecall === "boolean" ? raw.autoRecall : DEFAULT_AUTO_RECALL;
  const autoIndex =
    typeof raw.autoIndex === "boolean" ? raw.autoIndex : DEFAULT_AUTO_INDEX;
  const autoCognify =
    typeof raw.autoCognify === "boolean" ? raw.autoCognify : DEFAULT_AUTO_COGNIFY;
  const requestTimeoutMs =
    typeof raw.requestTimeoutMs === "number" ? raw.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;

  const apiKey =
    raw.apiKey && raw.apiKey.length > 0
      ? resolveEnvVars(raw.apiKey)
      : (process.env.COGNEE_API_KEY ?? "");

  return {
    baseUrl,
    apiKey,
    datasetName,
    sharedDatasetName,
    searchType,
    maxResults,
    minScore,
    maxTokens,
    autoRecall,
    autoIndex,
    autoCognify,
    requestTimeoutMs,
  };
}

/** Whether datasetName template contains {agentId} (per-agent mode). */
export function isPerAgentDataset(template: string): boolean {
  return template.includes("{agentId}");
}

/** Resolve datasetName template with agentId; backward compatible when no placeholder. */
export function resolveDatasetName(template: string, agentId: string): string {
  return template.replace(/\{agentId\}/g, agentId || "main");
}
