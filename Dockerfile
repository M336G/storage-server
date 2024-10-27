FROM node:20.18.0

LABEL name="storage-server"

ENV NODE_ENV=production

# Token (optional, but extremely recommended to set one)
ENV TOKEN=AAAABBBBCCCCDDDD
# Port on which the express app will run. (default to 3033)
ENV PORT=3033

# Amount of maximum requests allowed from the same IP address per minute. (optional)
ENV RATE_LIMIT=500
# Useful if you run this application behind a reverse proxy. (optional)
ENV TRUST_PROXY=0


RUN apt-get update -y && apt-get install -y git
WORKDIR /app

# Auto-update
ARG BRANCH=main
ARG GITHUB_TOKEN=YOUR_GITHUB_TOKEN
RUN git clone --branch ${BRANCH} https://${GITHUB_TOKEN}:${GITHUB_TOKEN}@github.com/M336G/storage-server.git . || (git fetch origin && git reset --hard origin/${BRANCH})

RUN rm -rf package-lock.json
RUN npm install --omit=dev --production

ENTRYPOINT ["node"]
CMD ["app.js"]