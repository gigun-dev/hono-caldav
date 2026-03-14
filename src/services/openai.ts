import OpenAI from 'openai'
import type { ExtractionResult } from '../types.js'

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return _client
}

const SYSTEM_PROMPT = `あなたはメールの本文から予定・スケジュール情報を抽出するアシスタントです。

メールの件名と本文を受け取り、以下のJSON形式で予定を抽出してください。
予定が含まれていない場合は hasSchedule を false にしてください。

出力形式（JSONのみ、説明文なし）:
{
  "hasSchedule": true,
  "events": [
    {
      "title": "予定のタイトル",
      "date": "YYYY-MM-DD",
      "time": "HH:mm",
      "endTime": "HH:mm",
      "location": "場所（任意）",
      "description": "予定の詳細説明"
    }
  ]
}

ルール:
- date は必須。time, endTime, location は不明な場合は省略してください。
- 複数の予定が含まれる場合はすべて抽出してください。
- 予定が含まれない場合: { "hasSchedule": false, "events": [] }
- 日付が相対表現（「来週月曜」等）の場合は具体的な日付に変換しないでそのまま文字列で記載してください。`

export async function extractSchedule(
  subject: string,
  body: string,
): Promise<ExtractionResult> {
  const client = getClient()

  const userMessage = `件名: ${subject}\n\n本文:\n${body.slice(0, 4000)}`

  try {
    const res = await client.chat.completions.create({
      model: 'gpt-4.1-nano',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    })

    const content = res.choices[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(content) as ExtractionResult

    return {
      hasSchedule: Boolean(parsed.hasSchedule),
      events: Array.isArray(parsed.events) ? parsed.events : [],
    }
  } catch (err) {
    console.error('[openai] 抽出エラー:', err)
    return { hasSchedule: false, events: [] }
  }
}
