# Build stage: compile TypeScript with the full dev toolchain.
FROM node:25-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# Runtime stage: production dependencies, compiled output, schema and static dashboard only.
FROM node:25-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY db ./db
COPY public ./public
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
