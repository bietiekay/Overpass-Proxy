ARG NPM_VERSION=11.7.0

FROM node:20-alpine AS builder
ARG NPM_VERSION
WORKDIR /app
RUN npm install -g "npm@${NPM_VERSION}"
COPY package.json package-lock.json* ./
RUN npm install --omit=optional
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
ARG NPM_VERSION
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g "npm@${NPM_VERSION}"
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --omit=optional
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
CMD ["node", "dist/index.js"]
