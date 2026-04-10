#!/usr/bin/env bash
# 一键启动 Ollama 与 Cognee（Docker）
#
# 用法:
#   ./scripts/start-ollama-cognee.sh          # 启动两者
#   ./scripts/start-ollama-cognee.sh --check  # 仅检查状态
#
# 环境:
#   LLM_API_KEY  - Cognee 使用的 LLM API Key（OpenAI 兼容或本地 Ollama 不需 key 时可留空）
#   可选：在项目根目录或 integrations/openclaw 下放 .env 设置 LLM_API_KEY
#
# 环境（可选）:
#   COGNEE_COMPOSE_DIR - Cognee 项目目录，如 ~/soft/cognee；设后在该目录执行 docker compose up -d
#
# 参考:
#   - Cognee: integrations/openclaw/cognee-docker-compose.yaml 或 COGNEE_COMPOSE_DIR
#   - Ollama: systemd ollama.service 或 ollama serve

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/integrations/openclaw/cognee-docker-compose.yaml"
COGNEE_COMPOSE_DIR="${COGNEE_COMPOSE_DIR:-}"
COGNEE_URL="${COGNEE_URL:-http://127.0.0.1:8001}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
OLLAMA_MODELS_GREP="${OLLAMA_MODELS_GREP:-qwen2.5|nomic-embed|llama3}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
err() { echo "[$(date '+%H:%M:%S')] $*" >&2; }

# 加载 .env（可选）
for f in "$REPO_ROOT/.env" "$REPO_ROOT/integrations/openclaw/.env"; do
  if [[ -f "$f" ]]; then
    log "Loading env: $f"
    set -a
    source "$f"
    set +a
    break
  fi
done

start_ollama() {
  if curl -s -m 3 -o /dev/null -w "%{http_code}" "$OLLAMA_URL/api/tags" 2>/dev/null | grep -q 200; then
    log "Ollama already running at $OLLAMA_URL"
    return 0
  fi
  if command -v systemctl &>/dev/null && systemctl is-active ollama &>/dev/null; then
    log "Starting Ollama (systemctl)..."
    sudo systemctl start ollama 2>/dev/null || true
  fi
  if ! curl -s -m 3 -o /dev/null -w "%{http_code}" "$OLLAMA_URL/api/tags" 2>/dev/null | grep -q 200; then
    if command -v ollama &>/dev/null; then
      log "Starting Ollama (ollama serve)..."
      nohup ollama serve > /tmp/ollama-serve.log 2>&1 &
      sleep 5
    fi
  fi
  if curl -s -m 3 -o /dev/null -w "%{http_code}" "$OLLAMA_URL/api/tags" 2>/dev/null | grep -q 200; then
    log "Ollama OK at $OLLAMA_URL"
    return 0
  fi
  err "Ollama failed to start. Check: systemctl status ollama or ollama serve"
  return 1
}

start_cognee() {
  if curl -s -m 5 -o /dev/null -w "%{http_code}" "$COGNEE_URL/health" 2>/dev/null | grep -q 200; then
    log "Cognee already running at $COGNEE_URL"
    return 0
  fi
  if ! command -v docker &>/dev/null; then
    err "Docker not found. Install Docker to run Cognee."
    return 1
  fi
  if [[ -n "$COGNEE_COMPOSE_DIR" ]]; then
    local dir
    dir="$(eval echo "$COGNEE_COMPOSE_DIR")"
    if [[ ! -d "$dir" ]]; then
      err "COGNEE_COMPOSE_DIR not a directory: $dir"
      return 1
    fi
    log "Starting Cognee (docker compose at $dir)..."
    (cd "$dir" && docker compose up -d 2>/dev/null || docker-compose up -d)
  else
    if [[ ! -f "$COMPOSE_FILE" ]]; then
      err "Compose file not found: $COMPOSE_FILE (set COGNEE_COMPOSE_DIR to use another path)"
      return 1
    fi
    log "Starting Cognee (docker compose)..."
    (cd "$REPO_ROOT" && docker compose -f "$COMPOSE_FILE" up -d)
  fi
  log "Waiting for Cognee health..."
  for i in {1..24}; do
    if curl -s -m 5 -o /dev/null -w "%{http_code}" "$COGNEE_URL/health" 2>/dev/null | grep -q 200; then
      log "Cognee OK at $COGNEE_URL"
      return 0
    fi
    sleep 5
  done
  err "Cognee health check timeout. Check logs in Cognee project or: docker compose logs -f"
  return 1
}

status() {
  log "--- Ollama ---"
  if curl -s -m 3 -o /dev/null -w "%{http_code}" "$OLLAMA_URL/api/tags" 2>/dev/null | grep -q 200; then
    echo "  Running at $OLLAMA_URL"
    curl -s -m 3 "$OLLAMA_URL/api/ps" | head -c 200
    echo ""
  else
    echo "  Not running"
  fi
  log "--- Cognee ---"
  if curl -s -m 5 -o /dev/null -w "%{http_code}" "$COGNEE_URL/health" 2>/dev/null | grep -q 200; then
    echo "  Running at $COGNEE_URL"
    curl -s -m 5 "$COGNEE_URL/health" | head -c 200
    echo ""
  else
    echo "  Not running"
  fi
}

verify_models() {
  log "--- 检查模型 ---"
  if ! curl -s -m 3 -o /dev/null -w "%{http_code}" "$OLLAMA_URL/api/tags" 2>/dev/null | grep -q 200; then
    echo "  Ollama 未运行，跳过模型检查"
    return 0
  fi
  if command -v ollama &>/dev/null; then
    if ollama list 2>/dev/null | grep -qE "$OLLAMA_MODELS_GREP"; then
      echo "  已拉取模型:"
      ollama list 2>/dev/null | grep -E "$OLLAMA_MODELS_GREP" || true
    else
      echo "  警告：未发现匹配模型（OLLAMA_MODELS_GREP=$OLLAMA_MODELS_GREP）。可运行: ollama pull qwen2.5:32b-instruct-q4_K_M && ollama pull nomic-embed-text"
    fi
  fi
}

case "${1:-}" in
  --check|-c) status; verify_models; exit 0 ;;
  --help|-h)
    echo "Usage: $0 [--check|--help]"
    echo "  (no args)  Start Ollama and Cognee, then show status and verify models"
    echo "  --check    Print status and model check only"
    echo "Env: COGNEE_COMPOSE_DIR (e.g. ~/soft/cognee), LLM_API_KEY, OLLAMA_MODELS_GREP"
    exit 0
    ;;
esac

echo "=== 启动 OpenClaw + Cognee 环境 ==="
start_ollama || true
start_cognee || true
log "--- Status ---"
status
verify_models
