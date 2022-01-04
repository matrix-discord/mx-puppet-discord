/* eslint-disable */
type ValueOf<T> = T[keyof T];

declare module 'better-discord.js' {
	export interface MessageOptions {
		messageReference?: { channel_id: string, message_id: string }
	}
}
