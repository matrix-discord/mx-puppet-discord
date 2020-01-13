import {
	PuppetBridge,
	Log,
	IReceiveParams,
	IRemoteChan,
	IRemoteUser,
	IRemoteGroup,
	IMessageEvent,
	IFileEvent,
	Util,
	IRetList,
	Lock,
	SendMessageFn,
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
const SEND_LOOCK_TIMEOUT = 30000;
const MAX_MSG_SIZE = 4000;

interface IDiscordPuppet {
	client: Discord.Client;
	data: any;
	sentEventIds: string[];
}

interface IDiscordPuppets {
	[puppetId: number]: IDiscordPuppet;
}

export class DiscordClass {
	private puppets: IDiscordPuppets = {};
	private discordMsgParser: DiscordMessageParser;
	private matrixMsgParser: MatrixMessageParser;
	private sendMessageLock: Lock<string>;
	private store: DiscordStore;
	constructor(
		private puppet: PuppetBridge,
	) {
		this.discordMsgParser = new DiscordMessageParser();
		this.matrixMsgParser = new MatrixMessageParser();
		this.sendMessageLock = new Lock(SEND_LOOCK_TIMEOUT);
		this.store = new DiscordStore(puppet.store);
	}

	public async init(): Promise<void> {
		await this.store.init();
	}

	public getRemoteUser(puppetId: number, user: Discord.User, isWebhook: boolean = false): IRemoteUser {
		return {
			userId: isWebhook ? `webhook-${user.id}-${user.username}` : user.id,
			puppetId,
			avatarUrl: user.avatarURL,
			name: user.username,
		};
	}

	public getRemoteChan(puppetId: number, channel: Discord.Channel): IRemoteChan {
		let roomId = channel.id;
		if (channel.type === "dm") {
			roomId = `dm-${(channel as Discord.DMChannel).recipient.id}`;
		}
		const ret = {
			roomId,
			puppetId,
			isDirect: channel.type === "dm",
		} as IRemoteChan;
		if (channel.type === "group") {
			const groupChannel = channel as Discord.GroupDMChannel;
			ret.name = groupChannel.name;
			ret.avatarUrl = groupChannel.iconURL;
		}
		if (channel.type === "text") {
			const textChannel = channel as Discord.TextChannel;
			ret.name = `#${textChannel.name} - ${textChannel.guild.name}`;
			ret.avatarUrl = textChannel.guild.iconURL;
			ret.groupId = textChannel.guild.id;
		}
		return ret;
	}

	public async getRemoteChanById(puppetId: number, id: string): Promise<IRemoteChan | null> {
		const p = this.puppets[puppetId];
		if (!p) {
			return null;
		}
		const chan = await this.getDiscordChan(p.client, id);
		if (!chan) {
			return null;
		}
		return this.getRemoteChan(puppetId, chan);
	}

	public async getRemoteGroup(puppetId: number, guild: Discord.Guild) {
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
				const mxid = await this.puppet.getMxidForChan({
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
			name: guild.name,
			avatarUrl: guild.iconURL,
			roomIds,
			longDescription: description,
		} as IRemoteGroup;
	}

	public getSendParams(puppetId: number, msg: Discord.Message | Discord.Channel, user?: Discord.User): IReceiveParams {
		let channel: Discord.Channel;
		let eventId: string | undefined;
		let externalUrl: string | undefined;
		let isWebhook = false;
		if (!user) {
			channel = (msg as Discord.Message).channel;
			user = (msg as Discord.Message).author;
			eventId = (msg as Discord.Message).id;
			isWebhook = (msg as Discord.Message).webhookID ? true : false;
			if (channel.type === "text") {
				const textChannel = channel as Discord.TextChannel;
				externalUrl = `https://discordapp.com/channels/${textChannel.guild.id}/${textChannel.id}/${eventId}`;
			} else if (["group", "dm"].includes(channel.type)) {
				externalUrl = `https://discordapp.com/channels/@me/${channel.id}/${eventId}`;
			}
		} else {
			channel = msg as Discord.Channel;
		}
		return {
			chan: this.getRemoteChan(puppetId, channel),
			user: this.getRemoteUser(puppetId, user, isWebhook),
			eventId,
			externalUrl,
		} as IReceiveParams;
	}

	public async insertNewEventId(puppetId: number, matrixId: string, msgs: Discord.Message | Discord.Message[]) {
		const p = this.puppets[puppetId];
		if (!Array.isArray(msgs)) {
			msgs = [msgs];
		}
		for (const m of msgs) {
			await this.puppet.eventStore.insert(puppetId, matrixId, m.id);
			p.sentEventIds.push(m.id);
		}
	}

	public async handleMatrixMessage(room: IRemoteChan, data: IMessageEvent, event: any) {
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
		const lockKey = `${room.puppetId};${room.roomId}`;
		this.sendMessageLock.set(lockKey);
		try {
			const reply = await chan.send(sendMsg);
			await this.insertNewEventId(room.puppetId, data.eventId!, reply);
			this.sendMessageLock.release(lockKey);
		} catch (err) {
			log.warn("Couldn't send message", err);
			this.sendMessageLock.release(lockKey);
			await this.sendMessageFail(room);
		}
	}

	public async handleMatrixFile(room: IRemoteChan, data: IFileEvent, event: any) {
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
		const lockKey = `${room.puppetId};${room.roomId}`;
		if (size < MAXFILESIZE) {
			const attachment = await Util.DownloadFile(data.url);
			size = attachment.byteLength;
			if (size < MAXFILESIZE) {
				// send as attachment
				const filename = this.getFilenameForMedia(data.filename, mimetype);
				this.sendMessageLock.set(lockKey);
				try {
					const reply = await chan.send(new Discord.Attachment(attachment, filename));
					await this.insertNewEventId(room.puppetId, data.eventId!, reply);
					this.sendMessageLock.release(lockKey);
					return;
				} catch (err) {
					this.sendMessageLock.release(lockKey);
					log.warn("Couldn't send media message, retrying as embed/url", err);
				}
			}
		}
		this.sendMessageLock.set(lockKey);
		try {
			if (mimetype && mimetype.split("/")[0] === "image" && p.client.user.bot) {
				const embed = new Discord.RichEmbed()
					.setTitle(data.filename)
					.setImage(data.url);
				const reply = await chan.send(embed);
				await this.insertNewEventId(room.puppetId, data.eventId!, reply);
			} else {
				const reply = await chan.send(`Uploaded File: [${data.filename}](${data.url})`);
				await this.insertNewEventId(room.puppetId, data.eventId!, reply);
			}
			this.sendMessageLock.release(lockKey);
		} catch (err) {
			log.warn("Couldn't send media message", err);
			this.sendMessageLock.release(lockKey);
			await this.sendMessageFail(room);
		}
	}

	public async handleMatrixRedact(room: IRemoteChan, eventId: string, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not foundp.client.user.bot", room);
			return;
		}
		log.verbose(`Deleting message with ID ${eventId}...`);
		const msg = await chan.fetchMessage(eventId);
		if (!msg) {
			return;
		}
		await msg.delete();
	}

	public async handleMatrixEdit(room: IRemoteChan, eventId: string, data: IMessageEvent, event: any) {
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
		const msg = await chan.fetchMessage(eventId);
		if (!msg) {
			return;
		}
		const sendMsg = await this.parseMatrixMessage(room.puppetId, event.content["m.new_content"]);
		const lockKey = `${room.puppetId};${room.roomId}`;
		this.sendMessageLock.set(lockKey);
		const reply = await msg.edit(sendMsg);
		await this.insertNewEventId(room.puppetId, data.eventId!, reply);
		this.sendMessageLock.release(lockKey);
	}

	public async handleMatrixReply(room: IRemoteChan, eventId: string, data: IMessageEvent, event: any) {
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
		const msg = await chan.fetchMessage(eventId);
		if (!msg) {
			return;
		}
		let sendMsg = await this.parseMatrixMessage(room.puppetId, event.content);
		const replyEmbed = new Discord.RichEmbed()
			.setTimestamp(new Date(msg.createdAt))
			.setDescription(msg.content)
			.setAuthor(msg.author.username, msg.author.avatarURL);
		if (msg.embeds && msg.embeds[0]) {
			const msgEmbed = msg.embeds[0];
			// if an author is set it wasn't an image embed thingy we send
			if (msgEmbed.image && !msgEmbed.author) {
				replyEmbed.setImage(msgEmbed.image.url);
			}
		}
		if (msg.attachments.first()) {
			const attach = msg.attachments.first();
			if (attach.height) {
				// image!
				replyEmbed.setImage(attach.proxyURL);
			} else {
				replyEmbed.description += `[${attach.filename}](attach.proxyURL)`;
			}
		}
		const lockKey = `${room.puppetId};${room.roomId}`;
		this.sendMessageLock.set(lockKey);
		let reply;
		if (p.client.user.bot) {
			reply = await chan.send(sendMsg, replyEmbed);
		} else {
			sendMsg += `\n>>> ${replyEmbed.description}`;
			reply = await chan.send(sendMsg);
		}
		await this.insertNewEventId(room.puppetId, data.eventId!, reply);
		this.sendMessageLock.release(lockKey);
	}

	public async handleMatrixReaction(room: IRemoteChan, eventId: string, reaction: string, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}
		log.verbose(`Reacting to ${eventId} with ${reaction}...`);
		const msg = await chan.fetchMessage(eventId);
		if (!msg) {
			return;
		}
		await msg.react(reaction);
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
		if (!await this.bridgeChannel(puppetId, msg.channel)) {
			log.info("Unhandled channel, dropping message...");
			return;
		}
		const params = this.getSendParams(puppetId, msg);
		const lockKey = `${puppetId};${params.chan.roomId}`;
		await this.sendMessageLock.wait(lockKey);
		if (msg.author.id === p.client.user.id && p.sentEventIds.includes(msg.id)) {
			// dedupe message
			const ix = p.sentEventIds.indexOf(msg.id);
			p.sentEventIds.splice(ix, 1);
			return;
		}
		const externalUrl = params.externalUrl;
		for ( const [, attachment] of Array.from(msg.attachments)) {
			params.externalUrl = attachment.url;
			await this.puppet.sendFileDetect(params, attachment.url, attachment.filename);
		}
		params.externalUrl = externalUrl;
		if (msg.content) {
			const opts = {
				callbacks: this.getDiscordMsgParserCallbacks(puppetId),
			} as IDiscordMessageParserOpts;
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
		const lockKey = `${puppetId};${params.chan.roomId}`;
		await this.sendMessageLock.wait(lockKey);
		if (msg1.author.id === p.client.user.id && p.sentEventIds.includes(msg1.id)) {
			// dedupe message
			const ix = p.sentEventIds.indexOf(msg1.id);
			p.sentEventIds.splice(ix, 1);
			return;
		}
		if (!await this.bridgeChannel(puppetId, msg1.channel)) {
			log.info("Unhandled channel, dropping message...");
			return;
		}
		const opts = {
			callbacks: this.getDiscordMsgParserCallbacks(puppetId),
		} as IDiscordMessageParserOpts;
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
		const lockKey = `${puppetId};${params.chan.roomId}`;
		await this.sendMessageLock.wait(lockKey);
		if (msg.author.id === p.client.user.id && p.sentEventIds.includes(msg.id)) {
			// dedupe message
			const ix = p.sentEventIds.indexOf(msg.id);
			p.sentEventIds.splice(ix, 1);
			return;
		}
		if (!await this.bridgeChannel(puppetId, msg.channel)) {
			log.info("Unhandled channel, dropping message...");
			return;
		}
		await this.puppet.sendRedact(params, msg.id);
	}

	public async newPuppet(puppetId: number, data: any) {
		log.info(`Adding new Puppet: puppetId=${puppetId}`);
		if (this.puppets[puppetId]) {
			await this.deletePuppet(puppetId);
		}
		const client = new Discord.Client();
		client.on("ready", async () => {
			const d = this.puppets[puppetId].data;
			d.username = client.user.tag;
			d.id = client.user.id;
			await this.puppet.setUserId(puppetId, client.user.id);
			await this.puppet.setPuppetData(puppetId, d);
			await this.puppet.sendStatusMessage(puppetId, "connected");
		});
		client.on("message", async (msg: Discord.Message) => {
			try {
				await this.handleDiscordMessage(puppetId, msg);
			} catch (err) {
				log.error("Error handling discord message event", err);
			}
		});
		client.on("messageUpdate", async (msg1: Discord.Message, msg2: Discord.Message) => {
			try {
				await this.handleDiscordMessageUpdate(puppetId, msg1, msg2);
			} catch (err) {
				log.error("Error handling discord messageUpdate event", err);
			}
		});
		client.on("messageDelete", async (msg: Discord.Message) => {
			try {
				await this.handleDiscordMessageDelete(puppetId, msg);
			} catch (err) {
				log.error("Error handling discord messageDelete event", err);
			}
		});
		client.on("messageDeleteBulk", async (msgs: Discord.Collection<Discord.Snowflake, Discord.Message>) => {
			for (const [, msg] of Array.from(msgs)) {
				try {
					await this.handleDiscordMessageDelete(puppetId, msg);
				} catch (err) {
					log.error("Error handling one discord messageDeleteBulk event", err);
				}
			}
		});
		client.on("typingStart", async (chan: Discord.Channel, user: Discord.User) => {
			try {
				const params = this.getSendParams(puppetId, chan, user);
				await this.puppet.setUserTyping(params, true);
			} catch (err) {
				log.error("Error handling discord typingStart event", err);
			}
		});
		client.on("typingStop", async (chan: Discord.Channel, user: Discord.User) => {
			try {
				const params = this.getSendParams(puppetId, chan, user);
				await this.puppet.setUserTyping(params, false);
			} catch (err) {
				log.error("Error handling discord typingStop event", err);
			}
		});
		client.on("presenceUpdate", async (_, member: Discord.GuildMember) => {
			try {
				const user = member.user;
				const matrixPresence = {
					online: "online",
					idle: "unavailable",
					dnd: "unavailable",
					offline: "offline",
				}[user.presence.status] as "online" | "offline" | "unavailable";
				const statusMsg = member.presence.game ? member.presence.game.name : "";
				const remoteUser = this.getRemoteUser(puppetId, user);
				await this.puppet.setUserPresence(remoteUser, matrixPresence);
				await this.puppet.setUserStatus(remoteUser, statusMsg);
			} catch (err) {
				log.error("Error handling discord presenceUpdate event", err);
			}
		});
		client.on("messageReactionAdd", async (reaction: Discord.MessageReaction, user: Discord.User) => {
			try {
				if (reaction.me) {
					return; // TODO: filter this out better
				}
				const chan = reaction.message.channel;
				if (!await this.bridgeChannel(puppetId, chan)) {
					return;
				}
				const params = this.getSendParams(puppetId, chan, user);
				await this.puppet.sendReaction(params, reaction.message.id, reaction.emoji.name);
			} catch (err) {
				log.error("Error handling discord messageReactionAdd event", err);
			}
		});
		client.on("guildUpdate", async (_, guild: Discord.Guild) => {
			try {
				const remoteGroup = await this.getRemoteGroup(puppetId, guild);
				await this.puppet.updateGroup(remoteGroup);
			} catch (err) {
				log.error("Error handling discord guildUpdate event", err);
			}
		});
		this.puppets[puppetId] = {
			client,
			data,
			sentEventIds: [],
		};
		await client.login(data.token);
	}

	public async deletePuppet(puppetId: number) {
		log.info(`Got signal to quit Puppet: puppetId=${puppetId}`);
		const p = this.puppet[puppetId];
		if (!p) {
			return; // nothing to do
		}
		await p.client.destroy();
		delete this.puppet[puppetId];
	}

	public async createChan(chan: IRemoteChan): Promise<IRemoteChan | null> {
		return await this.getRemoteChanById(chan.puppetId, chan.roomId);
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
		return this.getRemoteUser(user.puppetId, u);
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
		const blacklistedIds = [p.client.user.id, "1"];
		for (const [, guild] of Array.from(p.client.guilds)) {
			retGuilds.push({
				category: true,
				name: guild.name,
			});
			for (const [, member] of Array.from(guild.members)) {
				if (!blacklistedIds.includes(member.user.id)) {
					retGuilds.push({
						name: member.user.username,
						id: member.user.id,
					});
				}
			}
		}

		for (const [, user] of Array.from(p.client.users)) {
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

	public async listChans(puppetId: number): Promise<IRetList[]> {
		const retGroups: IRetList[] = [];
		const retGuilds: IRetList[] = [];
		const p = this.puppets[puppetId];
		if (!p) {
			return [];
		}
		for (const [, guild] of Array.from(p.client.guilds)) {
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
		for (const [, chan] of Array.from(p.client.channels)) {
			if (chan.type === "group") {
				const found = retGuilds.find((element) => element.id === chan.id);
				if (!found) {
					retGroups.push({
						name: (chan as Discord.GroupDMChannel).name,
						id: chan.id,
					});
				}
			}
		}
		return retGroups.concat(retGuilds);
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
			const permissions = chan.memberPermissions(p.client.user);
			if (!permissions || permissions.has(Discord.Permissions.FLAGS.VIEW_CHANNEL as number)) {
				const remoteChan = this.getRemoteChan(puppetId, chan);
				await this.puppet.bridgeChannel(remoteChan);
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
		for (const [, guild] of Array.from(p.client.guilds)) {
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
		msg += `or type \`listchannels\` and join that way.

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
		let sendStr = "Friends:\n";
		for (const [, user] of p.client.user.friends) {
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
		sendStr += "\nIncoming friend requests:\n";
		for (const [, user] of p.client.user.incomingFriendRequests) {
			const sendStrPart = ` - ${user.username} (\`${user.id}\`)\n`;
			if (sendStr.length + sendStrPart.length > MAX_MSG_SIZE) {
				await sendMessage(sendStr);
				sendStr = "";
			}
			sendStr += sendStrPart;
		}
		sendStr += "\nOutgoing friend requests:\n";
		for (const [, user] of p.client.user.outgoingFriendRequests) {
			const sendStrPart = ` - ${user.username} (\`${user.id}\`)\n`;
			if (sendStr.length + sendStrPart.length > MAX_MSG_SIZE) {
				await sendMessage(sendStr);
				sendStr = "";
			}
			sendStr += sendStrPart;
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
			const user = await p.client.user.addFriend(param);
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
			const user = await p.client.user.removeFriend(param);
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

	private async bridgeChannel(puppetId: number, chan: Discord.Channel): Promise<boolean> {
		if (["dm", "group"].includes(chan.type)) {
			return true; // we handle all dm and group channels
		}
		if (chan.type === "text") {
			// we have a guild text channel, maybe we handle it!
			const textChan = chan as Discord.TextChannel;
			if (await this.store.isGuildBridged(puppetId, textChan.guild.id)) {
				return true;
			}
			// maybe it is a single channel override?
			return await this.store.isChannelBridged(puppetId, chan.id);
		}
		return false;
	}

	private async sendMessageFail(room: IRemoteChan) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			return;
		}
		let msg = "";
		if (chan.type === "dm") {
			msg = `Failed to send message to DM with user ${(chan as Discord.DMChannel).recipient.username}`;
		} else if (chan.type === "group") {
			const groupChan = chan as Discord.GroupDMChannel;
			let name = groupChan.name;
			if (!name) {
				const names: string[] = [];
				for (const [, user] of groupChan.recipients) {
					names.push(user.username);
				}
				name = names.join(", ");
			}
			msg = `Failed to send message into Group DM ${name}`;
		} else if (chan.type === "text") {
			const textChan = chan as Discord.TextChannel;
			msg = `Failed to send message into channel ${textChan.name} of guild ${textChan.guild.name}`;
		} else {
			msg = `Failed to send message into channel with id \`${chan.id}\``;
		}
		await this.puppet.sendStatusMessage(room, msg);
	}

	private async parseMatrixMessage(puppetId: number, eventContent: any): Promise<string> {
		const opts = {
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
				getChannelId: async (mxid: string) => null,
				getEmoji: async (mxc: string, name: string) => null, // TODO: handle emoji
				mxcUrlToHttp: (mxc: string) => this.puppet.getUrlFromMxc(mxc),
			},
		} as IMatrixMessageParserOpts;
		const msg = await this.matrixMsgParser.FormatMessage(opts, eventContent);
		return msg;
	}

	private async getUserById(client: Discord.Client, id: string): Promise<Discord.User | null> {
		for (const [, guild] of Array.from(client.guilds)) {
			const a = guild.members.find((m) => m.user.id === id);
			if (a) {
				return a.user as Discord.User;
			}
		}
		{
			const user = client.user.friends.get(id);
			if (user) {
				return user;
			}
		}
		{
			const user = await client.fetchUser(id);
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
				if (chan.type === "group") {
					return chan as Discord.GroupDMChannel;
				}
				if (chan.type === "text") {
					return chan as Discord.TextChannel;
				}
			}
			// next iterate over all the guild channels
			for (const [, guild] of Array.from(client.guilds)) {
				const c = guild.channels.get(id);
				if (c && c.type === "text") {
					return c as Discord.TextChannel;
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

	private getDiscordMsgParserCallbacks(puppetId: number) {
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
			getChannel: async (id: string) => null, // we don't handle channels
			getEmoji: async (name: string, animated: boolean, id: string) => {
				let emoji = await this.store.getEmoji(id);
				if (emoji) {
					return emoji.mxcUrl;
				}
				const url = `https://cdn.discordapp.com/emojis/${id}${animated ? ".gif" : ".png"}`;
				const buffer = await Util.DownloadFile(url);
				const mxcUrl = await this.puppet.botIntent.underlyingClient.uploadContent(
					buffer,
					Util.GetMimeType(buffer),
				);
				emoji = {
					emojiId: id,
					name,
					animated,
					mxcUrl,
				};
				await this.store.setEmoji(emoji);
				return emoji.mxcUrl;
			},
		} as IDiscordMessageParserCallbacks;
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
		for (const [, chan] of Array.from(guild.channels)) {
			if (!bridgedGuilds.includes(guild.id) && !bridgedChannels.includes(chan.id)) {
				continue;
			}
			const permissions = chan.memberPermissions(client.user);
			if (!chan.parentID && chan.type === "text" &&
				(!permissions || permissions.has(Discord.Permissions.FLAGS.VIEW_CHANNEL as number))) {
				await chanCallback(chan as Discord.TextChannel);
			}
		}
		// next we iterate over the categories and all their children
		for (const [, catt] of Array.from(guild.channels)) {
			if (catt.type !== "category") {
				continue;
			}
			const cat = catt as Discord.CategoryChannel;
			const catPermissions = cat.memberPermissions(client.user);
			if (!catPermissions || catPermissions.has(Discord.Permissions.FLAGS.VIEW_CHANNEL as number)) {
				let doCat = false;
				for (const [, chan] of Array.from(cat.children)) {
					if (!bridgedGuilds.includes(guild.id) && !bridgedChannels.includes(chan.id)) {
						continue;
					}
					const permissions = chan.memberPermissions(client.user);
					if (chan.type === "text" && (!permissions || permissions.has(Discord.Permissions.FLAGS.VIEW_CHANNEL as number))) {
						if (!doCat) {
							doCat = true;
							await catCallback(cat);
						}
						await chanCallback(chan as Discord.TextChannel);
					}
				}
			}
		}
	}
}
