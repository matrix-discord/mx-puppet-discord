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


# if no --uid is supplied, prepare files to drop privileges
if [ "$(id -u)" = 0 ]; then
	chown node:node /data

	if find *.db > /dev/null 2>&1; then
		# make sure sqlite files are writeable
		chown node:node *.db
	fi
	if find *.log.* > /dev/null 2>&1; then
		# make sure log files are writeable
		chown node:node *.log.*
	fi

	su_exec='su-exec node:node'
else
	su_exec=''
fi

# $su_exec is used in case we have to drop the privileges
exec $su_exec /usr/local/bin/node '/opt/mx-puppet-discord/build/index.js' \
     -c "$CONFIG_PATH" \
     -f "$REGISTRATION_PATH" \
     $args
