FROM docker.io/oven/bun:1.3-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# Copy sources
COPY src ./src

# Build executable
RUN bun build --compile --sourcemap --outfile bot src/index.ts

FROM docker.io/alpine:3.22
# For some reason, Bun single-file executables targeting musl need libstdc++
RUN apk --no-cache add libstdc++
ENV NODE_ENV=production
ENV TZ=America/Indianapolis
COPY --from=builder /app/bot /usr/local/bin/bot
VOLUME [ "/var/lib/bot" ]
WORKDIR /var/lib/bot
ENTRYPOINT ["/usr/local/bin/bot"]
