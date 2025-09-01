# syntax=docker/dockerfile:1
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 8080
CMD ["npm","start"]
