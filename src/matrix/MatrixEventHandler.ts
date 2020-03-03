/* tslint:disable: no-any */
/*
Copyright 2019, 2020 mx-puppet-discord
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import { IRemoteRoom, IMessageEvent, ISendingUser, IFileEvent, Util } from "mx-puppet-bridge";
import { App, IDiscordSendFile, MAXFILESIZE, AVATAR_SETTINGS } from "../app";
import * as Discord from "better-discord.js";

export class MatrixEventHandler {
	public constructor(private readonly app) {}

	public async handleMatrixMessage(room: IRemoteRoom, data: IMessageEvent, asUser: ISendingUser | null, event: any) {
		const p = this.app.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.app.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			App.log.warn("Channel not found", room);
			return;
		}

		const sendMsg = await this.app.matrix.parseMatrixMessage(room.puppetId, event.content);
		const lockKey = `${room.puppetId};${chan.id}`;
		this.app.messageDeduplicator.lock(lockKey, p.client.user!.id, sendMsg);
		try {
			const reply = await this.app.sendToDiscord(chan, sendMsg, asUser);
			await this.app.matrix.insertNewEventId(room.puppetId, data.eventId!, reply);
		} catch (err) {
			App.log.warn("Couldn't send message", err);
			this.app.messageDeduplicator.unlock(lockKey);
			await this.app.matrix.sendMessageFail(room);
		}
	}

	public async handleMatrixFile(room: IRemoteRoom, data: IFileEvent, asUser: ISendingUser | null, event: any) {
		const p = this.app.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.app.discord.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			App.log.warn("Channel not found", room);
			return;
		}

		let size = data.info ? data.info.size || 0 : 0;
		const mimetype = data.info ? data.info.mimetype || "" : "";
		const lockKey = `${room.puppetId};${chan.id}`;
		const isImage = Boolean(mimetype && mimetype.split("/")[0] === "image");
		if (size < MAXFILESIZE) {
			const buffer = await Util.DownloadFile(data.url);
			size = buffer.byteLength;
			if (size < MAXFILESIZE) {
				// send as attachment
				const filename = this.app.getFilenameForMedia(data.filename, mimetype);
				this.app.messageDeduplicator.lock(lockKey, p.client.user!.id, `file:${filename}`);
				try {
					const sendFile: IDiscordSendFile = {
						buffer,
						filename,
						url: data.url,
						isImage,
					};
					const reply = await this.app.discord.sendToDiscord(chan, sendFile, asUser);
					await this.app.matrix.insertNewEventId(room.puppetId, data.eventId!, reply);
					return;
				} catch (err) {
					this.app.messageDeduplicator.unlock(lockKey);
					App.log.warn("Couldn't send media message, retrying as embed/url", err);
				}
			}
		}
		try {
			if (isImage && p.client.user!.bot) {
				const embed = new Discord.MessageEmbed()
					.setTitle(data.filename)
					.setImage(data.url);
				this.app.messageDeduplicator.lock(lockKey, p.client.user!.id, "");
				const reply = await this.app.discord.sendToDiscord(chan, embed, asUser);
				await this.app.matrix.insertNewEventId(room.puppetId, data.eventId!, reply);
			} else {
				const filename = await this.app.discord.discordEscape(data.filename);
				const msg = `Uploaded a file \`${filename}\`: ${data.url}`;
				this.app.messageDeduplicator.lock(lockKey, p.client.user!.id, msg);
				const reply = await this.app.discord.sendToDiscord(chan, msg, asUser);
				await this.app.matrix.insertNewEventId(room.puppetId, data.eventId!, reply);
			}
		} catch (err) {
			App.log.warn("Couldn't send media message", err);
			this.app.messageDeduplicator.unlock(lockKey);
			await this.app.matrix.sendMessageFail(room);
		}
	}

	public async handleMatrixRedact(room: IRemoteRoom, eventId: string, asUser: ISendingUser | null, event: any) {
		const p = this.app.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.app.discord.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			App.log.warn("Channel not foundp.client.user!.bot", room);
			return;
		}
		App.log.verbose(`Deleting message with ID ${eventId}...`);
		const msg = await chan.messages.fetch(eventId);
		if (!msg) {
			return;
		}
		try {
			p.deletedMessages.add(msg.id);
			await msg.delete();
			await this.app.puppet.eventStore.remove(room.puppetId, msg.id);
		} catch (err) {
			App.log.warn("Couldn't delete message", err);
		}
	}

	public async handleMatrixEdit(
		room: IRemoteRoom,
		eventId: string,
		data: IMessageEvent,
		asUser: ISendingUser | null,
		event: any,
	) {
		const p = this.app.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.app.discord.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			App.log.warn("Channel not found", room);
			return;
		}
		App.log.verbose(`Editing message with ID ${eventId}...`);
		const msg = await chan.messages.fetch(eventId);
		if (!msg) {
			return;
		}
		let sendMsg = await this.app.matrix.parseMatrixMessage(room.puppetId, event.content["m.new_content"]);
		const lockKey = `${room.puppetId};${chan.id}`;
		this.app.messageDeduplicator.lock(lockKey, p.client.user!.id, sendMsg);
		try {
			let reply: Discord.Message | Discord.Message[];
			let matrixEventId = data.eventId!;
			if (asUser) {
				// just re-send as new message
				if (eventId === this.app.lastEventIds[chan.id]) {
					try {
						p.deletedMessages.add(msg.id);
						const matrixEvents = await this.app.puppet.eventStore.getMatrix(room.puppetId, msg.id);
						if (matrixEvents.length > 0) {
							matrixEventId = matrixEvents[0];
						}
						await msg.delete();
						await this.app.puppet.eventStore.remove(room.puppetId, msg.id);
					} catch (err) {
						App.log.warn("Couldn't delete old message", err);
					}
				} else {
					sendMsg = `**EDIT:** ${sendMsg}`;
				}
				reply = await this.app.discord.sendToDiscord(chan, sendMsg, asUser);
			} else {
				reply = await msg.edit(sendMsg);
			}
			await this.app.matrix.insertNewEventId(room.puppetId, matrixEventId, reply);
		} catch (err) {
			App.log.warn("Couldn't edit message", err);
			this.app.messageDeduplicator.unlock(lockKey);
			await this.app.matrix.sendMessageFail(room);
		}
	}

	public async handleMatrixReply(
		room: IRemoteRoom,
		eventId: string,
		data: IMessageEvent,
		asUser: ISendingUser | null,
		event: any,
	) {
		const p = this.app.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.app.discord.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			App.log.warn("Channel not found", room);
			return;
		}
		App.log.verbose(`Replying to message with ID ${eventId}...`);
		const msg = await chan.messages.fetch(eventId);
		if (!msg) {
			return;
		}
		let sendMsg = await this.app.matrix.parseMatrixMessage(room.puppetId, event.content);
		let content = msg.content;
		if (!content && msg.embeds.length > 0) {
			content = msg.embeds[0].description;
		}
		const replyEmbed = new Discord.MessageEmbed()
			.setTimestamp(new Date(msg.createdAt))
			.setDescription(content)
			.setAuthor(msg.author.username, msg.author.avatarURL(AVATAR_SETTINGS) || undefined);
		if (msg.embeds && msg.embeds[0]) {
			const msgEmbed = msg.embeds[0];
			// if an author is set it wasn't an image embed thingy we send
			if (msgEmbed.image && !msgEmbed.author) {
				replyEmbed.setImage(msgEmbed.image.url);
			}
		}
		if (msg.attachments.first()) {
			const attach = msg.attachments.first();
			if (attach!.height) {
				// image!
				replyEmbed.setImage(attach!.proxyURL);
			} else {
				replyEmbed.description += `[${attach!.name}](${attach!.proxyURL})`;
			}
		}
		const lockKey = `${room.puppetId};${chan.id}`;
		try {
			let reply;
			if (p.client.user!.bot) {
				this.app.messageDeduplicator.lock(lockKey, p.client.user!.id, sendMsg);
				reply = await this.app.discord.sendToDiscord(chan, sendMsg, asUser, replyEmbed);
			} else {
				sendMsg += `\n>>> ${replyEmbed.description}`;
				this.app.messageDeduplicator.lock(lockKey, p.client.user!.id, sendMsg);
				reply = await this.app.discord.sendToDiscord(chan, sendMsg, asUser);
			}
			await this.app.matrix.insertNewEventId(room.puppetId, data.eventId!, reply);
		} catch (err) {
			App.log.warn("Couldn't send reply", err);
			this.app.messageDeduplicator.unlock(lockKey);
			await this.app.matrix.sendMessageFail(room);
		}
	}

	public async handleMatrixReaction(
		room: IRemoteRoom,
		eventId: string,
		reaction: string,
		asUser: ISendingUser | null,
		event: any,
	) {
		const p = this.app.puppets[room.puppetId];
		if (!p || asUser) {
			return;
		}
		const chan = await this.app.discord.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			App.log.warn("Channel not found", room);
			return;
		}
		App.log.verbose(`Reacting to ${eventId} with ${reaction}...`);
		const msg = await chan.messages.fetch(eventId);
		if (!msg) {
			return;
		}
		if (reaction.startsWith("mxc://")) {
			const emoji = await this.app.discord.getDiscordEmoji(p.client, reaction);
			if (emoji) {
				await msg.react(emoji);
			}
		} else {
			await msg.react(reaction);
		}
	}

	public async handleMatrixRemoveReaction(
		room: IRemoteRoom,
		eventId: string,
		reaction: string,
		asUser: ISendingUser | null,
		event: any,
	) {
		const p = this.app.puppets[room.puppetId];
		if (!p || asUser) {
			return;
		}
		const chan = await this.app.discord.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			App.log.warn("Channel not found", room);
			return;
		}
		App.log.verbose(`Removing reaction to ${eventId} with ${reaction}...`);
		const msg = await chan.messages.fetch(eventId);
		if (!msg) {
			return;
		}
		let emoji: Discord.Emoji | null = null;
		if (reaction.startsWith("mxc://")) {
			emoji = await this.app.discord.getDiscordEmoji(p.client, reaction);
		}
		for (const r of msg.reactions.array()) {
			if (r.emoji.name === reaction) {
				await r.remove();
				break;
			}
			if (emoji && emoji.id === r.emoji.id) {
				await r.remove();
				break;
			}
		}
	}
}
