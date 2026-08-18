FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

COPY schedule.mjs server.mjs ./

CMD ["node", "server.mjs"]
