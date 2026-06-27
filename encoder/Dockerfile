FROM node:20-alpine

# ffmpeg из apk — ~50MB, но маленький образ → быстрый cold start
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev --ignore-scripts
COPY index.js .

EXPOSE 8080
CMD ["node", "index.js"]
