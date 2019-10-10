FROM node:alpine

COPY . /opt/mx-puppet-discord
WORKDIR /opt/mx-puppet-discord
RUN apk add --no-cache ca-certificates \
	&& apk add --no-cache --virtual .build-deps git make gcc g++ python \
	&& npm install \
	&& npm run build \
	&& apk del .build-deps
VOLUME ["/data"]
ENTRYPOINT ["./docker-run.sh"]
