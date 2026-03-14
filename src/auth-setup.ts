import http from 'http';
import { google } from 'googleapis';
import { printEnvVerification } from './env';

// 起動時に .env / .dev.vars の読み込みを検証
const requiredEnvKeys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
if (!printEnvVerification(requiredEnvKeys)) {
  console.error('必須の環境変数が不足しています。.dev.vars または .env を確認してください。');
  process.exit(1);
}

const redirectUri = process.env.REDIRECT_URI ?? 'http://localhost:8787';
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  redirectUri
);

const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];

const url = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: scopes,
  prompt: 'consent',
});

// ポート8080でリダイレクトを受け取るサーバーを起動（ペースト不要）
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', redirectUri);
  const code = u.searchParams.get('code');

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>code がありません</h1><p>ブラウザで認証URLから再度アクセスしてください。</p>');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<h1>認証完了</h1><p>このタブを閉じて、ターミナルに表示されたリフレッシュトークンを .dev.vars の GOOGLE_REFRESH_TOKEN にコピーしてください。</p>'
    );
    console.log('\n3. あなたのリフレッシュトークンはこれです（.dev.vars に貼ってください）:\n');
    console.log(tokens.refresh_token ?? '(なし)');
    console.log('');
    server.close();
    process.exit(0);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>エラー</h1><pre>' + String(e) + '</pre>');
  }
});

const PORT = 8080;

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nポート ${PORT} は既に使用中です。`);
    console.error('前回のプロセスが残っている可能性があります。');
    console.error('\n解放するには（PowerShell）:');
    console.error(`  Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`);
    console.error('\nまたはタスクマネージャーで「Node.js」を終了してから再度実行してください。\n');
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('1. ブラウザでこのURLを開いてください:', url);
  console.log('2. 認証後、この画面に戻ってくれば自動でコードを受け取ります（ペースト不要）\n');
});