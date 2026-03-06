# Phase 2: CalDAV Server 成熟 ガイド

## 1. iOS mobileconfig

### 概要

mobileconfig は Apple のデバイス設定プロファイル (XML plist)。
CalDAV アカウント設定を含めることで、ユーザーの手動入力を省ける。

### CalDAV ペイロード構造

`PayloadType: com.apple.caldav.account` を使用:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>CalDAVAccountDescription</key>
      <string>My CalDAV TODO</string>
      <key>CalDAVHostName</key>
      <string>your-worker.example.com</string>
      <key>CalDAVPort</key>
      <integer>443</integer>
      <key>CalDAVPrincipalURL</key>
      <string>/dav/principals/USERNAME/</string>
      <key>CalDAVUseSSL</key>
      <true/>
      <key>CalDAVUsername</key>
      <string>USERNAME</string>
      <!-- CalDAVPassword は省略推奨。省略するとインストール時にユーザーに入力を求める -->
      <key>PayloadDescription</key>
      <string>CalDAV Account Configuration</string>
      <key>PayloadDisplayName</key>
      <string>CalDAV VTODO Server</string>
      <key>PayloadIdentifier</key>
      <string>com.example.caldav.account</string>
      <key>PayloadType</key>
      <string>com.apple.caldav.account</string>
      <key>PayloadUUID</key>
      <string>UNIQUE-UUID-HERE</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>CalDAV Server Configuration Profile</string>
  <key>PayloadDisplayName</key>
  <string>CalDAV VTODO Server</string>
  <key>PayloadIdentifier</key>
  <string>com.example.caldav.profile</string>
  <key>PayloadOrganization</key>
  <string>Your Organization</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>ANOTHER-UNIQUE-UUID</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
```

### 主要キー

| キー | 型 | 必須 | 説明 |
|------|------|------|------|
| CalDAVHostName | string | Yes (macOS) | サーバーアドレス |
| CalDAVPort | integer | No | ポート (default 443) |
| CalDAVPrincipalURL | string | No | プリンシパル URL パス |
| CalDAVUseSSL | boolean | No | SSL 使用 |
| CalDAVUsername | string | Yes (macOS) | ユーザー名 |
| CalDAVPassword | string | No | パスワード (省略推奨) |

### サーバーサイド動的生成

Hono で plist XML をテンプレートリテラルで組み立てて返す:

```typescript
app.get("/setup/ios", (c) => {
  const host = new URL(c.req.url).hostname;
  const xml = generateMobileconfig(host, username);
  return c.body(xml, 200, {
    "Content-Type": "application/x-apple-aspen-config",
    "Content-Disposition": 'attachment; filename="caldav.mobileconfig"',
  });
});
```

UUID は `crypto.randomUUID()` で生成可能 (Workers 対応)。

### zone-eu/mobileconfig ライブラリ

**Workers では動作しない。** `fs` モジュールへの依存が致命的 (Workers にファイルシステムなし)。

**代替: 手動 XML 生成で十分。** mobileconfig は単なる plist XML なのでライブラリ不要。

### 署名

- **署名なしでも動作する** (「未署名」警告は出る)
- Workers 上で署名するなら **PKI.js** が有力 (WebCrypto API 上に構築、Cloudflare 自身が使用実績あり)
- ハッカソンスコープでは署名なしで十分

---

## 2. Android の CalDAV セットアップ

### mobileconfig 相当の仕組み

**ネイティブでは存在しない。** Android は CalDAV を標準サポートしておらず、サードパーティアプリが必要。

### DAVx5 (推奨)

Android で最も広く使われるオープンソースの CalDAV/CardDAV sync adapter。

- Google Play (有料) / F-Droid (無料)
- well-known URL + SRV レコードによる auto-discovery フルサポート
- 設定時にベース URL を入力するだけ

**DAVx5 の Discovery フロー:**
1. PROPFIND (Depth:0) → `current-user-principal`, `calendar-home-set` 要求
2. 失敗したら `/.well-known/caldav` に PROPFIND
3. それも失敗したら DNS SRV `_caldavs._tcp.<domain>` を検索
4. OPTIONS で `DAV: calendar-access` 確認
5. calendar-home-set → カレンダー一覧取得

**その他のアプリ:**
- CalDAV-Sync (有料)
- Tasks.org (CalDAV VTODO サポート)

### Android ユーザー向けセットアップ

`/setup` ページに以下を表示:
1. DAVx5 インストールリンク
2. サーバー URL (コピー可能)
3. ユーザー名
4. スクリーンショット付き手順

---

## 3. CalDAV auto-discovery

### .well-known/caldav (RFC 6764)

**現在の実装で対応済み。** GET/PROPFIND を `/dav/` に 301 リダイレクト。

### SRV レコード

カスタムドメイン使用時に DNS に追加:

```
_caldavs._tcp.example.com. 86400 IN SRV 0 1 443 caldav.example.com.
_caldavs._tcp.example.com. 86400 IN TXT "path=/dav/"
```

Workers のデフォルトドメイン (*.workers.dev) では設定不可。

### クライアント別の Discovery 動作

| クライアント | well-known | SRV | Principal 探索 |
|-------------|-----------|-----|--------------|
| iOS Calendar | PROPFIND → redirect | Yes | current-user-principal → calendar-home-set |
| DAVx5 | PROPFIND | Yes | OPTIONS で calendar-access 確認 → calendar-home-set |
| Thunderbird | **非対応** | No | カレンダー URL 直接入力 |

---

## 4. CalDAV Server エッジケース

### iOS の注意点

1. PROPFIND レスポンスにも DAV ヘッダーを含める
2. 未認証は 403 ではなく **401** (現在の実装は正しい)
3. home-set フォルダは1つのみ対応 (現在の実装は `/dav/projects/` 1つなので OK)

### 現在の実装で改善すべき点

1. **DAV ヘッダー不一致**: `xml.ts` は `"1, calendar-access"` だが `handlers.ts` は `"1, calendar-access, sync-collection, extended-mkcol"`。PROPFIND レスポンスにも sync-collection を含めるべき
2. **PUT 既存更新時**: 200 → **204 No Content** が CalDAV クライアント互換性でベター
3. **calendar-user-address-set**: Principal レスポンスに追加検討 (iTIP の Phase 4 で必要)

---

## 実装優先度

| 項目 | 難易度 | 効果 | 推奨度 |
|------|--------|------|--------|
| mobileconfig 動的生成 (未署名) | 低 | iOS セットアップ簡素化 | 高 |
| セットアップガイドページ (/setup) | 低 | Android/Thunderbird 対応 | 高 |
| SRV レコード設定 | 低 | カスタムドメイン時に有効 | 中 |
| DAV ヘッダー統一 | 低 | iOS 互換性向上 | 中 |
| PUT 204 修正 | 低 | クライアント互換性向上 | 中 |
| mobileconfig 署名 (PKI.js) | 高 | 警告なしインストール | 低 (ハッカソン不要) |
