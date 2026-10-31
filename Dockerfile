FROM node:20-slim

WORKDIR /app

# Install native compilation dependencies for SQLite
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

# Ensure data directory exists for SQLite database
RUN mkdir -p /app/data

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "app.js"]
