# Auto Code Review Viewer Dockerfile
FROM node:20-slim

# Install git for future enhancements that may require repository tooling
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

ENV NODE_ENV=production \
    SRC_DIR=/data \
    FILENAME=auto_code_review.md \
    PORT=3000

COPY app/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY app ./

EXPOSE 3000

CMD ["node", "server.js"]
