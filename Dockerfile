# ─────────────────────────────────────────────────────────────────────────────
# VIP Product Studio — MVP-01
#
# Ứng dụng chỉ cần Node và rất ít phụ thuộc runtime (chỉ `pg`, và chỉ khi dùng
# PostgreSQL). Nhờ vậy image nhỏ và không cần biên dịch native module.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
# Bỏ qua postinstall script của dependency để giảm bề mặt tấn công chuỗi cung ứng.
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts || npm install --omit=dev --no-audit --no-fund --ignore-scripts

# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_DRIVER=sqlite \
    SQLITE_PATH=/data/studio.db

WORKDIR /app

# Chạy bằng user không phải root.
RUN addgroup -g 10001 -S studio && adduser -u 10001 -S studio -G studio

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY tools ./tools
COPY docs ./docs
COPY README.md ./

RUN mkdir -p /data && chown -R studio:studio /data /app

USER studio

EXPOSE 3000

# Healthcheck gọi chính API health — không chỉ kiểm cổng mở.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
