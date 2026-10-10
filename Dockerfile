FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production STATIC_DIR=/app/web PORT=8788
COPY --from=build /app/build/server ./server
COPY --from=build /app/build/web ./web
COPY package.json ./
USER node
EXPOSE 8788
HEALTHCHECK CMD wget -qO- http://localhost:8788/api/health || exit 1
CMD ["node", "server/server/index.js"]
