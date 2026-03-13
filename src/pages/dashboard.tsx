import type { FC } from "hono/jsx";
import { html } from "hono/html";

type AppPassword = {
	id: string;
	name: string;
	prefix: string;
	created_at: string;
	last_used_at: string | null;
};

const PasswordRow: FC<{ pw: AppPassword }> = ({ pw }) => (
	<tr id={`pw-${pw.id}`}>
		<td>{pw.name}</td>
		<td>{pw.prefix}****</td>
		<td>{pw.created_at}</td>
		<td>{pw.last_used_at ?? "-"}</td>
		<td>
			<button
				class="btn-revoke"
				hx-post={`/api/app-passwords/${pw.id}/revoke`}
				hx-target={`#pw-${pw.id}`}
				hx-swap="outerHTML"
				hx-confirm="この App Password を無効にしますか？"
			>
				Revoke
			</button>
		</td>
	</tr>
);

export const PasswordList: FC<{ passwords: AppPassword[] }> = ({
	passwords,
}) => (
	<>
		{passwords.map((pw) => (
			<PasswordRow pw={pw} />
		))}
	</>
);

const DashboardPage: FC<{
	userName: string;
	userEmail: string;
	passwords: AppPassword[];
}> = ({ userName, userEmail, passwords }) => (
	<html lang="ja">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<title>Dashboard - CalDAV</title>
			<script
				src="https://unpkg.com/htmx.org@2.0.4"
				integrity="sha384-HGfztofotfshcF7+8n44JQL2oJmowVChPTg48S+jvZoztPfvwD79OC/LTtG6dMp+"
				crossorigin="anonymous"
			/>
			<style>{`
				body {
					font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
					max-width: 800px;
					margin: 0 auto;
					padding: 2rem;
					background: #f5f5f5;
				}
				.header {
					display: flex;
					justify-content: space-between;
					align-items: center;
					margin-bottom: 2rem;
				}
				.card {
					background: white;
					border-radius: 12px;
					padding: 1.5rem;
					box-shadow: 0 2px 8px rgba(0,0,0,0.1);
					margin-bottom: 1.5rem;
				}
				table { width: 100%; border-collapse: collapse; }
				th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #eee; }
				th { font-weight: 600; color: #666; }
				.btn {
					padding: 0.5rem 1rem;
					border: none;
					border-radius: 6px;
					cursor: pointer;
					font-size: 0.9rem;
				}
				.btn-primary { background: #4285f4; color: white; }
				.btn-primary:hover { background: #3367d6; }
				.btn-danger { background: #dc3545; color: white; }
				.btn-danger:hover { background: #c82333; }
				.btn-revoke { background: #dc3545; color: white; border: none; padding: 0.4rem 0.8rem; border-radius: 4px; cursor: pointer; }
				.btn-revoke:hover { background: #c82333; }
				.btn-logout { background: none; border: 1px solid #ccc; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; }
				.btn-logout:hover { background: #eee; }
				.form-group { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
				.form-group input { flex: 1; padding: 0.5rem; border: 1px solid #ddd; border-radius: 6px; }
				.new-password {
					background: #e8f5e9;
					padding: 1rem;
					border-radius: 8px;
					margin-top: 1rem;
					word-break: break-all;
					font-family: monospace;
					font-size: 1.1rem;
				}
				.info { color: #666; font-size: 0.85rem; margin-top: 0.5rem; }
				.caldav-info {
					background: #e3f2fd;
					padding: 1rem;
					border-radius: 8px;
					margin-bottom: 1rem;
				}
				.caldav-info code {
					background: #bbdefb;
					padding: 0.15rem 0.3rem;
					border-radius: 3px;
				}
			`}</style>
		</head>
		<body>
			<div class="header">
				<div>
					<h1>CalDAV Dashboard</h1>
					<p style="color: #666; margin: 0">
						{userName} ({userEmail})
					</p>
				</div>
				<button class="btn-logout" id="logout-btn">
					ログアウト
				</button>
			</div>

			<div class="card">
				<h2>CalDAV 接続情報</h2>
				<div class="caldav-info">
					<p>
						<strong>サーバー URL:</strong>{" "}
						<code>/dav/projects/</code>
					</p>
					<p>
						<strong>ユーザー名:</strong> <code>{userEmail}</code>
					</p>
					<p>
						<strong>パスワード:</strong> 下記で生成した App Password
					</p>
				</div>
			</div>

			<div class="card">
				<h2>App Passwords</h2>

				<button
					class="btn btn-primary"
					hx-post="/api/app-passwords"
					hx-target="#generated-password"
					hx-swap="innerHTML"
				>
					新しい App Password を生成
				</button>

				<div id="generated-password" />

				<table>
					<thead>
						<tr>
							<th>名前</th>
							<th>Prefix</th>
							<th>作成日</th>
							<th>最終使用</th>
							<th />
						</tr>
					</thead>
					<tbody id="password-list">
						<PasswordList passwords={passwords} />
					</tbody>
				</table>
			</div>

			{html`
				<script>
					document.getElementById('logout-btn').addEventListener('click', async () => {
						await fetch('/api/auth/sign-out', { method: 'POST' });
						window.location.href = '/login';
					});
				</script>
			`}
		</body>
	</html>
);

export default DashboardPage;
