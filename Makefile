.PHONY: test up down seed reset-db erase-simulator e2e e2e-web e2e-ios ci ci-ios

-include .env
export

# =============================================================================
# Server Management
# =============================================================================

# DB リセット + サーバー起動 (wrangler dev がフォアグラウンドで動く)
up: down reset-db
	@echo "Starting MKCALENDAR proxy..."
	@bun run dev:proxy &
	@echo "Starting cloudflared tunnel..."
	@cloudflared tunnel run --token $(CLOUDFLARED_TOKEN) > /dev/null 2>&1 &
	@(sleep 5 && curl -sL http://localhost:8787/demo > /dev/null && echo "[make] Demo user seeded") &
	@echo "Starting wrangler dev... (Ctrl+C to stop, then 'make down' to stop all)"
	bun run dev

# サーバー停止
down:
	@pkill -f "wrangler dev" || true
	@pkill -f "bun run proxy" || true
	@pkill -f "cloudflared tunnel" || true
	@echo "All services stopped"

# DB リセット + マイグレーション
reset-db:
	rm -rf .wrangler/state/v3/d1
	@bun run dev &
	@for i in $$(seq 1 30); do curl -s http://localhost:8787/ > /dev/null 2>&1 && break; sleep 1; done
	yes | bun run db:migrate:local
	@pkill -f "wrangler dev" || true
	@echo "DB reset complete"

# デモユーザー作成
seed:
	@curl -sL http://localhost:8787/demo > /dev/null
	@echo "Demo user seeded"

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

# Web E2E
e2e-web:
	maestro test \
		-e SERVER_URL=$(SERVER_URL) \
		-e DEMO_EMAIL=$(DEMO_EMAIL) \
		-e DEMO_APP_PASSWORD=$(DEMO_APP_PASSWORD) \
		-p web --headless \
		--format junit \
		--output maestro-web-report.xml \
		.maestro/ --include-tags web

# iOS E2E (Simulator リセット + テスト)
e2e-ios: erase-simulator
	maestro test \
		-e SERVER_URL=$(SERVER_URL) \
		-e DEMO_EMAIL=$(DEMO_EMAIL) \
		-e DEMO_APP_PASSWORD=$(DEMO_APP_PASSWORD) \
		--format junit \
		--output maestro-ios-report.xml \
		.maestro/ --include-tags ios

# Web + iOS 両方
e2e: e2e-web e2e-ios

# =============================================================================
# CI (フル一括)
# =============================================================================

# Unit + Web E2E
ci: test up e2e-web down

# Unit + iOS E2E
ci-ios: test up e2e-ios down
