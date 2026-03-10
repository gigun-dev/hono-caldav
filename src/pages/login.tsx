import type { FC } from "hono/jsx";

export const LoginPage: FC = () => {
	return (
		<html lang="ja">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Login - CalDAV Task Manager</title>
				<style>{`
					* { margin: 0; padding: 0; box-sizing: border-box; }
					body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
					.card { background: white; border-radius: 12px; padding: 2rem; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 400px; width: 100%; text-align: center; }
					h1 { margin-bottom: 0.5rem; font-size: 1.5rem; }
					p { color: #666; margin-bottom: 1.5rem; }
					.btn-google { display: inline-flex; align-items: center; gap: 0.5rem; background: #4285f4; color: white; border: none; border-radius: 8px; padding: 0.75rem 1.5rem; font-size: 1rem; cursor: pointer; transition: background 0.2s; }
					.btn-google:hover { background: #3367d6; }
				`}</style>
			</head>
			<body>
				<div class="card">
					<h1>CalDAV Task Manager</h1>
					<p>Google アカウントでログインしてください</p>
					<button
						class="btn-google"
						onclick={`
							fetch('/api/auth/sign-in/social', {
								method: 'POST',
								headers: {'Content-Type': 'application/json'},
								body: JSON.stringify({
									provider: 'google',
									callbackURL: '/dashboard'
								})
							})
							.then(r => r.json())
							.then(data => { if(data.url) window.location.href = data.url; })
							.catch(e => alert('ログインに失敗しました: ' + e.message))
						`}
					>
						Google でログイン
					</button>
				</div>
			</body>
		</html>
	);
};
