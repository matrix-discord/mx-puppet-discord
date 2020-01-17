#!/bin/sh -e

if [ ! -f '/config/config.yaml' ]; then
	echo 'No config found'
    echo
    echo "Be sure to mount a config volume with \`-v /your/local/path:/config'."
	exit 1
fi

args="$@"

if [ ! -f '/config/registration.yaml' ]; then
	echo 'No registration found, generating now'
    args="-r"
fi

exec /usr/local/bin/node '/opt/mx-puppet-discord/build/index.js' \
     -c '/config/config.yaml' \
     -f '/config/registration.yaml' \
     $args
