.PHONY: test up stop seed-db reset-db erase-simulator e2e-ios ci

-include .env
-include .env.e2e
export

D1_DB = $(shell find .wrangler/state/v3/d1 -name '*.sqlite' 2>/dev/null | head -1)

# =============================================================================
# Server Management
# =============================================================================

# サーバー起動 (BG=1 で CI 用バックグラウンドモード)
#   make up     → ログ表示、Ctrl+C で全停止
#   make up BG=1 → 全バックグラウンド (CI 用)
up: stop reset-db seed-db
	@cloudflared tunnel run --token $(CLOUDFLARED_TOKEN) > /dev/null 2>&1 &
	@if [ "$(BG)" = "1" ]; then \
		bun run dev:proxy > /dev/null 2>&1 & \
		bun run dev > /dev/null 2>&1 & \
		for i in $$(seq 1 30); do curl -s http://localhost:8787/ > /dev/null 2>&1 && break; sleep 1; done; \
		curl -s -X POST -u "$(MAESTRO_DEMO_EMAIL):$(MAESTRO_DEMO_APP_PASSWORD)" http://localhost:8787/demo/seed > /dev/null; \
		echo "Server ready (background)"; \
	else \
		bun run dev:proxy & \
		(sleep 5 && curl -s -X POST -u "$(MAESTRO_DEMO_EMAIL):$(MAESTRO_DEMO_APP_PASSWORD)" http://localhost:8787/demo/seed > /dev/null && echo "[make] Demo data seeded") & \
		trap 'pkill -f "wrangler dev" 2>/dev/null; pkill -f "bun run proxy" 2>/dev/null; pkill -f "cloudflared tunnel" 2>/dev/null; echo "\nAll services stopped"; exit 0' INT TERM; \
		echo "Starting wrangler dev... (Ctrl+C to stop all)"; \
		bun run dev; \
	fi

# サーバー停止
stop:
	@pkill -f "wrangler dev" 2>/dev/null || true
	@pkill -f "bun run proxy" 2>/dev/null || true
	@pkill -f "cloudflared tunnel" 2>/dev/null || true

# DB リセット + マイグレーション
reset-db:
	rm -rf .wrangler/state/v3/d1
	@bun run dev &
	@for i in $$(seq 1 30); do curl -s http://localhost:8787/ > /dev/null 2>&1 && break; sleep 1; done
	yes | bun run db:migrate:local
	@pkill -f "wrangler dev" || true
	@echo "DB reset complete"

# E2E 用デモデータを sqlite3 で直接 seed
seed-db:
	@./scripts/seed-e2e.sh $(D1_DB)

# =============================================================================
# Testing
# =============================================================================

# Vitest (Unit / API)
test:
	bun run test

# iOS Simulator をリセット
erase-simulator:
	$(eval DEVICE_UDID := $(shell xcrun simctl list devices booted -j | jq -r '.devices | to_entries[] | .value[] | select(.state == "Booted") | .udid' | head -1))
	@if [ -z "$(DEVICE_UDID)" ]; then echo "No booted iOS simulator found"; exit 1; fi
	xcrun simctl shutdown $(DEVICE_UDID) || true
	xcrun simctl erase $(DEVICE_UDID)
	xcrun simctl boot $(DEVICE_UDID)
	@echo "Simulator erased and rebooted"

# =============================================================================
# E2E (Maestro) — サーバー起動済み前提
# =============================================================================

# iOS E2E (Simulator リセット + テスト)
# MAESTRO_* 環境変数は .env.e2e から export 済み → Maestro が自動読み取り
e2e-ios: erase-simulator
	maestro test \
		--debug-output . \
		.maestro/ --include-tags ios

# =============================================================================
# CI (フル一括: Unit + サーバー起動 + iOS E2E + 停止)
# =============================================================================

ci: test
	$(MAKE) up BG=1
	$(MAKE) e2e-ios
	$(MAKE) stop
