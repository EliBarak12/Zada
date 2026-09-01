FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY web ./web
ENV PORT=4977
EXPOSE 4977
VOLUME /app/data
CMD ["node", "server/index.mjs"]
