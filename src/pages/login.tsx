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
				.btn-google {
					display: inline-flex;
					align-items: center;
					gap: 0.5rem;
					padding: 0.75rem 1.5rem;
					background: #4285f4;
					color: white;
					border: none;
					border-radius: 8px;
					font-size: 1rem;
					cursor: pointer;
					text-decoration: none;
				}
				.btn-google:hover { background: #3367d6; }
			`}</style>
		</head>
		<body>
			<div class="card">
				<h1>CalDAV Server</h1>
				<p>Google アカウントでログインして App Password を管理</p>
				<button
					class="btn-google"
					id="login-btn"
				>
					Google でログイン
				</button>
			</div>
			{html`
				<script>
					document.getElementById('login-btn').addEventListener('click', async () => {
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
