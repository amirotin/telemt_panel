# Release binaries are verified and placed here by the container workflow.
FROM alpine:3.24.1
RUN apk add --no-cache ca-certificates \
    && mkdir -p /etc/telemt-panel /var/lib/telemt-panel \
    && chmod 0700 /etc/telemt-panel /var/lib/telemt-panel

ARG TARGETARCH
ARG VERSION
ARG SOURCE_REVISION
ARG BINARY_REVISION
LABEL org.opencontainers.image.source="https://github.com/amirotin/telemt_panel" \
      org.opencontainers.image.title="Telemt Panel" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.licenses="MIT" \
      io.telemt-panel.binary-revision="${BINARY_REVISION}"

COPY --chmod=0755 .container-bin/${TARGETARCH}/telemt-panel /usr/local/bin/telemt-panel
WORKDIR /var/lib/telemt-panel
EXPOSE 8080 8081
ENTRYPOINT ["/usr/local/bin/telemt-panel"]
CMD ["--config", "/etc/telemt-panel/config.toml"]
