FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production=false
COPY src/tests/integration/mock-overpass.ts ./mock-overpass.ts
CMD ["node", "mock-overpass.ts"]
