FROM oven/bun:latest

# Metadata
LABEL name="storage-server" \
      version="1.0.0" \
      description="An easy to setup and optimized storing solution using Bun & Elysia."

# Environment variables
ENV NODE_ENV=production \
    HOSTNAME= \
    TOKEN= \
    PORT= \
    RATE_LIMIT= \
    BEHIND_PROXY=

# Install necessary system dependencies and clean up cache
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Clone from the GitHub repository
ARG BRANCH=main
RUN git clone --branch ${BRANCH} https://github.com/M336G/storage-server.git . && \
    git checkout ${BRANCH} && \
    rm -rf .git

# Install dependencies while skipping development dependencies
RUN rm -f package-lock.json bun.lockb && \
    bun install --omit=dev --production

# Set a non-root user for security (create one if needed)
RUN addgroup --system storagegroup && \
    adduser --system --ingroup storagegroup storageuser && \
    chown -R storageuser:storagegroup /app
USER storageuser
# NOTE: Make sure to allow the user "storageuser" to read and write on your mounted drives, if you have any!

# Expose the port for the application
EXPOSE 3033/tcp

# Entrypoint and command
ENTRYPOINT ["bun"]
CMD ["start"]
