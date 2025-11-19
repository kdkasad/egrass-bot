FROM docker.io/oven/bun:1.3-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# Copy sources
COPY src ./src

ENV NODE_ENV=production
ENV TZ=America/Indianapolis

VOLUME [ "/var/lib/bot" ]
WORKDIR /var/lib/bot

ENTRYPOINT ["bun", "run", "/app/src/index.ts"]
