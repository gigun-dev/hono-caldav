.PHONY: test up dev stop reset-db seed-db erase-simulator e2e-ios ci

-include .env
-include .env.e2e
export

# =============================================================================
# Server Management
# =============================================================================

# サーバー起動 (DB リセット + migrate + seed → バックグラウンド稼働)
#   make up   → 起動、ログはターミナルに流れる
#   make stop → 全停止
up:
	@$(MAKE) stop 2>/dev/null || true
	@rm -rf .wrangler/state/v3/d1
	@cloudflared tunnel run --token $(CLOUDFLARED_TOKEN) > /dev/null 2>&1 &
	@bun run dev:proxy &
	@bun run dev &
	@for i in $$(seq 1 30); do curl -s http://localhost:8787/ > /dev/null 2>&1 && break; sleep 1; done
	@yes | bun run db:migrate:local > /dev/null 2>&1
	@D1=$$(find .wrangler/state/v3/d1 -name '*.sqlite' 2>/dev/null | head -1); \
	./scripts/seed-e2e.sh "$$D1"
	@curl -s -X POST -u "$(MAESTRO_DEMO_EMAIL):$(MAESTRO_DEMO_APP_PASSWORD)" http://localhost:8787/demo/seed > /dev/null
	@echo "Server ready (make stop to shutdown)"

# ローカル開発 (make up + Ctrl+C で全停止)
dev: up
	@trap '$(MAKE) stop; exit 0' INT TERM; \
	while true; do sleep 86400; done

# サーバー停止
stop:
	@pkill -f "wrangler dev" 2>/dev/null || true
	@pkill -f "bun run proxy" 2>/dev/null || true
	@pkill -f "cloudflared tunnel" 2>/dev/null || true

# DB リセット + マイグレーション (独立実行用)
reset-db:
	rm -rf .wrangler/state/v3/d1
	@bun run dev &
	@for i in $$(seq 1 30); do curl -s http://localhost:8787/ > /dev/null 2>&1 && break; sleep 1; done
	yes | bun run db:migrate:local
	@pkill -f "wrangler dev" || true
	@echo "DB reset complete"

# E2E 用デモデータを sqlite3 で直接 seed (独立実行用)
seed-db:
	@D1=$$(find .wrangler/state/v3/d1 -name '*.sqlite' 2>/dev/null | head -1); \
	./scripts/seed-e2e.sh "$$D1"

# =============================================================================
# Testing
# =============================================================================

# Vitest (Unit / API)
test:
	bun run test

# iOS Simulator をリセット (LOCALE=ja or LOCALE=en, default: en)
# available デバイスから iPhone 16e 優先で探す (booted 不要)
LOCALE ?= en
DEVICE_UDID ?= $(shell xcrun simctl list devices available -j | jq -r '.devices | to_entries[] | select(.key | contains("iOS")) | .value[] | select(.name == "iPhone 16e") | .udid' | head -1)
DEVICE_UDID := $(or $(DEVICE_UDID),$(shell xcrun simctl list devices available -j | jq -r '.devices | to_entries[] | select(.key | contains("iOS")) | .value[] | .udid' | head -1))
SIM_ROOT = $(HOME)/Library/Developer/CoreSimulator/Devices/$(DEVICE_UDID)/data
PREFS_PLIST = $(SIM_ROOT)/Library/Preferences/.GlobalPreferences.plist
ACCOUNTS_DB = $(SIM_ROOT)/Library/Accounts/Accounts3.sqlite
erase-simulator:
	@if [ -z "$(DEVICE_UDID)" ]; then echo "No available iOS simulator found"; exit 1; fi
	xcrun simctl shutdown $(DEVICE_UDID) 2>/dev/null || true
	xcrun simctl erase $(DEVICE_UDID)
ifeq ($(LOCALE),ja)
	plutil -replace AppleLanguages -json '["ja","en"]' $(PREFS_PLIST)
	plutil -replace AppleLocale -string ja_JP $(PREFS_PLIST)
else
	plutil -replace AppleLanguages -json '["en"]' $(PREFS_PLIST)
	plutil -replace AppleLocale -string en_US $(PREFS_PLIST)
endif
	@# Boot to create DB files, then shutdown to safely INSERT
	xcrun simctl bootstatus $(DEVICE_UDID) -b
	xcrun simctl shutdown $(DEVICE_UDID)
	@sleep 2
	@# Insert subscribed calendar so ACCOUNTS section appears in Settings
	@./scripts/seed-simulator-account.sh "$(ACCOUNTS_DB)"
	@# Final boot with account data
	xcrun simctl bootstatus $(DEVICE_UDID) -b
	@echo "Simulator erased and booted: $(LOCALE) ($(DEVICE_UDID))"

# =============================================================================
# E2E (Maestro) — サーバー起動済み前提
# =============================================================================

# iOS E2E (Simulator リセット + テスト)
#   make e2e-ios            → English
#   make e2e-ios LOCALE=ja  → Japanese
# MAESTRO_* 環境変数は .env.e2e から export 済み → Maestro が自動読み取り
e2e-ios: erase-simulator
	set -a && . .maestro/locale/$(LOCALE).env && set +a && \
	maestro test \
		--debug-output . \
		.maestro/
	@LATEST=$$(ls -dt .maestro/tests/*/ 2>/dev/null | head -1); \
	if [ -n "$$LATEST" ]; then \
		mv *.mp4 "$$LATEST" 2>/dev/null || true; \
		echo "Results: $$LATEST"; \
	fi

# =============================================================================
# CI (フル一括: Unit + サーバー起動 + iOS E2E + 停止)
# =============================================================================

ci: test
	$(MAKE) up
	$(MAKE) e2e-ios
	$(MAKE) stop
