FROM node:latest AS builder

WORKDIR /opt/mx-puppet-discord

# run build process as user in case of npm pre hooks
# pre hooks are not executed while running as root
RUN chown node:node /opt/mx-puppet-discord
USER node

COPY package.json package-lock.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build


FROM node:alpine

VOLUME /data

ENV CONFIG_PATH=/data/config.yaml \
    REGISTRATION_PATH=/data/discord-registration.yaml

# su-exec is used by docker-run.sh to drop privileges
RUN apk add --no-cache su-exec

WORKDIR /opt/mx-puppet-discord
COPY docker-run.sh ./
COPY --from=builder /opt/mx-puppet-discord/node_modules/ ./node_modules/
COPY --from=builder /opt/mx-puppet-discord/build/ ./build/

# change workdir to /data so relative paths in the config.yaml
# point to the persisten volume
WORKDIR /data
ENTRYPOINT ["/opt/mx-puppet-discord/docker-run.sh"]
