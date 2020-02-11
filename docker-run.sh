#!/bin/sh -e

if [ ! -f "$CONFIG_PATH" ]; then
	echo 'No config found'
	exit 1
fi

args="$@"

if [ ! -f "$REGISTRATION_PATH" ]; then
	echo 'No registration found, generating now'
	args="-r"
fi

exec /usr/local/bin/node '/opt/mx-puppet-discord/build/index.js' \
     -c "$CONFIG_PATH" \
     -f "$REGISTRATION_PATH" \
     $args
