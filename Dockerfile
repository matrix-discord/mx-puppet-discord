FROM node:latest AS builder

WORKDIR /opt/mx-puppet-discord
RUN adduser --disabled-password --gecos '' builder \
 && chown builder:builder .
USER builder

COPY package.json package-lock.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build


FROM node:alpine

VOLUME ["/data"]

RUN adduser -D -g '' bridge

WORKDIR /opt/mx-puppet-discord

COPY docker-run.sh ./
COPY --from=builder /opt/mx-puppet-discord/node_modules/ ./node_modules/
COPY --from=builder /opt/mx-puppet-discord/build/ ./build/

ENTRYPOINT ["./docker-run.sh"]