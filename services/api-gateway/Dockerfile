# syntax=docker/dockerfile:1
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser
EXPOSE 8080
CMD ["npm","start"]