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

import {
	PuppetBridge,
	Log,
	IReceiveParams,
	IRemoteRoom,
	IRemoteUser,
	IRemoteUserRoomOverride,
	IRemoteGroup,
	IMessageEvent,
	IFileEvent,
	Util,
	IRetList,
	MessageDeduplicator,
	SendMessageFn,
	IStringFormatterVars,
	ISendingUser,
	ExpireSet,
} from "mx-puppet-bridge";
import * as Discord from "better-discord.js";
import {
	IDiscordMessageParserOpts,
	DiscordMessageParser,
	IMatrixMessageParserOpts,
	MatrixMessageParser,
	IDiscordMessageParserCallbacks,
} from "matrix-discord-parser";
import * as path from "path";
import * as mime from "mime";
import { DiscordStore } from "./store";
import * as escapeHtml from "escape-html";

const log = new Log("DiscordPuppet:Discord");

const MAXFILESIZE = 8000000;
const MAX_MSG_SIZE = 4000;

const AVATAR_SETTINGS: Discord.ImageURLOptions & { dynamic?: boolean | undefined; }
	= { format: "png", size: 2048, dynamic: true };

interface IDiscordPuppet {
	client: Discord.Client;
	data: any;
	deletedMessages: ExpireSet<string>;
}

interface IDiscordPuppets {
	[puppetId: number]: IDiscordPuppet;
}

interface IDiscordSendFile {
	buffer: Buffer;
	filename: string;
	url: string;
	isImage: boolean;
}

export class DiscordClass {
	private puppets: IDiscordPuppets = {};
	private discordMsgParser: DiscordMessageParser;
	private matrixMsgParser: MatrixMessageParser;
	private messageDeduplicator: MessageDeduplicator;
	private store: DiscordStore;
	private lastEventIds: {[chan: string]: string} = {};
	constructor(
		private puppet: PuppetBridge,
	) {
		this.discordMsgParser = new DiscordMessageParser();
		this.matrixMsgParser = new MatrixMessageParser();
		this.messageDeduplicator = new MessageDeduplicator();
		this.store = new DiscordStore(puppet.store);
	}

	public async init(): Promise<void> {
		await this.store.init();
	}

	public getRemoteUserRoomOverride(member: Discord.GuildMember, chan: Discord.Channel): IRemoteUserRoomOverride {
		const nameVars: IStringFormatterVars = {
			name: member.user.username,
			discriminator: member.user.discriminator,
			displayname: member.displayName,
		};
		if (chan instanceof Discord.TextChannel) {
			nameVars.channel = chan.name;
			nameVars.guild = chan.guild.name;
		}
		return {
			nameVars,
		};
	}

	public getRemoteUser(
		puppetId: number,
		userOrMember: Discord.User | Discord.GuildMember,
		isWebhook: boolean = false,
		chan?: Discord.TextChannel,
	): IRemoteUser {
		let user: Discord.User;
		let member: Discord.GuildMember | null = null;
		if (userOrMember instanceof Discord.GuildMember) {
			member = userOrMember;
			user = member.user;
		} else {
			user = userOrMember;
		}
		const nameVars: IStringFormatterVars = {
			name: user.username,
			discriminator: user.discriminator,
		};
		const response: IRemoteUser = {
			userId: isWebhook ? `webhook-${user.id}-${user.username}` : user.id,
			puppetId,
			avatarUrl: user.avatarURL(AVATAR_SETTINGS),
			nameVars,
		};
		if (member) {
			response.roomOverrides = {};
			if (chan) {
				response.roomOverrides[chan.id] = this.getRemoteUserRoomOverride(member, chan);
			} else {
				for (const [, gchan] of member.guild.channels) {
					if (gchan.type === "text") {
						response.roomOverrides[gchan.id] = this.getRemoteUserRoomOverride(member, gchan);
					}
				}
			}
		}
		return response;
	}

	public getRemoteRoom(puppetId: number, channel: Discord.Channel): IRemoteRoom {
		let roomId = channel.id;
		if (channel instanceof Discord.DMChannel) {
			roomId = `dm-${channel.recipient.id}`;
		}
		const ret: IRemoteRoom = {
			roomId,
			puppetId,
			isDirect: channel.type === "dm",
		};
		if (channel instanceof Discord.GroupDMChannel) {
			ret.nameVars = {
				name: channel.name,
			};
			ret.avatarUrl = channel.iconURL(AVATAR_SETTINGS);
		}
		if (channel instanceof Discord.TextChannel) {
			ret.nameVars = {
				name: channel.name,
				guild: channel.guild.name,
			};
			ret.avatarUrl = channel.guild.iconURL(AVATAR_SETTINGS);
			ret.groupId = channel.guild.id;
			ret.topic = channel.topic;
		}
		return ret;
	}

	public async getRemoteRoomById(puppetId: number, id: string): Promise<IRemoteRoom | null> {
		const p = this.puppets[puppetId];
		if (!p) {
			return null;
		}
		const chan = await this.getDiscordChan(p.client, id);
		if (!chan) {
			return null;
		}
		return this.getRemoteRoom(puppetId, chan);
	}

	public async getRemoteGroup(puppetId: number, guild: Discord.Guild): Promise<IRemoteGroup> {
		const roomIds: string[] = [];
		let description = `<h1>${escapeHtml(guild.name)}</h1>`;
		description += `<h2>Channels:</h2><ul>`;
		await this.iterateGuildStructure(puppetId, guild,
			async (cat: Discord.CategoryChannel) => {
				const name = escapeHtml(cat.name);
				description += `</ul><h3>${name}</h3><ul>`;
			},
			async (chan: Discord.TextChannel) => {
				roomIds.push(chan.id);
				const mxid = await this.puppet.getMxidForRoom({
					puppetId,
					roomId: chan.id,
				});
				const url = "https://matrix.to/#/" + mxid;
				const name = escapeHtml(chan.name);
				description += `<li>${name}: <a href="${url}">${name}</a></li>`;
			},
		);
		description += "</ul>";
		return {
			puppetId,
			groupId: guild.id,
			nameVars: {
				name: guild.name,
			},
			avatarUrl: guild.iconURL(AVATAR_SETTINGS),
			roomIds,
			longDescription: description,
		};
	}

