import type { FC } from "hono/jsx";
import type { AppPassword } from "../auth/app-password.js";

type DashboardProps = {
	userName: string;
	userEmail: string;
	appPasswords: AppPassword[];
	newPassword?: string;
};

export const DashboardPage: FC<DashboardProps> = ({
	userName,
	userEmail,
	appPasswords,
	newPassword,
}) => {
	return (
		<html lang="ja">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Dashboard - CalDAV Task Manager</title>
				<script src="https://unpkg.com/htmx.org@2.0.4"></script>
				<style>{`
					* { margin: 0; padding: 0; box-sizing: border-box; }
					body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; padding: 1rem; }
					.container { max-width: 700px; margin: 0 auto; }
					.card { background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 1rem; }
					h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
					h2 { font-size: 1.2rem; margin-bottom: 1rem; }
					.subtitle { color: #666; margin-bottom: 1rem; }
					.new-pw { background: #e8f5e9; border: 1px solid #4caf50; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
					.new-pw code { font-size: 1.1rem; font-weight: bold; user-select: all; }
					.new-pw p { color: #2e7d32; font-size: 0.9rem; margin-top: 0.5rem; }
					table { width: 100%; border-collapse: collapse; }
					th, td { text-align: left; padding: 0.75rem 0.5rem; border-bottom: 1px solid #eee; }
					th { color: #666; font-weight: 500; font-size: 0.85rem; }
					.prefix { font-family: monospace; }
					.btn { border: none; border-radius: 6px; padding: 0.5rem 1rem; cursor: pointer; font-size: 0.9rem; }
					.btn-primary { background: #4285f4; color: white; }
					.btn-primary:hover { background: #3367d6; }
					.btn-danger { background: #f44336; color: white; font-size: 0.8rem; padding: 0.3rem 0.6rem; }
					.btn-danger:hover { background: #d32f2f; }
					.form-row { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
					.form-row input { flex: 1; padding: 0.5rem; border: 1px solid #ddd; border-radius: 6px; }
					.empty { color: #999; padding: 1rem 0; text-align: center; }
					.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
					.logout { color: #666; text-decoration: none; font-size: 0.9rem; }
					.logout:hover { color: #333; }
					.setup-info { background: #f0f7ff; border: 1px solid #bbdefb; border-radius: 8px; padding: 1rem; margin-top: 1rem; }
					.setup-info h3 { font-size: 1rem; margin-bottom: 0.5rem; }
					.setup-info p { font-size: 0.9rem; color: #555; margin-bottom: 0.25rem; }
					.setup-info code { background: #e3f2fd; padding: 0.15rem 0.3rem; border-radius: 3px; font-size: 0.85rem; }
				`}</style>
			</head>
			<body>
				<div class="container">
					<div class="card">
						<div class="header">
							<div>
								<h1>{userName}</h1>
								<p class="subtitle">{userEmail}</p>
							</div>
							<a
								href="#"
								class="logout"
								onclick="fetch('/api/auth/sign-out',{method:'POST'}).then(()=>location.href='/login')"
							>
								ログアウト
							</a>
						</div>
					</div>

					<div class="card">
						<h2>App Passwords</h2>
						<p class="subtitle">
							CalDAV クライアント (iOS リマインダー等) で使う認証パスワードを管理します
						</p>

						{newPassword && (
							<div class="new-pw">
								<p>新しい App Password が生成されました。この画面を閉じると二度と表示されません:</p>
								<code>{newPassword}</code>
								<p>ユーザー名: {userEmail}</p>
							</div>
						)}

						<form method="POST" action="/api/app-passwords">
							<div class="form-row">
								<input
									type="text"
									name="name"
									placeholder="ラベル (例: iOS Reminders)"
									required
								/>
								<button type="submit" class="btn btn-primary">
									生成
								</button>
							</div>
						</form>

						<div id="password-list">
							{appPasswords.length === 0 ? (
								<p class="empty">App Password はまだありません</p>
							) : (
								<table>
									<thead>
										<tr>
											<th>ラベル</th>
											<th>プレフィックス</th>
											<th>作成日</th>
											<th>最終使用</th>
											<th></th>
										</tr>
									</thead>
									<tbody>
										{appPasswords.map((pw) => (
											<tr>
												<td>{pw.name}</td>
												<td class="prefix">{pw.prefix}...</td>
												<td>{new Date(pw.createdAt).toLocaleDateString("ja-JP")}</td>
												<td>
													{pw.lastUsedAt
														? new Date(pw.lastUsedAt).toLocaleDateString("ja-JP")
														: "-"}
												</td>
												<td>
													<form method="POST" action={`/api/app-passwords/${pw.id}/revoke`} style="display:inline">
														<button type="submit" class="btn btn-danger">
															取消
														</button>
													</form>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							)}
						</div>

						<div class="setup-info">
							<h3>CalDAV クライアントの設定</h3>
							<p>サーバー URL: <code>/dav/</code></p>
							<p>ユーザー名: <code>{userEmail}</code></p>
							<p>パスワード: 上で生成した App Password</p>
						</div>
					</div>
				</div>
			</body>
		</html>
	);
};
