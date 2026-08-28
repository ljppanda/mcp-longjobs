# Runs the mcp-longjobs demo server over stdio. Used by Glama's registry
# checks (server must start and respond to introspection) and as a reference
# for deploying stdio MCP servers in containers.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Durable task/transfer state lives here; mount a volume to survive restarts.
VOLUME ["/app/state"]
CMD ["node", "dist/examples/report-generator.js"]
