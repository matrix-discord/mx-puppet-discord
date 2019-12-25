import {
	PuppetBridge,
	Log,
	IReceiveParams,
	IRemoteChan,
	IRemoteUser,
	IMessageEvent,
	IFileEvent,
	Util,
	IRetList,
	Lock,
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

const log = new Log("DiscordPuppet:Discord");

const MAXFILESIZE = 8000000;
const SEND_LOOCK_TIMEOUT = 30000;

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

	public getRemoteUser(puppetId: number, user: Discord.User): IRemoteUser {
		return {
			userId: user.id,
			puppetId,
			avatarUrl: user.avatarURL,
			name: user.username,
		};
	}

	public getRemoteChan(puppetId: number, channel: Discord.Channel): IRemoteChan {
		const p = this.puppets[puppetId];
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

	public getSendParams(puppetId: number, msg: Discord.Message | Discord.Channel, user?: Discord.User): IReceiveParams {
		let channel: Discord.Channel;
		let eventId: string | undefined;
		if (!user) {
			channel = (msg as Discord.Message).channel;
			user = (msg as Discord.Message).author;
			eventId = (msg as Discord.Message).id;
		} else {
			channel = msg as Discord.Channel;
		}
		return {
			chan: this.getRemoteChan(puppetId, channel),
			user: this.getRemoteUser(puppetId, user),
			eventId,
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
		const reply = await chan.send(sendMsg);
		await this.insertNewEventId(room.puppetId, data.eventId!, reply);
		this.sendMessageLock.release(lockKey);
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
				const reply = await chan!.send(new Discord.Attachment(attachment, filename));
				await this.insertNewEventId(room.puppetId, data.eventId!, reply);
				this.sendMessageLock.release(lockKey);
				return;
			}
		}
		this.sendMessageLock.set(lockKey);
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
		if (!this.bridgeChannel(puppetId, msg.channel)) {
			log.info("Only handling DM channels, dropping message...");
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
		for ( const [, attachment] of Array.from(msg.attachments)) {
			await this.puppet.sendFileDetect(params, attachment.url, attachment.filename);
		}
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
		if (!this.bridgeChannel(puppetId, msg1.channel)) {
			log.info("Only handling DM channels, dropping message...");
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
		if (!this.bridgeChannel(puppetId, msg.channel)) {
			log.info("Only handling DM channels, dropping message...");
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
				if (!this.bridgeChannel(puppetId, chan)) {
					return;
				}
				const params = this.getSendParams(puppetId, chan, user);
				await this.puppet.sendReaction(params, reaction.message.id, reaction.emoji.name);
			} catch (err) {
				log.error("Error handling discord messageReactionAdd event", err);
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
		const u = await this.getUserById(p.client, user.userId);
		if (!u) {
			return null;
		}
		return this.getRemoteUser(user.puppetId, u);
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

	private bridgeChannel(puppetId: number, chan: Discord.Channel): boolean {
		return chan.type === "dm" || chan.type === "group"; // currently we only allow dm bridging
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
		const user = await client.fetchUser(id);
		if (user) {
			return user;
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
}
