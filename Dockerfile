FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY monitor.mjs parser.mjs sources.mjs ./
ENV TZ=Asia/Seoul NODE_ENV=production
CMD ["node", "monitor.mjs"]
