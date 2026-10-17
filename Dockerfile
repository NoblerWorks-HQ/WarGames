# Read-only demo: serves the built UI and the saved games in ./demo-games. No API keys, no model calls.
#   docker build -t wargames-demo .
#   docker run -p 3001:3001 wargames-demo
# Put the games to show in demo-games/ (copy them from games/ or games/tournaments/<id>/) before building.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV READ_ONLY=1 HOST=0.0.0.0 PORT=3001 GAMES_DIR=/app/demo-games
EXPOSE 3001
USER node
CMD ["npx", "tsx", "server/index.ts"]