	public getSendParams(
		puppetId: number,
		msgOrChannel: Discord.Message | Discord.Channel,
		user?: Discord.User | Discord.GuildMember,
	): IReceiveParams {
		let channel: Discord.Channel;
		let eventId: string | undefined;
		let externalUrl: string | undefined;
		let isWebhook = false;
		let textChannel: Discord.TextChannel | undefined;
		if (!user) {
			const msg = msgOrChannel as Discord.Message;
			channel = msg.channel;
			user = msg.member || msg.author;
			eventId = msg.id;
			isWebhook = msg.webhookID ? true : false;
			if (channel instanceof Discord.TextChannel) {
				textChannel = channel;
				externalUrl = `https://discordapp.com/channels/${channel.guild.id}/${channel.id}/${eventId}`;
			} else if (["group", "dm"].includes(channel.type)) {
				externalUrl = `https://discordapp.com/channels/@me/${channel.id}/${eventId}`;
			}
		} else {
			channel = msgOrChannel as Discord.Channel;
		}
		return {
			room: this.getRemoteRoom(puppetId, channel),
			user: this.getRemoteUser(puppetId, user, isWebhook, textChannel),
			eventId,
			externalUrl,
		};
	}

	public async insertNewEventId(puppetId: number, matrixId: string, msgs: Discord.Message | Discord.Message[]) {
		const p = this.puppets[puppetId];
		if (!Array.isArray(msgs)) {
			msgs = [msgs];
		}
		for (const m of msgs) {
			const lockKey = `${puppetId};${m.channel.id}`;
			await this.puppet.eventStore.insert(puppetId, matrixId, m.id);
			this.messageDeduplicator.unlock(lockKey, p.client.user!.id, m.id);
			this.lastEventIds[m.channel.id] = m.id;
		}
	}

	public async handleMatrixMessage(room: IRemoteRoom, data: IMessageEvent, asUser: ISendingUser | null, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}

