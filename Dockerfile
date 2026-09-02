# Stage 1: Build frontend
FROM node:20-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Go binary (static, works on any Linux: glibc/musl)
FROM golang:1.25-bookworm AS backend
ARG TARGETARCH
WORKDIR /app
COPY go.mod ./
COPY go.sum* ./
COPY . .
RUN go mod tidy
COPY --from=frontend /app/dist/ ./dist/
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -ldflags="-s -w -X main.version=${VERSION}" -o telemt-panel .

# Stage 3: Runtime image
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=backend /app/telemt-panel /usr/local/bin/
EXPOSE 8080
ENTRYPOINT ["telemt-panel"]
CMD ["--config", "/etc/telemt-panel/config.toml"]
