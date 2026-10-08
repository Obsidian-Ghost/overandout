# overandout-relay: public-mode relay for remote agents. State lives in /data (mount a volume).
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
VOLUME /data
EXPOSE 7777
ENV NODE_ENV=production
# Admin token: pass OVERANDOUT_ADMIN_TOKEN, or let the relay generate one into /data/admin.token (see logs).
CMD ["node", "src/cli.ts", "serve", "--host", "0.0.0.0", "--public", "--db", "/data/overandout.db", "--contracts", "/data/contracts"]
