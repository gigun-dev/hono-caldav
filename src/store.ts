/**
 * Gmail historyId の保存先。D1 の gmail_history_sync テーブルのみ使用。
 * db が渡されない場合は取得は null、保存は何もしない。
 */

/** D1: ユーザーごとの historyId を取得 */
async function getFromD1(
  db: D1Database,
  userId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT history_id FROM gmail_history_sync WHERE user_id = ? LIMIT 1",
    )
    .bind(userId)
    .first<{ history_id: string }>();
  return row?.history_id ?? null;
}

/** D1: ユーザーごとの historyId を保存（INSERT or UPDATE） */
async function setToD1(
  db: D1Database,
  userId: string,
  historyId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO gmail_history_sync (user_id, history_id, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         history_id = excluded.history_id,
         updated_at = datetime('now')`,
    )
    .bind(userId, historyId)
    .run();
}

export async function getLastHistoryId(
  db?: D1Database | null,
): Promise<string | null> {
  if (!db) return null;
  const row = await db
    .prepare(
      "SELECT history_id FROM gmail_history_sync ORDER BY updated_at DESC LIMIT 1",
    )
    .first<{ history_id: string }>();
  return row?.history_id ?? null;
}

export async function setLastHistoryId(
  id: string,
  db?: D1Database | null,
): Promise<void> {
  if (!db) return;
  await db
    .prepare(
      `INSERT INTO gmail_history_sync (user_id, history_id, updated_at)
       VALUES ('_default', ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         history_id = excluded.history_id,
         updated_at = datetime('now')`,
    )
    .bind(id)
    .run();
}

/**
 * ユーザーごとの最後の Gmail historyId を取得。
 * @param userId ユーザー ID（better-auth の user.id など）
 * @param db D1 インスタンス。省略時は null を返す。
 */
export async function getLastHistoryIdForUser(
  userId: string,
  db?: D1Database | null,
): Promise<string | null> {
  if (!db) return null;
  return getFromD1(db, userId);
}

/**
 * ユーザーごとの最後の Gmail historyId を保存。
 * @param userId ユーザー ID
 * @param id historyId 文字列
 * @param db D1 インスタンス。省略時は何もしない。
 */
export async function setLastHistoryIdForUser(
  userId: string,
  id: string,
  db?: D1Database | null,
): Promise<void> {
  if (!db) return;
  await setToD1(db, userId, id);
}
