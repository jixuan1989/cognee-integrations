# Cognee-OpenClaw 多 Agent 记忆空间与共享空间配置说明

本文说明如何为 OpenClaw 的 cognee-openclaw 插件配置「每个 agent 独立记忆空间」和「跨 agent 共享记忆空间」。

---

## 1. 概念

- **私有记忆（per-agent）**：每个 agent（如 main、techmaster）拥有自己的 Cognee dataset 和同步索引，彼此不可见。
- **共享记忆（shared）**：可选的一个 Cognee dataset，所有 agent 在 recall 时都会同时查「自己的私有 + 共享」；agent 可通过工具主动往共享空间写入内容。

---

## 2. 配置文件位置

OpenClaw 的配置通常位于：

- 用户级：`~/.openclaw/openclaw.json` 或 `~/.openclaw/config.yaml`
- 项目级：项目根目录下的 OpenClaw 配置文件（若存在）

插件配置写在 `plugins.entries.cognee-openclaw.config` 下。

---

## 3. 多 Agent 私有记忆空间

### 3.1 配置项：`datasetName` 使用 `{agentId}` 模板

在插件 config 里将 `datasetName` 设置为包含 `{agentId}` 的字符串，插件会按当前 agent 替换为对应 id。

**示例（YAML 风格）：**

```yaml
plugins:
  entries:
    cognee-openclaw:
      enabled: true
      config:
        baseUrl: "http://localhost:8000"
        apiKey: "${COGNEE_API_KEY}"
        # 每个 agent 独立 dataset：main -> openclaw-main，techmaster -> openclaw-techmaster
        datasetName: "openclaw-{agentId}"
        # 其他选项...
        autoRecall: true
        autoIndex: true
```

**示例（JSON 风格，openclaw.json）：**

```json
{
  "plugins": {
    "entries": {
      "cognee-openclaw": {
        "enabled": true,
        "config": {
          "baseUrl": "http://localhost:8000",
          "apiKey": "${COGNEE_API_KEY}",
          "datasetName": "openclaw-{agentId}",
          "autoRecall": true,
          "autoIndex": true
        }
      }
    }
  }
}
```

### 3.2 行为说明

- 配置为 `openclaw-{agentId}` 时：
  - agent **main** 使用 dataset 名 `openclaw-main`，同步索引文件为 `~/.openclaw/memory/cognee/sync-index-main.json`。
  - agent **techmaster** 使用 `openclaw-techmaster`，同步索引为 `sync-index-techmaster.json`。
- 所有 dataset 名与 Cognee 返回的 datasetId 的对应关系，统一保存在 `~/.openclaw/memory/cognee/datasets.json` 中（多 agent 时会有多条映射）。

### 3.3 兼容旧配置

- 若 `datasetName` **不包含** `{agentId}`（例如仍为 `openclaw` 或 `default-project`），行为与旧版一致：全局一个 dataset、一个 `sync-index.json`，不做 per-agent 隔离。

---

## 4. 共享记忆空间

### 4.1 配置项：`sharedDatasetName`

在插件 config 中增加可选字段 `sharedDatasetName`，填写一个固定的 Cognee dataset 名（所有 agent 共用该名字）。

**示例（YAML）：**

```yaml
plugins:
  entries:
    cognee-openclaw:
      enabled: true
      config:
        baseUrl: "http://localhost:8000"
        datasetName: "openclaw-{agentId}"
        # 共享空间：recall 时同时查私有 + 该 dataset；agent 可通过工具写入
        sharedDatasetName: "openclaw-shared"
        autoRecall: true
        autoIndex: true
```

**示例（JSON）：**

```json
{
  "plugins": {
    "entries": {
      "cognee-openclaw": {
        "enabled": true,
        "config": {
          "baseUrl": "http://localhost:8000",
          "datasetName": "openclaw-{agentId}",
          "sharedDatasetName": "openclaw-shared",
          "autoRecall": true,
          "autoIndex": true
        }
      }
    }
  }
}
```

### 4.2 行为说明

- **Recall（自动注入记忆）**：每次 recall 会同时查询「当前 agent 的私有 dataset」和「sharedDatasetName 对应的 dataset」，结果合并后按分数排序，再按 `maxResults` 等限制注入上下文。
- **写入共享记忆**：当配置了 `sharedDatasetName` 时，插件会注册工具 **`cognee_memory_share`**。Agent 在对话中调用该工具并传入一段文本，即可把内容写入共享 dataset，供所有 agent 在后续 recall 时检索到。
- 若不配置 `sharedDatasetName`，则仅使用每个 agent 的私有 dataset，无共享空间、也无该工具。

---

## 5. 完整配置示例（多 Agent + 共享）

下面是一份同时启用「多 agent 私有空间」和「共享空间」的示例（YAML），可按需改成 JSON 或合并进现有配置：

```yaml
plugins:
  entries:
    cognee-openclaw:
      enabled: true
      config:
        baseUrl: "http://localhost:8000"
        apiKey: "${COGNEE_API_KEY}"
        # 每个 agent 独立记忆
        datasetName: "openclaw-{agentId}"
        # 跨 agent 共享记忆
        sharedDatasetName: "openclaw-shared"
        searchType: "GRAPH_COMPLETION"
        maxResults: 6
        minScore: 0
        maxTokens: 512
        autoRecall: true
        autoIndex: true
        autoCognify: true
        requestTimeoutMs: 60000
```

---

## 6. 相关文件路径汇总

| 用途           | 路径 |
|----------------|------|
| 全局 dataset 映射 | `~/.openclaw/memory/cognee/datasets.json` |
| 单 agent 同步索引（per-agent 模式） | `~/.openclaw/memory/cognee/sync-index-<agentId>.json`（如 `sync-index-main.json`） |
| 兼容旧版单 dataset 同步索引 | `~/.openclaw/memory/cognee/sync-index.json` |

---

## 7. CLI 与 agent 指定

- 在 per-agent 模式下，CLI 可通过 `--agent <id>` 指定要操作哪个 agent 的索引/状态，例如：
  - `openclaw cognee status --agent main`
  - `openclaw cognee status --agent techmaster`
  - `openclaw cognee index --agent main`
- 未加 `--agent` 时，会从当前上下文推断 agent（如 workspace 路径、session 等），若无法推断则默认为 `main`。

---

本文档对应插件仓库：`integrations/openclaw`（@cognee/cognee-openclaw）。更多选项见该目录下的 `README.md` 和 `openclaw.plugin.json` 中的 configSchema。
