import type { FC } from "hono/jsx";
import { html } from "hono/html";

const LoginPage: FC = () => (
	<html lang="ja">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<title>Login - CalDAV</title>
			<style>{`
				body {
					font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
					display: flex;
					justify-content: center;
					align-items: center;
					min-height: 100vh;
					margin: 0;
					background: #f5f5f5;
				}
				.card {
					background: white;
					border-radius: 12px;
					padding: 2rem;
					box-shadow: 0 2px 8px rgba(0,0,0,0.1);
					text-align: center;
					max-width: 400px;
					width: 90%;
				}
				h1 { margin-bottom: 0.5rem; }
				p { color: #666; margin-bottom: 1.5rem; }
				.btn {
					display: inline-flex;
					align-items: center;
					justify-content: center;
					gap: 0.5rem;
					padding: 0.75rem 1.5rem;
					color: white;
					border: none;
					border-radius: 8px;
					font-size: 1rem;
					cursor: pointer;
					width: 100%;
					text-decoration: none;
					box-sizing: border-box;
				}
				.btn-google { background: #4285f4; }
				.btn-google:hover { background: #3367d6; }
				.btn-demo {
					background: #6c757d;
					margin-top: 0;
				}
				.btn-demo:hover { background: #545b62; }
				.divider {
					display: flex;
					align-items: center;
					margin: 1.5rem 0;
					color: #999;
					font-size: 0.85rem;
				}
				.divider::before, .divider::after {
					content: '';
					flex: 1;
					border-bottom: 1px solid #ddd;
				}
				.divider::before { margin-right: 0.5rem; }
				.divider::after { margin-left: 0.5rem; }
			`}</style>
		</head>
		<body>
			<div class="card">
				<h1>CalDAV Server</h1>
				<p>ログインして App Password を管理</p>

				<button class="btn btn-google" id="google-btn">
					Google でログイン
				</button>

				<div class="divider">or</div>
				<a href="/demo" class="btn btn-demo">
					デモを試す（ログイン不要）
				</a>
			</div>
			{html`
				<script>
					document.getElementById('google-btn').addEventListener('click', async () => {
						const res = await fetch('/api/auth/sign-in/social', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								provider: 'google',
								callbackURL: '/dashboard',
							}),
						});
						const data = await res.json();
						if (data.url) {
							window.location.href = data.url;
						}
					});
				</script>
			`}
		</body>
	</html>
);

export default LoginPage;
