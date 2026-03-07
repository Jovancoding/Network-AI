# network-ai MCP server
# Exposes the network-ai-server binary over HTTP/SSE on port 3001.
#
# Build:
#   docker build -t network-ai .
#
# Run:
#   docker run -p 3001:3001 network-ai
#
# Connect any MCP client to http://localhost:3001

FROM node:20-alpine@sha256:b88333c42c23fbd91596ebd7fd10de239cedab9617de04142dde7315e3bc0afa AS builder

WORKDIR /app

# Install dependencies (production + dev needed for tsc)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine@sha256:b88333c42c23fbd91596ebd7fd10de239cedab9617de04142dde7315e3bc0afa

WORKDIR /app

# Only production deps in the final image
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

# Blackboard data directory
RUN mkdir -p /app/data

EXPOSE 3001

ENV PORT=3001

CMD ["node", "dist/bin/mcp-server.js", "--port", "3001"]
