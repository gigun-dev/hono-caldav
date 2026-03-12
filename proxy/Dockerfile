# MKCALENDAR 書き換え proxy for Cloud Run
FROM oven/bun:1-alpine

WORKDIR /app
# リポジトリルートから: docker build -f proxy/Dockerfile .
COPY proxy/dev.ts .

ENV PORT=8080
EXPOSE 8080

# WRANGLER_URL は Cloud Run の環境変数で設定する
CMD ["bun", "run", "dev.ts"]
