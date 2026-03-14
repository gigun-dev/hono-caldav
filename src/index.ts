import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { printEnvVerification } from './env.js'
import gmailRoute from './routes/gmail.js'
import cronRoute from './routes/cron.js'

const REQUIRED_ENV = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'OPENAI_API_KEY',
  'WEBHOOK_URL',
]

if (!printEnvVerification(REQUIRED_ENV)) {
  console.error('必須の環境変数が不足しています。.dev.vars または .env を確認してください。')
  process.exit(1)
}

const app = new Hono()

app.get('/health', c => c.json({ status: 'ok' }))
app.route('/gmail', gmailRoute)
app.route('/cron', cronRoute)

const port = Number(process.env.PORT) || 3000
console.log(`サーバー起動中: http://localhost:${port}`)

serve({ fetch: app.fetch, port })
