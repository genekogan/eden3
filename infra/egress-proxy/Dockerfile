FROM node:24-alpine

WORKDIR /app
COPY allowlist.mjs policy.mjs server.mjs ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# The proxy needs no root capabilities (D3 hardening).
USER node

CMD ["node", "server.mjs"]
