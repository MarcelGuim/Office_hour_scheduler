# Base image: Node.js 24 on Alpine Linux (small, so the image builds and pulls faster)
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# Copy only the dependency list first: Docker caches this layer, so dependencies are
# reinstalled only when package.json or package-lock.json change, not on every code edit
COPY package.json package-lock.json ./
# Install the exact versions from the lock file, without development tools (smaller image)
RUN npm ci --omit=dev
# Application code: SQL migrations, scripts (migration runner, seeding), backend, frontend
COPY migrations ./migrations
COPY scripts ./scripts
COPY src ./src
COPY public ./public
# Run as the unprivileged "node" user instead of root (security)
USER node
EXPOSE 8080
# Default command starts the API. The same image also runs the migration Job,
# which replaces this command with "node scripts/migrate.js"
CMD ["node", "src/server.js"]
