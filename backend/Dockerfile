FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY migrations ./migrations
COPY scripts ./scripts
COPY src ./src
COPY public ./public

USER node
EXPOSE 8080
# The same image runs the API (default) and the migration Job (command override).
CMD ["node", "src/server.js"]
