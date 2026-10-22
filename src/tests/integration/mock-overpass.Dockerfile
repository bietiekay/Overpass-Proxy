FROM node:26-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY src ./src
CMD ["./node_modules/.bin/tsx", "src/tests/integration/mock-overpass.ts"]
