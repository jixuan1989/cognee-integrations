# Cognee 401 与插件 API Key 对齐说明

插件请求 Cognee 时若返回 **401 Unauthorized**，说明服务端鉴权未通过。下面说明两端如何配置才能对齐。

---

## 1. 插件侧：API Key 从哪里来

- **OpenClaw 插件** 发往 Cognee 的请求会带上：
  - `Authorization: Bearer <apiKey>`
  - `X-Api-Key: <apiKey>`
- **apiKey 来源**（二选一）：
  1. **插件配置** `plugins.entries.cognee-openclaw.config.apiKey`（可写 `${COGNEE_API_KEY}` 由环境变量展开）
  2. **环境变量** `COGNEE_API_KEY`（当插件 config 里未配置 apiKey 时使用）

所以：插件实际使用的 key = 配置里的 `apiKey` 或环境变量 `COGNEE_API_KEY`。

---

## 2. Cognee 侧：何时会 401

Cognee 后端（FastAPI）对 `/api/v1/add`、`/api/v1/search` 等接口会做鉴权（依赖 `get_authenticated_user`）。  
若 **服务端要求鉴权** 而请求里 **没有合法 key**，就会返回 401。

Cognee 通过环境变量控制是否要求鉴权：

| 环境变量 | 含义 | 建议（本地/插件用） |
|----------|------|----------------------|
| `REQUIRE_AUTHENTICATION` | 为 `true` 时，API 必须带合法认证才放行 | 本地与 OpenClaw 插件一起用时设为 **`false`**，可避免 401 |
| `ENABLE_BACKEND_ACCESS_CONTROL` | 数据集级访问控制（多租户等） | 本地单机可设为 **`false`** |

---

## 3. 推荐做法：本地关闭鉴权（避免 401）

**Docker Compose** 里给 Cognee 加上：

```yaml
environment:
  - REQUIRE_AUTHENTICATION=false
  - ENABLE_BACKEND_ACCESS_CONTROL=false
```

这样 Cognee **不校验** API Key，插件带不带 key、带什么 key 都不会 401。  
本仓库的 `integrations/openclaw/cognee-docker-compose.yaml` 已包含上述两项。

重启 Cognee 容器后生效：

```bash
docker compose -f integrations/openclaw/cognee-docker-compose.yaml up -d --force-recreate
```

---

## 4. 若必须开启鉴权（REQUIRE_AUTHENTICATION=true）

则需要 **Cognee 认可的 key** 与 **插件使用的 key** 一致：

1. **Cognee 如何认可 key**  
   取决于 Cognee 版本与部署方式，常见有：
   - 后台配置的固定 API Key 或 JWT 签发密钥
   - 首次启动时创建的默认用户 + 登录得到的 token  
   需查阅 Cognee 官方文档或当前部署的配置（环境变量、配置文件）。

2. **插件侧**  
   - 在 OpenClaw 的 `cognee-openclaw` 配置里设置 **同一个 key**：  
     `config.apiKey: "与 Cognee 一致的值"`  
     或设置环境变量 `COGNEE_API_KEY` 为该值（插件未配置 apiKey 时会用这个）。

3. **请求头**  
   插件已固定发送 `Authorization: Bearer <apiKey>` 和 `X-Api-Key: <apiKey>`，只要 key 与 Cognee 期望的一致即可。

---

## 5. 小结

| 目标 | 做法 |
|------|------|
| **不想处理 401，本地/单机用** | Cognee 环境变量设 `REQUIRE_AUTHENTICATION=false`（并可选 `ENABLE_BACKEND_ACCESS_CONTROL=false`），插件可不必配置 apiKey 或随便填。 |
| **必须开鉴权** | Cognee 端配置好“认可的 key”，插件侧 `apiKey` 或 `COGNEE_API_KEY` 填同一 key，保证两端一致。 |

当前仓库的 Cognee Compose 已按「关闭鉴权」方式配置，重启后 401 应消失；若仍出现，再检查 Cognee 镜像默认值或其它覆盖 `REQUIRE_AUTHENTICATION` 的配置。
