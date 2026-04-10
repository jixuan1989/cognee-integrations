#!/usr/bin/env bash
# 向本机 Cognee 发送一条知识（记忆）
#
# 用法:
#   ./scripts/cognee-add-memory.sh "这台机器的主人叫做东哥"
#   COGNEE_API_KEY=xxx ./scripts/cognee-add-memory.sh "任意文本"
#
# 环境:
#   COGNEE_URL   - Cognee API 地址，默认 http://127.0.0.1:8000
#   COGNEE_API_KEY - 可选，Cognee API Key（与 openclaw 插件配置一致）
#   COGNEE_DATASET - 数据集名，默认 openclaw

set -e

COGNEE_URL="${COGNEE_URL:-http://127.0.0.1:8000}"
COGNEE_DATASET="${COGNEE_DATASET:-openclaw}"
TEXT="${1:-这台机器的主人叫做东哥}"

if ! curl -s -m 5 -o /dev/null -w "%{http_code}" "$COGNEE_URL/health" 2>/dev/null | grep -q 200; then
  echo "错误：Cognee 未运行或不可达 ($COGNEE_URL)。请先启动: ./scripts/start-ollama-cognee.sh" >&2
  exit 1
fi

HEADERS=()
if [[ -n "${COGNEE_API_KEY:-}" ]]; then
  HEADERS+=(-H "Authorization: Bearer $COGNEE_API_KEY" -H "X-Api-Key: $COGNEE_API_KEY")
fi

echo "发送到 Cognee ($COGNEE_URL)：\"$TEXT\""
RESP=$(printf '%s' "$TEXT" | curl -s -m 30 -X POST "$COGNEE_URL/api/v1/add" \
  "${HEADERS[@]}" \
  -F "data=@-;filename=openclaw-memory.txt;type=text/plain" \
  -F "datasetName=$COGNEE_DATASET" 2>&1)

if echo "$RESP" | grep -q '"dataset_id"\|"message"\|"data_id"'; then
  echo "已记住。响应: $RESP"
else
  echo "请求可能失败。响应: $RESP" >&2
  exit 1
fi
