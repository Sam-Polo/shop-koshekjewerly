FROM node:20-alpine

# apk upgrade подтягивает пропатченные OS-пакеты (libssl/libcrypto/musl/zlib) —
# база node:20-alpine отстаёт от alpine-репо по CVE.
# ffmpeg из apk — ~50MB, но маленький образ → быстрый cold start
RUN apk upgrade --no-cache && apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev --ignore-scripts
COPY index.js .

EXPOSE 8080
CMD ["node", "index.js"]
