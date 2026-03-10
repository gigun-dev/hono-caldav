import type { FC } from "hono/jsx";

type SetupProps = {
	hostname: string;
	userEmail: string;
};

export const SetupPage: FC<SetupProps> = ({ hostname, userEmail }) => {
	const serverUrl = `https://${hostname}/dav/`;

	return (
		<html lang="ja">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Setup Guide - CalDAV Task Manager</title>
				<style>{`
					* { margin: 0; padding: 0; box-sizing: border-box; }
					body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; padding: 1rem; }
					.container { max-width: 700px; margin: 0 auto; }
					.card { background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 1rem; }
					h1 { font-size: 1.5rem; margin-bottom: 1rem; }
					h2 { font-size: 1.2rem; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem; }
					h3 { font-size: 1rem; margin: 1rem 0 0.5rem; color: #333; }
					p { color: #555; margin-bottom: 0.5rem; line-height: 1.6; }
					ol { padding-left: 1.5rem; margin-bottom: 1rem; }
					li { margin-bottom: 0.5rem; color: #555; line-height: 1.6; }
					code { background: #e3f2fd; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.9rem; user-select: all; }
					.btn { display: inline-block; background: #4285f4; color: white; border: none; border-radius: 8px; padding: 0.75rem 1.5rem; font-size: 1rem; cursor: pointer; text-decoration: none; }
					.btn:hover { background: #3367d6; }
					.btn-outline { background: transparent; color: #4285f4; border: 2px solid #4285f4; }
					.btn-outline:hover { background: #e3f2fd; }
					.info-box { background: #f0f7ff; border: 1px solid #bbdefb; border-radius: 8px; padding: 1rem; margin: 0.75rem 0; }
					.info-box p { color: #1565c0; margin: 0; }
					.back { display: inline-block; color: #666; text-decoration: none; margin-bottom: 1rem; }
					.back:hover { color: #333; }
					.platform-icon { font-size: 1.5rem; }
					.copy-btn { background: #eee; border: 1px solid #ddd; border-radius: 4px; padding: 0.2rem 0.5rem; cursor: pointer; font-size: 0.8rem; margin-left: 0.25rem; }
				`}</style>
			</head>
			<body>
				<div class="container">
					<a href="/dashboard" class="back">← Dashboard</a>
					<h1>CalDAV Client Setup Guide</h1>

					<div class="card">
						<h2><span class="platform-icon">🍎</span> iOS / macOS</h2>
						<p>mobileconfig を使って自動設定できます。</p>

						<h3>方法 1: mobileconfig (推奨)</h3>
						<ol>
							<li>下のボタンからプロファイルをダウンロード</li>
							<li>「設定」→「一般」→「VPN とデバイス管理」→ プロファイルをインストール</li>
							<li>App Password を入力 (Dashboard で生成)</li>
						</ol>
						<a href="/setup/ios" class="btn">mobileconfig をダウンロード</a>

						<h3>方法 2: 手動設定</h3>
						<ol>
							<li>「設定」→「カレンダー」→「アカウント」→「アカウントを追加」→「その他」</li>
							<li>「CalDAV アカウントを追加」を選択</li>
							<li>サーバー: <code>{hostname}</code></li>
							<li>ユーザー名: <code>{userEmail}</code></li>
							<li>パスワード: Dashboard で生成した App Password</li>
						</ol>
					</div>

					<div class="card">
						<h2><span class="platform-icon">🤖</span> Android</h2>
						<p>DAVx5 アプリが必要です。</p>
						<ol>
							<li>
								DAVx5 をインストール (
								<a href="https://f-droid.org/packages/at.bitfire.davdroid/" target="_blank">F-Droid (無料)</a>
								{" / "}
								<a href="https://play.google.com/store/apps/details?id=at.bitfire.davdroid" target="_blank">Google Play</a>
								)
							</li>
							<li>「+」→「URL とユーザー名でログイン」</li>
							<li>ベース URL: <code>{serverUrl}</code></li>
							<li>ユーザー名: <code>{userEmail}</code></li>
							<li>パスワード: Dashboard で生成した App Password</li>
							<li>同期するカレンダーを選択</li>
						</ol>
						<div class="info-box">
							<p>Tasks.org アプリで VTODO の同期もできます。</p>
						</div>
					</div>

					<div class="card">
						<h2><span class="platform-icon">⚡</span> Thunderbird</h2>
						<p>カレンダー URL を直接入力します。</p>
						<ol>
							<li>Thunderbird →「カレンダー」タブ</li>
							<li>「新しいカレンダー」→「ネットワーク上のカレンダー」</li>
							<li>URL: <code>{serverUrl}</code></li>
							<li>ユーザー名: <code>{userEmail}</code></li>
							<li>パスワード: Dashboard で生成した App Password</li>
						</ol>
					</div>

					<div class="card">
						<h2>接続情報</h2>
						<table style="width:100%;border-collapse:collapse;">
							<tbody>
								<tr style="border-bottom:1px solid #eee;">
									<td style="padding:0.5rem;color:#666;">サーバー URL</td>
									<td style="padding:0.5rem;"><code>{serverUrl}</code></td>
								</tr>
								<tr style="border-bottom:1px solid #eee;">
									<td style="padding:0.5rem;color:#666;">Principal URL</td>
									<td style="padding:0.5rem;"><code>/dav/principals/{userEmail}/</code></td>
								</tr>
								<tr style="border-bottom:1px solid #eee;">
									<td style="padding:0.5rem;color:#666;">ユーザー名</td>
									<td style="padding:0.5rem;"><code>{userEmail}</code></td>
								</tr>
								<tr>
									<td style="padding:0.5rem;color:#666;">パスワード</td>
									<td style="padding:0.5rem;">Dashboard で生成した App Password</td>
								</tr>
							</tbody>
						</table>
					</div>
				</div>
			</body>
		</html>
	);
};