		const sendMsg = await this.parseMatrixMessage(room.puppetId, event.content);
		const lockKey = `${room.puppetId};${chan.id}`;
		this.messageDeduplicator.lock(lockKey, p.client.user!.id, sendMsg);
		try {
			const reply = await this.sendToDiscord(chan, sendMsg, asUser);
			await this.insertNewEventId(room.puppetId, data.eventId!, reply);
		} catch (err) {
			log.warn("Couldn't send message", err);
			this.messageDeduplicator.unlock(lockKey);
			await this.sendMessageFail(room);
		}
	}

	public async handleMatrixFile(room: IRemoteRoom, data: IFileEvent, asUser: ISendingUser | null, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
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
				const filename = this.getFilenameForMedia(data.filename, mimetype);
				this.messageDeduplicator.lock(lockKey, p.client.user!.id, `file:${filename}`);
				try {
					const sendFile: IDiscordSendFile = {
						buffer,
						filename,
						url: data.url,
						isImage,
					};
					const reply = await this.sendToDiscord(chan, sendFile, asUser);
					await this.insertNewEventId(room.puppetId, data.eventId!, reply);
					return;
				} catch (err) {
					this.messageDeduplicator.unlock(lockKey);
					log.warn("Couldn't send media message, retrying as embed/url", err);
				}
			}
		}
		try {
			if (isImage && p.client.user!.bot) {
				const embed = new Discord.MessageEmbed()
					.setTitle(data.filename)
					.setImage(data.url);
				this.messageDeduplicator.lock(lockKey, p.client.user!.id, "");
				const reply = await this.sendToDiscord(chan, embed, asUser);
				await this.insertNewEventId(room.puppetId, data.eventId!, reply);
			} else {
				const filename = await this.discordEscape(data.filename);
				const msg = `Uploaded a file \`${filename}\`: ${data.url}`;
				this.messageDeduplicator.lock(lockKey, p.client.user!.id, msg);
				const reply = await this.sendToDiscord(chan, msg, asUser);
				await this.insertNewEventId(room.puppetId, data.eventId!, reply);
			}
		} catch (err) {
			log.warn("Couldn't send media message", err);
			this.messageDeduplicator.unlock(lockKey);
			await this.sendMessageFail(room);
		}
	}

	public async handleMatrixRedact(room: IRemoteRoom, eventId: string, asUser: ISendingUser | null, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not foundp.client.user!.bot", room);
			return;
		}
		log.verbose(`Deleting message with ID ${eventId}...`);
		const msg = await chan.messages.fetch(eventId);
		if (!msg) {
			return;
		}
		try {
			p.deletedMessages.add(msg.id);
			await msg.delete();
			await this.puppet.eventStore.remove(room.puppetId, msg.id);
		} catch (err) {
			log.warn("Couldn't delete message", err);
		}
	}

	public async handleMatrixEdit(
		room: IRemoteRoom,
		eventId: string,
		data: IMessageEvent,
		asUser: ISendingUser | null,
		event: any,
	) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}
		log.verbose(`Editing message with ID ${eventId}...`);
		const msg = await chan.messages.fetch(eventId);
		if (!msg) {
			return;
		}
		let sendMsg = await this.parseMatrixMessage(room.puppetId, event.content["m.new_content"]);
		const lockKey = `${room.puppetId};${chan.id}`;
		this.messageDeduplicator.lock(lockKey, p.client.user!.id, sendMsg);
		try {
			let reply: Discord.Message | Discord.Message[];
			let matrixEventId = data.eventId!;
			if (asUser) {
				// just re-send as new message
				if (eventId === this.lastEventIds[chan.id]) {
					try {
						p.deletedMessages.add(msg.id);
						const matrixEvents = await this.puppet.eventStore.getMatrix(room.puppetId, msg.id);
						if (matrixEvents.length > 0) {
							matrixEventId = matrixEvents[0];
						}
						await msg.delete();
						await this.puppet.eventStore.remove(room.puppetId, msg.id);
					} catch (err) {
						log.warn("Couldn't delete old message", err);
					}
				} else {
					sendMsg = `**EDIT:** ${sendMsg}`;
				}
				reply = await this.sendToDiscord(chan, sendMsg, asUser);
			} else {
				reply = await msg.edit(sendMsg);
			}
			await this.insertNewEventId(room.puppetId, matrixEventId, reply);
		} catch (err) {
			log.warn("Couldn't edit message", err);
			this.messageDeduplicator.unlock(lockKey);
			await this.sendMessageFail(room);
		}
	}

	public async handleMatrixReply(
		room: IRemoteRoom,
		eventId: string,
		data: IMessageEvent,
		asUser: ISendingUser | null,
		event: any,
	) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}
		log.verbose(`Replying to message with ID ${eventId}...`);
		const msg = await chan.messages.fetch(eventId);
		if (!msg) {
			return;
		}
		let sendMsg = await this.parseMatrixMessage(room.puppetId, event.content);
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
				this.messageDeduplicator.lock(lockKey, p.client.user!.id, sendMsg);
				reply = await this.sendToDiscord(chan, sendMsg, asUser, replyEmbed);
			} else {
				sendMsg += `\n>>> ${replyEmbed.description}`;
				this.messageDeduplicator.lock(lockKey, p.client.user!.id, sendMsg);
				reply = await this.sendToDiscord(chan, sendMsg, asUser);
			}
			await this.insertNewEventId(room.puppetId, data.eventId!, reply);
		} catch (err) {
			log.warn("Couldn't send reply", err);
			this.messageDeduplicator.unlock(lockKey);
			await this.sendMessageFail(room);
		}
	}

	public async handleMatrixReaction(
		room: IRemoteRoom,
		eventId: string,
		reaction: string,
		asUser: ISendingUser | null,
		event: any,
	) {
		const p = this.puppets[room.puppetId];
		if (!p || asUser) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}
		log.verbose(`Reacting to ${eventId} with ${reaction}...`);
		const msg = await chan.messages.fetch(eventId);
		if (!msg) {
			return;
		}
		if (reaction.startsWith("mxc://")) {
			const emoji = await this.getDiscordEmoji(p.client, reaction);
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
		const p = this.puppets[room.puppetId];
		if (!p || asUser) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}
		log.verbose(`Removing reaction to ${eventId} with ${reaction}...`);
		const msg = await chan.messages.fetch(eventId);
		if (!msg) {
			return;
		}
		let emoji: Discord.Emoji | null = null;
		if (reaction.startsWith("mxc://")) {
			emoji = await this.getDiscordEmoji(p.client, reaction);
		}
		for (const [, r] of msg.reactions) {
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

	public async handleDiscordMessage(puppetId: number, msg: Discord.Message) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		if (msg.type !== "DEFAULT") {
			return;
		}
		log.info("Received new message!");
		if (!await this.bridgeRoom(puppetId, msg.channel)) {
			log.info("Unhandled channel, dropping message...");
			return;
		}
		const params = this.getSendParams(puppetId, msg);
		const lockKey = `${puppetId};${msg.channel.id}`;
		const dedupeMsg = msg.attachments.first() ? `file:${msg.attachments.first()!.name}` : msg.content;
		if (await this.messageDeduplicator.dedupe(lockKey, msg.author.id, msg.id, dedupeMsg)) {
			// dedupe message
			log.info("Deduping message, dropping...");
			return;
		}
		if (msg.webhookID && msg.channel instanceof Discord.TextChannel) {
			// maybe we are a webhook from our webhook?
			try {
				const hook = (await msg.channel.fetchWebhooks()).find((h) => h.name === "_matrix") || null;
				if (hook && msg.webhookID === hook.id) {
					log.info("Message sent from our webhook, deduping...");
					return;
				}
			} catch (err) { } // no webhook permissions, ignore
		}
		this.lastEventIds[msg.channel.id] = msg.id;
		const externalUrl = params.externalUrl;
		for ( const [, attachment] of msg.attachments) {
			params.externalUrl = attachment.url;
			await this.puppet.sendFileDetect(params, attachment.url, attachment.name);
		}
		params.externalUrl = externalUrl;
		if (msg.content || msg.embeds.length > 0) {
			const opts: IDiscordMessageParserOpts = {
				callbacks: this.getDiscordMsgParserCallbacks(puppetId),
			};
			const reply = await this.discordMsgParser.FormatMessage(opts, msg as any); // library uses discord.js
			await this.puppet.sendMessage(params, {
				body: reply.body,
				formattedBody: reply.formattedBody,
				emote: reply.msgtype === "m.emote",
				notice: reply.msgtype === "m.notice",
			});
		}
	}

	public async handleDiscordMessageUpdate(puppetId: number, msg1: Discord.Message, msg2: Discord.Message) {
		if (msg1.content === msg2.content) {
			return; // nothing to do
		}
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		const params = this.getSendParams(puppetId, msg1);
		const lockKey = `${puppetId};${msg1.channel.id}`;
		if (await this.messageDeduplicator.dedupe(lockKey, msg2.author.id, msg2.id, msg2.content)) {
			// dedupe message
			return;
		}
		if (!await this.bridgeRoom(puppetId, msg1.channel)) {
			log.info("Unhandled channel, dropping message...");
			return;
		}
		const opts: IDiscordMessageParserOpts = {
			callbacks: this.getDiscordMsgParserCallbacks(puppetId),
		};
		const reply = await this.discordMsgParser.FormatMessage(opts, msg2 as any); // library uses discord.js
		if (msg1.content) {
			// okay we have an actual edit
			await this.puppet.sendEdit(params, msg1.id, {
				body: reply.body,
				formattedBody: reply.formattedBody,
				emote: reply.msgtype === "m.emote",
				notice: reply.msgtype === "m.notice",
			});
		} else {
			// we actually just want to insert a new message
			await this.puppet.sendMessage(params, {
				body: reply.body,
				formattedBody: reply.formattedBody,
				emote: reply.msgtype === "m.emote",
				notice: reply.msgtype === "m.notice",
			});
		}
	}

	public async handleDiscordMessageDelete(puppetId: number, msg: Discord.Message) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		const params = this.getSendParams(puppetId, msg);
		const lockKey = `${puppetId};${msg.channel.id}`;
		if (p.deletedMessages.has(msg.id) ||
			await this.messageDeduplicator.dedupe(lockKey, msg.author.id, msg.id, msg.content)) {
			// dedupe message
			return;
		}
		if (!await this.bridgeRoom(puppetId, msg.channel)) {
			log.info("Unhandled channel, dropping message...");
			return;
		}
		await this.puppet.sendRedact(params, msg.id);
	}

	public async handlePuppetName(puppetId: number, name: string) {
		const p = this.puppets[puppetId];
		if (!p || !p.data.syncProfile || !p.client.user!.bot) {
			// bots can't change their name
			return;
		}
		try {
			await p.client.user!.setUsername(name);
		} catch (err) {
			log.warn(`Couldn't set name for ${puppetId}`, err);
		}
	}

	public async handlePuppetAvatar(puppetId: number, url: string, mxc: string) {
		const p = this.puppets[puppetId];
		if (!p || !p.data.syncProfile) {
			return;
		}
		try {
			const AVATAR_SIZE = 800;
			const realUrl = this.puppet.getUrlFromMxc(mxc, AVATAR_SIZE, AVATAR_SIZE, "scale");
			const buffer = await Util.DownloadFile(realUrl);
			await p.client.user!.setAvatar(buffer);
		} catch (err) {
			log.warn(`Couldn't set avatar for ${puppetId}`, err);
		}
	}

	public async newPuppet(puppetId: number, data: any) {
		log.info(`Adding new Puppet: puppetId=${puppetId}`);
		if (this.puppets[puppetId]) {
			await this.deletePuppet(puppetId);
		}
		const client = new Discord.Client();
		client.on("ready", async () => {
			const d = this.puppets[puppetId].data;
			d.username = client.user!.tag;
			d.id = client.user!.id;
			d.bot = client.user!.bot;
			await this.puppet.setUserId(puppetId, client.user!.id);
			await this.puppet.setPuppetData(puppetId, d);
			await this.puppet.sendStatusMessage(puppetId, "connected");
			await this.updateUserInfo(puppetId);
			// set initial presence for everyone
			for (const [, user] of client.users) {
				await this.updatePresence(puppetId, user.presence);
			}
		});
		client.on("message", async (msg: Discord.Message) => {
			try {
				await this.handleDiscordMessage(puppetId, msg);
			} catch (err) {
				log.error("Error handling discord message event", err.error || err.body || err);
			}
		});
		client.on("messageUpdate", async (msg1: Discord.Message, msg2: Discord.Message) => {
			try {
				await this.handleDiscordMessageUpdate(puppetId, msg1, msg2);
			} catch (err) {
				log.error("Error handling discord messageUpdate event", err.error || err.body || err);
			}
		});
		client.on("messageDelete", async (msg: Discord.Message) => {
			try {
				await this.handleDiscordMessageDelete(puppetId, msg);
			} catch (err) {
				log.error("Error handling discord messageDelete event", err.error || err.body || err);
			}
		});
		client.on("messageDeleteBulk", async (msgs: Discord.Collection<Discord.Snowflake, Discord.Message>) => {
			for (const [, msg] of msgs) {
				try {
					await this.handleDiscordMessageDelete(puppetId, msg);
				} catch (err) {
					log.error("Error handling one discord messageDeleteBulk event", err.error || err.body || err);
				}
			}
		});
		client.on("typingStart", async (chan: Discord.Channel, user: Discord.User) => {
			try {
				const params = this.getSendParams(puppetId, chan, user);
				await this.puppet.setUserTyping(params, true);
			} catch (err) {
				log.error("Error handling discord typingStart event", err.error || err.body || err);
			}
		});
		client.on("typingStop", async (chan: Discord.Channel, user: Discord.User) => {
			try {
				const params = this.getSendParams(puppetId, chan, user);
				await this.puppet.setUserTyping(params, false);
			} catch (err) {
				log.error("Error handling discord typingStop event", err.error || err.body || err);
			}
		});
		client.on("presenceUpdate", async (_, presence: Discord.Presence) => {
			try {
				await this.updatePresence(puppetId, presence);
			} catch (err) {
				log.error("Error handling discord presenceUpdate event", err.error || err.body || err);
			}
		});
		client.on("messageReactionAdd", async (reaction: Discord.MessageReaction, user: Discord.User) => {
			try {
				// TODO: filter out echo back?
				const chan = reaction.message.channel;
				if (!await this.bridgeRoom(puppetId, chan)) {
					return;
				}
				const params = this.getSendParams(puppetId, chan, user);
				if (reaction.emoji.id) {
					const mxc = await this.getEmojiMxc(reaction.emoji.name, reaction.emoji.animated, reaction.emoji.id);
					await this.puppet.sendReaction(params, reaction.message.id, mxc || reaction.emoji.name);
				} else {
					await this.puppet.sendReaction(params, reaction.message.id, reaction.emoji.name);
				}
			} catch (err) {
				log.error("Error handling discord messageReactionAdd event", err.error || err.body || err);
			}
		});
		client.on("messageReactionRemove", async (reaction: Discord.MessageReaction, user: Discord.User) => {
			try {
				// TODO: filter out echo back?
				const chan = reaction.message.channel;
				if (!await this.bridgeRoom(puppetId, chan)) {
					return;
				}
				const params = this.getSendParams(puppetId, chan, user);
				if (reaction.emoji.id) {
					const mxc = await this.getEmojiMxc(reaction.emoji.name, reaction.emoji.animated, reaction.emoji.id);
					await this.puppet.removeReaction(params, reaction.message.id, mxc || reaction.emoji.name);
				} else {
					await this.puppet.removeReaction(params, reaction.message.id, reaction.emoji.name);
				}
			} catch (err) {
				log.error("Error handling discord messageReactionRemove event", err.error || err.body || err);
			}
		});
		client.on("messageReactionRemoveAll", async (message: Discord.Message) => {
			try {
				const chan = message.channel;
				if (!await this.bridgeRoom(puppetId, chan)) {
					return;
				}
				// alright, let's fetch *an* admin user
				let user: Discord.User;
				if (chan instanceof Discord.TextChannel) {
					user = chan.guild.owner ? chan.guild.owner.user : client.user!;
				} else if (chan instanceof Discord.DMChannel) {
					user = chan.recipient;
				} else if (chan instanceof Discord.GroupDMChannel) {
					user = chan.owner;
				} else {
					user = client.user!;
				}
				const params = this.getSendParams(puppetId, chan, user);
				await this.puppet.removeAllReactions(params, message.id);
			} catch (err) {
				log.error("Error handling discord messageReactionRemoveAll event", err.error || err.body || err);
			}
		});
		client.on("channelUpdate", async (_, channel: Discord.Channel) => {
			const remoteChan = this.getRemoteRoom(puppetId, channel);
			await this.puppet.updateRoom(remoteChan);
		});
		client.on("guildMemberUpdate", async (oldMember: Discord.GuildMember, newMember: Discord.GuildMember) => {
			if (oldMember.displayName !== newMember.displayName) {
				const remoteUser = this.getRemoteUser(puppetId, newMember);
				await this.puppet.updateUser(remoteUser);
			}
		});
		client.on("userUpdate", async (_, user: Discord.User) => {
			const remoteUser = this.getRemoteUser(puppetId, user);
			await this.puppet.updateUser(remoteUser);
		});
		client.on("guildUpdate", async (_, guild: Discord.Guild) => {
			try {
				const remoteGroup = await this.getRemoteGroup(puppetId, guild);
				await this.puppet.updateGroup(remoteGroup);
				for (const [, chan] of guild.channels) {
					const remoteChan = this.getRemoteRoom(puppetId, chan);
					await this.puppet.updateRoom(remoteChan);
				}
			} catch (err) {
				log.error("Error handling discord guildUpdate event", err.error || err.body || err);
			}
		});
		client.on("relationshipAdd", async (_, relationship: Discord.Relationship) => {
			if (relationship.type === "incoming") {
				const msg = `New incoming friends request from ${relationship.user.username}!

Type \`addfriend ${puppetId} ${relationship.user.id}\` to accept it.`;
				await this.puppet.sendStatusMessage(puppetId, msg);
			}
		});
		const TWO_MIN = 120000;
		this.puppets[puppetId] = {
			client,
			data,
			deletedMessages: new ExpireSet(TWO_MIN),
		};
		await client.login(data.token, data.bot || false);
	}

	public async deletePuppet(puppetId: number) {
		log.info(`Got signal to quit Puppet: puppetId=${puppetId}`);
		const p = this.puppets[puppetId];
		if (!p) {
			return; // nothing to do
		}
		p.client.destroy();
		delete this.puppet[puppetId];
	}

	public async createRoom(chan: IRemoteRoom): Promise<IRemoteRoom | null> {
		return await this.getRemoteRoomById(chan.puppetId, chan.roomId);
	}

	public async createUser(user: IRemoteUser): Promise<IRemoteUser | null> {
		const p = this.puppets[user.puppetId];
		if (!p) {
			return null;
		}
		if (user.userId.startsWith("webhook-")) {
			return null;
		}
		const u = await this.getUserById(p.client, user.userId);
		if (!u) {
			return null;
		}
		const remoteUser = this.getRemoteUser(user.puppetId, u);
		remoteUser.roomOverrides = {};
		for (const [, guild] of p.client.guilds) {
			const member = guild.members.get(u.id);
			if (member) {
				for (const [, chan] of guild.channels) {
					if (chan.type === "text") {
						remoteUser.roomOverrides[chan.id] = this.getRemoteUserRoomOverride(member, chan);
					}
				}
			}
		}
		return remoteUser;
	}

	public async createGroup(group: IRemoteGroup): Promise<IRemoteGroup | null> {
		const p = this.puppets[group.puppetId];
		if (!p) {
			return null;
		}

		const guild = p.client.guilds.get(group.groupId);
		if (!guild) {
			return null;
		}
		return await this.getRemoteGroup(group.puppetId, guild);
	}

	public async getDmRoom(user: IRemoteUser): Promise<string | null> {
		const p = this.puppets[user.puppetId];
		if (!p) {
			return null;
		}
		const u = await this.getUserById(p.client, user.userId);
		if (!u) {
			return null;
		}
		return `dm-${u.id}`;
	}

	public async listUsers(puppetId: number): Promise<IRetList[]> {
		const retUsers: IRetList[] = [];
		const retGuilds: IRetList[] = [];
		const p = this.puppets[puppetId];
		if (!p) {
			return [];
		}
		const blacklistedIds = [p.client.user!.id, "1"];
		for (const [, guild] of p.client.guilds) {
			retGuilds.push({
				category: true,
				name: guild.name,
			});
			for (const [, member] of guild.members) {
				if (!blacklistedIds.includes(member.user.id)) {
					retGuilds.push({
						name: member.user.username,
						id: member.user.id,
					});
				}
			}
		}

		for (const [, user] of p.client.users) {
			const found = retGuilds.find((element) => element.id === user.id);
			if (!found && !blacklistedIds.includes(user.id)) {
				retUsers.push({
					name: user.username,
					id: user.id,
				});
			}
		}

		return retUsers.concat(retGuilds);
	}

	public async listRooms(puppetId: number): Promise<IRetList[]> {
		const retGroups: IRetList[] = [];
		const retGuilds: IRetList[] = [];
		const p = this.puppets[puppetId];
		if (!p) {
			return [];
		}
		for (const [, guild] of p.client.guilds) {
			let didGuild = false;
			let didCat = false;
			await this.iterateGuildStructure(puppetId, guild,
				async (cat: Discord.CategoryChannel) => {
					didCat = true;
					retGuilds.push({
						category: true,
						name: `${guild.name} - ${cat.name}`,
					});
				},
				async (chan: Discord.TextChannel) => {
					if (!didGuild && !didCat) {
						didGuild = true;
						retGuilds.push({
							category: true,
							name: guild.name,
						});
					}
					retGuilds.push({
						name: chan.name,
						id: chan.id,
					});
				},
			);
		}
		for (const [, chan] of p.client.channels) {
			if (chan instanceof Discord.GroupDMChannel) {
				const found = retGuilds.find((element) => element.id === chan.id);
				if (!found) {
					retGroups.push({
						name: chan.name || "",
						id: chan.id,
					});
				}
			}
		}
		return retGroups.concat(retGuilds);
	}

	public async updateUserInfo(puppetId: number) {
		const p = this.puppets[puppetId];
		if (!p || !p.data.syncProfile) {
			return;
		}
		const userInfo = await this.puppet.getPuppetMxidInfo(puppetId);
		if (userInfo) {
			if (userInfo.name) {
				await this.handlePuppetName(puppetId, userInfo.name);
			}
			if (userInfo.avatarUrl) {
				await this.handlePuppetAvatar(puppetId, userInfo.avatarUrl, userInfo.avatarMxc as string);
			}
		}
	}

	public async commandSyncProfile(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		const syncProfile = param === "1" || param.toLowerCase() === "true";
		p.data.syncProfile = syncProfile;
		await this.puppet.setPuppetData(puppetId, p.data);
		if (syncProfile) {
			await sendMessage("Syncing discord profile with matrix profile now");
			await this.updateUserInfo(puppetId);
		} else {
			await sendMessage("Stopped syncing discord profile with matrix profile");
		}
	}

	public async commandJoinEntireGuild(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		const guild = p.client.guilds.get(param);
		if (!guild) {
			await sendMessage("Guild not found!");
			return;
		}
		if (!(await this.store.isGuildBridged(puppetId, guild.id))) {
			await sendMessage("Guild not bridged!");
			return;
		}
		for (const [, chan] of guild.channels) {
			if (chan.type !== "text") {
				continue;
			}
			const permissions = chan.permissionsFor(p.client.user!);
			if (!permissions || permissions.has(Discord.Permissions.FLAGS.VIEW_CHANNEL as number)) {
				const remoteChan = this.getRemoteRoom(puppetId, chan);
				await this.puppet.bridgeRoom(remoteChan);
			}
		}
		await sendMessage(`Invited to all channels in guild ${guild.name}!`);
	}

	public async commandListGuilds(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		const guilds = await this.store.getBridgedGuilds(puppetId);
		let sendStr = "Guilds:\n";
		for (const [, guild] of p.client.guilds) {
			let sendStrPart = ` - ${guild.name} (\`${guild.id}\`)`;
			if (guilds.includes(guild.id)) {
				sendStrPart += " **bridged!**";
			}
			sendStrPart += "\n";
			if (sendStr.length + sendStrPart.length > MAX_MSG_SIZE) {
				await sendMessage(sendStr);
				sendStr = "";
			}
			sendStr += sendStrPart;
		}
		await sendMessage(sendStr);
	}

	public async commandAcceptInvite(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		const matches = param.match(/^(?:https?:\/\/)?(?:discord\.gg\/|discordapp\.com\/invite\/)?([^?\/\s]+)/i);
		if (!matches) {
			await sendMessage("No invite code found!");
			return;
		}
		const inviteCode = matches[1];
		try {
			const guild = await p.client.acceptInvite(inviteCode);
			if (!guild) {
				await sendMessage("Something went wrong");
			} else {
				await sendMessage(`Accepted invite to guild ${guild.name}!`);
			}
		} catch (err) {
			if (err.message) {
				await sendMessage(`Invalid invite code \`${inviteCode}\`: ${err.message}`);
			} else {
				await sendMessage(`Invalid invite code \`${inviteCode}\``);
			}
			log.warn(`Invalid invite code ${inviteCode}:`, err);
		}
	}

	public async commandBridgeGuild(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		const guild = p.client.guilds.get(param);
		if (!guild) {
			await sendMessage("Guild not found!");
			return;
		}
		await this.store.setBridgedGuild(puppetId, guild.id);
		let msg = `Guild ${guild.name} (\`${guild.id}\`) is now being bridged!

Either type \`joinentireguild ${puppetId} ${guild.id}\` to get invited to all the channels of that guild `;
		msg += `or type \`listrooms\` and join that way.

Additionally you will be invited to guild channels as messages are sent in them.`;
		await sendMessage(msg);
	}

	public async commandUnbridgeGuild(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		const bridged = await this.store.isGuildBridged(puppetId, param);
		if (!bridged) {
			await sendMessage("Guild wasn't bridged!");
			return;
		}
		await this.store.removeBridgedGuild(puppetId, param);
		await sendMessage("Unbridged guild!");
	}

	public async commandBridgeChannel(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		let channel: Discord.TextChannel | undefined;
		let guild: Discord.Guild | undefined;
		for (const [, g] of p.client.guilds) {
			channel = g.channels.get(param) as Discord.TextChannel;
			if (channel && channel.type === "text") {
				guild = g;
				break;
			}
			channel = undefined;
		}
		if (!channel || !guild) {
			await sendMessage("Channel not found!");
			return;
		}
		await this.store.setBridgedChannel(puppetId, channel.id);
		await sendMessage(`Channel ${channel.name} (\`${channel.id}\`) of guild ${guild.name} is now been bridged!`);
	}

	public async commandUnbridgeChannel(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		const bridged = await this.store.isChannelBridged(puppetId, param);
		if (!bridged) {
			await sendMessage("Channel wasn't bridged!");
			return;
		}
		await this.store.removeBridgedChannel(puppetId, param);
		await sendMessage("Unbridged channel!");
	}

	public async commandEnableFriendsManagement(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		if (p.data.friendsManagement) {
			await sendMessage("Friends management is already enabled.");
			return;
		}
		if (param === "YES I KNOW THE RISKS") {
			p.data.friendsManagement = true;
			await this.puppet.setPuppetData(puppetId, p.data);
			await sendMessage("Friends management enabled!");
			return;
		}
		await sendMessage(`Using user accounts is against discords TOS. As this is required for friends management, you ` +
			`will be breaking discords TOS if you enable this feature. Development of it has already softlocked accounts. ` +
			`USE AT YOUR OWN RISK!\n\nIf you want to enable friends management type \`enablefriendsmanagement ${puppetId} ` +
			`YES I KNOW THE RISKS\``);
	}

	public async commandListFriends(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		if (!p.data.friendsManagement) {
			await sendMessage(`Friends management is disabled. Please type ` +
				`\`enablefriendsmanagement ${puppetId}\` to enable it`);
			return;
		}
		let sendStr = "";
		const friends = p.client.user!.relationships.friends;
		if (friends.size > 0) {
			sendStr += "Friends:\n";
			for (const [, user] of p.client.user!.relationships.friends) {
				const mxid = await this.puppet.getMxidForUser({
					puppetId,
					userId: user.id,
				});
				const sendStrPart = ` - ${user.username} (\`${user.id}\`): [${user.username}](https://matrix.to/#/${mxid})\n`;
				if (sendStr.length + sendStrPart.length > MAX_MSG_SIZE) {
					await sendMessage(sendStr);
					sendStr = "";
				}
				sendStr += sendStrPart;
			}
		}
		const incoming = p.client.user!.relationships.incoming;
		if (incoming.size > 0) {
			sendStr += "\nIncoming friend requests:\n";
			for (const [, user] of incoming) {
				const sendStrPart = ` - ${user.username} (\`${user.id}\`)\n`;
				if (sendStr.length + sendStrPart.length > MAX_MSG_SIZE) {
					await sendMessage(sendStr);
					sendStr = "";
				}
				sendStr += sendStrPart;
			}
		}
		const outgoing = p.client.user!.relationships.outgoing;
		if (outgoing.size > 0) {
			sendStr += "\nOutgoing friend requests:\n";
			for (const [, user] of outgoing) {
				const sendStrPart = ` - ${user.username} (\`${user.id}\`)\n`;
				if (sendStr.length + sendStrPart.length > MAX_MSG_SIZE) {
					await sendMessage(sendStr);
					sendStr = "";
				}
				sendStr += sendStrPart;
			}
		}
		await sendMessage(sendStr);
	}

	public async commandAddFriend(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		if (!p.data.friendsManagement) {
			await sendMessage(`Friends management is disabled. Please type ` +
				`\`enablefriendsmanagement ${puppetId}\` to enable it`);
			return;
		}
		try {
			const user = await p.client.user!.relationships.request("friend", param);
			if (user) {
				await sendMessage(`Added/sent friend request to ${typeof user === "string" ? user : user.username}!`);
			} else {
				await sendMessage("User not found");
			}
		} catch (err) {
			await sendMessage("User not found");
			log.warn(`Couldn't find user ${param}:`, err);
		}
	}

	public async commandRemoveFriend(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		if (!p.data.friendsManagement) {
			await sendMessage(`Friends management is disabled. Please type ` +
				`\`enablefriendsmanagement ${puppetId}\` to enable it`);
			return;
		}
		try {
			const user = await p.client.user!.relationships.remove(param);
			if (user) {
				await sendMessage(`Removed ${user.username} as friend!`);
			} else {
				await sendMessage("User not found");
			}
		} catch (err) {
			await sendMessage("User not found");
			log.warn(`Couldn't find user ${param}:`, err);
		}
	}

	private async sendToDiscord(
		chan: Discord.TextChannel | Discord.DMChannel | Discord.GroupDMChannel,
		msg: string | Discord.MessageEmbed | IDiscordSendFile,
		asUser: ISendingUser | null,
		replyEmbed?: Discord.MessageEmbed,
	): Promise<Discord.Message | Discord.Message[]> {
		log.debug("Sending something to discord...");
		let sendThing: string | Discord.MessageAdditions;
		if (typeof msg === "string" || msg instanceof Discord.MessageEmbed) {
			sendThing = msg;
		} else {
			sendThing = new Discord.MessageAttachment(msg.buffer, msg.filename);
		}
		if (!asUser) {
			// we don't want to relay, so just send off nicely
			log.debug("Not in relay mode, just sending as user");
			if (replyEmbed && chan.client.user!.bot) {
				return await chan.send(sendThing, replyEmbed);
			}
			return await chan.send(sendThing);
		}
		// alright, we have to send as if it was another user. First try webhooks.
		if (chan instanceof Discord.TextChannel) {
			log.debug("Trying to send as webhook...");
			let hook: Discord.Webhook | null = null;
			try {
				hook = (await chan.fetchWebhooks()).find((h) => h.name === "_matrix") || null;
				if (!hook) {
					try {
						hook = await chan.createWebhook("_matrix", {
							reason: "Allow bridging matrix messages to discord nicely",
						});
					} catch (err) {
						log.warn("Unable to create \"_matrix\" webhook", err);
					}
				}
			} catch (err) {
				log.warn("Missing webhook permissions", err);
			}
			if (hook) {
				const hookOpts: Discord.WebhookMessageOptions & { split: true } = {
					username: asUser.displayname,
					avatarURL: asUser.avatarUrl || undefined,
					embeds: replyEmbed ? [replyEmbed] : [],
					split: true,
				};
				if (typeof sendThing === "string") {
					return await hook.send(sendThing, hookOpts);
				}
				if (sendThing instanceof Discord.MessageAttachment) {
					hookOpts.files = [sendThing];
				} else if (sendThing instanceof Discord.MessageEmbed) {
					hookOpts.embeds!.unshift(sendThing);
				}
				return await hook.send(hookOpts);
			}
			log.debug("Couldn't send as webhook");
		}
		// alright, we either weren't able to send as webhook or we aren't in a webhook-able channel.
		// so.....let's try to send as embed next
		if (chan.client.user!.bot) {
			log.debug("Trying to send as embed...");
			const embed = new Discord.MessageEmbed();
			if (typeof msg === "string") {
				embed.setDescription(msg);
			} else if (msg instanceof Discord.MessageEmbed) {
				if (msg.image) {
					embed.setTitle(msg.title);
					embed.setImage(msg.image.url);
				}
			} else if (msg.isImage) {
				embed.setTitle(msg.filename);
				embed.setImage(msg.url);
			} else {
				const filename = await this.discordEscape(msg.filename);
				embed.setDescription(`Uploaded a file \`${filename}\`: ${msg.url}`);
			}
			if (replyEmbed && replyEmbed.description) {
				embed.addField("Replying to", replyEmbed.author!.name);
				embed.addField("Reply text", replyEmbed.description);
			}
			embed.setAuthor(asUser.displayname, asUser.avatarUrl || undefined, `https://matrix.to/#/${asUser.mxid}`);
			return await chan.send(embed);
		}
		// alright, nothing is working....let's prefix the displayname and send stuffs
		log.debug("Prepending sender information to send the message out...");
		const displayname = await this.discordEscape(asUser.displayname);
		let sendMsg = "";
		if (typeof msg === "string") {
			sendMsg = `**${displayname}**: ${msg}`;
		} else if (msg instanceof Discord.MessageEmbed) {
			if (msg.image) {
				if (msg.title) {
					const filename = await this.discordEscape(msg.title);
					sendMsg = `**${displayname}** uploaded a file \`${filename}\`: ${msg.image}`;
				} else {
					sendMsg = `**${displayname}** uploaded a file: ${msg.image}`;
				}
			}
		} else {
			const filename = await this.discordEscape(msg.filename);
			sendMsg = `**${displayname}** uploaded a file \`${filename}\`: ${msg.url}`;
		}
		if (replyEmbed && replyEmbed.description) {
			sendMsg += `\n>>> ${replyEmbed.description}`;
		}
		return await chan.send(sendMsg);
	}

	private async discordEscape(msg: string): Promise<string> {
		return await this.parseMatrixMessage(-1, {
			body: msg,
			msgtype: "m.text",
		});
	}

	private async updatePresence(puppetId: number, presence: Discord.Presence) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		if (!presence || !presence.user) {
			return;
		}
		const matrixPresence = {
			online: "online",
			idle: "unavailable",
			dnd: "unavailable",
			offline: "offline",
		}[presence.status] as "online" | "offline" | "unavailable";
		let statusMsg = "";
		for (const activity of presence.activities) {
			if (statusMsg !== "") {
				return;
			}
			const statusParts: string[] = [];
			if (activity.type !== "CUSTOM_STATUS") {
				const lower = activity.type.toLowerCase();
				statusParts.push(lower.charAt(0).toUpperCase() + lower.substring(1));
				if (activity.name) {
					statusParts.push(activity.name);
				}
			} else {
				if (activity.emoji) {
					statusParts.push(activity.emoji.name);
				}
				if (activity.state) {
					statusParts.push(activity.state);
				}
			}
			statusMsg = statusParts.join(" ");
		}
		const remoteUser = this.getRemoteUser(puppetId, presence.user!);
		await this.puppet.setUserPresence(remoteUser, matrixPresence);
		if (statusMsg) {
			await this.puppet.setUserStatus(remoteUser, statusMsg);
		}
	}

	private async bridgeRoom(puppetId: number, chan: Discord.Channel): Promise<boolean> {
		if (["dm", "group"].includes(chan.type)) {
			return true; // we handle all dm and group channels
		}
		if (chan instanceof Discord.TextChannel) {
			// we have a guild text channel, maybe we handle it!
			if (await this.store.isGuildBridged(puppetId, chan.guild.id)) {
				return true;
			}
			// maybe it is a single channel override?
			return await this.store.isChannelBridged(puppetId, chan.id);
		}
		return false;
	}

	private async sendMessageFail(room: IRemoteRoom) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			return;
		}
		let msg = "";
		if (chan instanceof Discord.DMChannel) {
			msg = `Failed to send message to DM with user ${chan.recipient.username}`;
		} else if (chan instanceof Discord.GroupDMChannel) {
			let name = chan.name;
			if (!name) {
				const names: string[] = [];
				for (const [, user] of chan.recipients) {
					names.push(user.username);
				}
				name = names.join(", ");
			}
			msg = `Failed to send message into Group DM ${name}`;
		} else if (chan instanceof Discord.TextChannel) {
			msg = `Failed to send message into channel ${chan.name} of guild ${chan.guild.name}`;
		} else {
			msg = `Failed to send message into channel with id \`${(chan as Discord.Channel).id}\``;
		}
		await this.puppet.sendStatusMessage(room, msg);
	}

	private async parseMatrixMessage(puppetId: number, eventContent: any): Promise<string> {
		const opts: IMatrixMessageParserOpts = {
			displayname: "", // something too short
			callbacks: {
				canNotifyRoom: async () => true,
				getUserId: async (mxid: string) => {
					const parts = this.puppet.userSync.getPartsFromMxid(mxid);
					if (!parts || parts.puppetId !== puppetId) {
						return null;
					}
					return parts.userId;
				},
				getChannelId: async (mxid: string) => {
					const parts = await this.puppet.roomSync.getPartsFromMxid(mxid);
					if (!parts || parts.puppetId !== puppetId) {
						return null;
					}
					return parts.roomId;
				},
				getEmoji: async (mxc: string, name: string) => {
					const dbEmoji = await this.store.getEmojiByMxc(mxc);
					log.info("Found emoji", dbEmoji);
					if (!dbEmoji) {
						return null;
					}
					return {
						animated: dbEmoji.animated,
						name: dbEmoji.name,
						id: dbEmoji.emojiId,
					} as any;
				},
				mxcUrlToHttp: (mxc: string) => this.puppet.getUrlFromMxc(mxc),
			},
			determineCodeLanguage: true,
		};
		const msg = await this.matrixMsgParser.FormatMessage(opts, eventContent);
		return msg;
	}

	private async getUserById(client: Discord.Client, id: string): Promise<Discord.User | null> {
		for (const [, guild] of client.guilds) {
			const a = guild.members.find((m) => m.user.id === id);
			if (a) {
				return a.user;
			}
		}
		{
			const user = client.user!.relationships.friends.get(id);
			if (user) {
				return user;
			}
		}
		{
			const user = await client.users.fetch(id);
			if (user) {
				return user;
			}
		}
		return null;
	}

	private async getDiscordChan(
		client: Discord.Client, id: string,
	): Promise<Discord.DMChannel | Discord.TextChannel | Discord.GroupDMChannel | null> {
		if (!id.startsWith("dm-")) {
			// first fetch from the client channel cache
			const chan = client.channels.get(id);
			if (chan) {
				if (chan instanceof Discord.GroupDMChannel || chan instanceof Discord.TextChannel) {
					return chan;
				}
			}
			// next iterate over all the guild channels
			for (const [, guild] of client.guilds) {
				const c = guild.channels.get(id);
				if (c && c instanceof Discord.TextChannel) {
					return c;
				}
			}
			return null; // nothing found
		} else {
			// we have a DM channel
			const lookupId = id.substring("dm-".length);
			const user = await this.getUserById(client, lookupId);
			if (!user) {
				return null;
			}
			const chan = await user.createDM();
			return chan;
		}
	}

	private getDiscordMsgParserCallbacks(puppetId: number): IDiscordMessageParserCallbacks {
		const p = this.puppets[puppetId];
		return {
			getUser: async (id: string) => {
				const mxid = await this.puppet.getMxidForUser({
					puppetId,
					userId: id,
				});
				let name = mxid;
				const user = await this.getUserById(p.client, id);
				if (user) {
					name = user.username;
				}
				return {
					mxid,
					name,
				};
			},
			getChannel: async (id: string) => {
				const mxid = await this.puppet.getMxidForRoom({
					puppetId,
					roomId: id,
				});
				let name = mxid;
				const chan = await this.getDiscordChan(p.client, id);
				if (chan && !(chan instanceof Discord.DMChannel)) {
					name = chan.name || "";
				}
				return {
					mxid,
					name,
				};
			},
			getEmoji: this.getEmojiMxc.bind(this),
		};
	}

	private getFilenameForMedia(filename: string, mimetype: string): string {
		let ext = "";
		const mimeExt = mime.getExtension(mimetype);
		if (mimeExt) {
			ext = "." + mimeExt;
		}
		if (filename) {
			if (path.extname(filename) !== "") {
				return filename;
			}
			return path.basename(filename) + ext;
		}
		return "matrix-media" + ext;
	}

	private async getDiscordEmoji(client: Discord.Client, mxc: string): Promise<Discord.GuildEmoji | null> {
		const dbEmoji = await this.store.getEmojiByMxc(mxc);
		if (!dbEmoji) {
			return null;
		}
		const emoji = client.emojis.get(dbEmoji.emojiId);
		return emoji || null;
	}

	private async getEmojiMxc(name: string, animated: boolean, id: string): Promise<string | null> {
		let emoji = await this.store.getEmoji(id);
		if (emoji) {
			return emoji.mxcUrl;
		}
		const url = `https://cdn.discordapp.com/emojis/${id}${animated ? ".gif" : ".png"}`;
		const mxcUrl = await this.puppet.uploadContent(
			null,
			url,
		);
		emoji = {
			emojiId: id,
			name,
			animated,
			mxcUrl,
		};
		await this.store.setEmoji(emoji);
		return emoji.mxcUrl;
	}

	private async iterateGuildStructure(
		puppetId: number,
		guild: Discord.Guild,
		catCallback: (cat: Discord.CategoryChannel) => Promise<void>,
		chanCallback: (chan: Discord.TextChannel) => Promise<void>,
	) {
		const bridgedGuilds = await this.store.getBridgedGuilds(puppetId);
		const bridgedChannels = await this.store.getBridgedChannels(puppetId);
		const client = guild.client;
		// first we iterate over the non-sorted channels
		for (const [, chan] of guild.channels) {
			if (!bridgedGuilds.includes(guild.id) && !bridgedChannels.includes(chan.id)) {
				continue;
			}
			const permissions = chan.permissionsFor(client.user!);
			if (!chan.parentID && chan instanceof Discord.TextChannel &&
				(!permissions || permissions.has(Discord.Permissions.FLAGS.VIEW_CHANNEL as number))) {
				await chanCallback(chan);
			}
		}
		// next we iterate over the categories and all their children
		for (const [, cat] of guild.channels) {
			if (!(cat instanceof Discord.CategoryChannel)) {
				continue;
			}
			const catPermissions = cat.permissionsFor(client.user!);
			if (!catPermissions || catPermissions.has(Discord.Permissions.FLAGS.VIEW_CHANNEL as number)) {
				let doCat = false;
				for (const [, chan] of cat.children) {
					if (!bridgedGuilds.includes(guild.id) && !bridgedChannels.includes(chan.id)) {
						continue;
					}
					const permissions = chan.permissionsFor(client.user!);
					if (chan instanceof Discord.TextChannel &&
						(!permissions || permissions.has(Discord.Permissions.FLAGS.VIEW_CHANNEL as number))) {
						if (!doCat) {
							doCat = true;
							await catCallback(cat);
						}
						await chanCallback(chan);
					}
				}
			}
		}
	}
}
