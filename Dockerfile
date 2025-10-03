FROM docker.io/oven/bun AS builder
WORKDIR /app

# Install dependencies
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# Copy sources
COPY src ./src

# Build executable
RUN bun build --compile --minify --sourcemap --outfile bot src/index.ts

FROM docker.io/debian:12-slim
ENV NODE_ENV=production
COPY --from=builder /app/bot /usr/local/bin/bot
VOLUME [ "/var/lib/bot" ]
WORKDIR /var/lib/bot
ENTRYPOINT ["/usr/local/bin/bot"]
