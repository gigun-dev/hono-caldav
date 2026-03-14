import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// 1. 先に .env を読み込み
config({ path: path.join(root, '.env') });
// 2. .env.local で上書き
const local = config({ path: path.join(root, '.env.local') });
// 3. .dev.vars で上書き（Worker ローカルと同一の変数名で運用する場合）
config({ path: path.join(root, '.dev.vars') });

/**
 * 必要な環境変数が読み込まれているか検証する。
 * 値は表示せず、キーごとに OK / 未設定 のみ表示。
 */
export function verifyEnv(keys: string[]): { ok: string[]; missing: string[] } {
  const ok: string[] = [];
  const missing: string[] = [];

  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== '') {
      ok.push(key);
    } else {
      missing.push(key);
    }
  }

  return { ok, missing };
}

export function printEnvVerification(keys: string[]) {
  const { ok, missing } = verifyEnv(keys);

  console.log('\n[.env / .env.local / .dev.vars 読み込み検証]');
  console.log('.env.local の読み込み:', local.error ? `失敗 (${local.error.message})` : '成功');

  for (const k of ok) {
    console.log(`  ✅ ${k}: 設定済み`);
  }
  for (const k of missing) {
    console.log(`  ❌ ${k}: 未設定`);
  }

  if (missing.length > 0) {
    console.log('\n未設定の変数があります。.env / .env.local / .dev.vars のいずれかに KEY=value 形式で追加してください。\n');
  } else {
    console.log('\n必要な環境変数はすべて読み込まれています。\n');
  }

  return missing.length === 0;
}
