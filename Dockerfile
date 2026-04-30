FROM docker.io/oven/bun:1.3-alpine AS builder
WORKDIR /app

# Ensure timezones work in SQLite
RUN apk --no-cache add tzdata

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy sources
COPY drizzle ./drizzle
COPY src ./src

ENV NODE_ENV=production
ENV TZ=America/Indianapolis
ENV LANG=en_US.UTF-8

VOLUME [ "/var/lib/bot" ]
WORKDIR /var/lib/bot

ENTRYPOINT ["bun", "run", "-b", "/app/src/main.ts"]
