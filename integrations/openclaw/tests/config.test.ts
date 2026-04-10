/**
 * Unit tests for config.ts: resolveConfig, isPerAgentDataset, resolveDatasetName.
 * Run: node --test dist/tests/config.test.js (after build) or npx tsx --test tests/config.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  isPerAgentDataset,
  resolveConfig,
  resolveDatasetName,
  type CogneePluginConfig,
} from "../config.js";

describe("resolveDatasetName", () => {
  it("replaces {agentId} with given agentId", () => {
    assert.strictEqual(resolveDatasetName("openclaw-{agentId}", "main"), "openclaw-main");
    assert.strictEqual(resolveDatasetName("openclaw-{agentId}", "techmaster"), "openclaw-techmaster");
  });

  it("returns template unchanged when no placeholder", () => {
    assert.strictEqual(resolveDatasetName("openclaw", "main"), "openclaw");
    assert.strictEqual(resolveDatasetName("openclaw-shared", "techmaster"), "openclaw-shared");
  });

  it("uses main when agentId is empty string", () => {
    assert.strictEqual(resolveDatasetName("openclaw-{agentId}", ""), "openclaw-main");
  });
});

describe("isPerAgentDataset", () => {
  it("returns true when template contains {agentId}", () => {
    assert.strictEqual(isPerAgentDataset("openclaw-{agentId}"), true);
    assert.strictEqual(isPerAgentDataset("prefix-{agentId}-suffix"), true);
  });

  it("returns false when template has no placeholder", () => {
    assert.strictEqual(isPerAgentDataset("openclaw"), false);
    assert.strictEqual(isPerAgentDataset("openclaw-shared"), false);
  });
});

describe("resolveConfig", () => {
  it("uses defaults when config empty", () => {
    const cfg = resolveConfig({});
    assert.strictEqual(cfg.baseUrl, "http://localhost:8000");
    assert.strictEqual(cfg.datasetName, "openclaw");
    assert.strictEqual(cfg.sharedDatasetName, "");
    assert.strictEqual(cfg.searchType, "GRAPH_COMPLETION");
    assert.strictEqual(cfg.maxResults, 6);
    assert.strictEqual(cfg.autoRecall, true);
  });

  it("merges provided config", () => {
    const raw: Partial<CogneePluginConfig> = {
      baseUrl: "http://localhost:9000",
      datasetName: "openclaw-{agentId}",
      sharedDatasetName: "openclaw-shared",
      maxResults: 10,
    };
    const cfg = resolveConfig(raw);
    assert.strictEqual(cfg.baseUrl, "http://localhost:9000");
    assert.strictEqual(cfg.datasetName, "openclaw-{agentId}");
    assert.strictEqual(cfg.sharedDatasetName, "openclaw-shared");
    assert.strictEqual(cfg.maxResults, 10);
  });

  it("trims string config", () => {
    const cfg = resolveConfig({
      datasetName: "  openclaw-main  ",
      sharedDatasetName: "  shared  ",
    });
    assert.strictEqual(cfg.datasetName, "openclaw-main");
    assert.strictEqual(cfg.sharedDatasetName, "shared");
  });

  it("ignores non-object config", () => {
    const cfg = resolveConfig(null);
    assert.strictEqual(cfg.datasetName, "openclaw");
    const cfg2 = resolveConfig([]);
    assert.strictEqual(cfg2.datasetName, "openclaw");
  });
});
