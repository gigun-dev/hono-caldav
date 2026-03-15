#!/bin/sh
# E2E テスト用の固定デモユーザーを D1 sqlite に直接 seed する
# 環境変数 MAESTRO_DEMO_EMAIL, MAESTRO_DEMO_APP_PASSWORD を使用 (.env.e2e で定義)
# データ（カレンダー/タスク）はサーバー起動後に POST /demo/seed で作成する

set -e

DB_PATH="${1:?Usage: seed-e2e.sh <path-to-sqlite>}"

# SHA-256 of MAESTRO_DEMO_APP_PASSWORD (default: "changeme")
HASH="057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86"

sqlite3 "$DB_PATH" <<SQL
INSERT OR IGNORE INTO "user" (id, name, email, "createdAt", "updatedAt")
  VALUES ('e2e-demo-user', 'Demo User', '${MAESTRO_DEMO_EMAIL}', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO app_passwords (id, user_id, name, password_hash, prefix)
  VALUES ('e2e-demo-pw', 'e2e-demo-user', 'E2E', '${HASH}', 'chan');
SQL

echo "E2E seed complete: ${MAESTRO_DEMO_EMAIL}"
