import {
	PuppetBridge,
	Log,
	IReceiveParams,
	IRemoteChan,
	IRemoteUser,
	IMessageEvent,
	IFileEvent,
	Util,
} from "mx-puppet-bridge";
import * as Discord from "discord.js";
import {
	IDiscordMessageParserOpts,
	DiscordMessageParser,
	IMatrixMessageParserOpts,
	MatrixMessageParser,
	IDiscordMessageParserCallbacks,
} from "matrix-discord-parser";
import * as path from "path";
import * as mime from "mime";

const log = new Log("DiscordPuppet:Discord");

const MAXFILESIZE = 8000000;

interface IDiscordPuppet {
	client: Discord.Client;
	data: any;
}

interface IDiscordPuppets {
	[puppetId: number]: IDiscordPuppet;
}

export class DiscordClass {
	private puppets: IDiscordPuppets = {};
	private discordMsgParser: DiscordMessageParser;
	private matrixMsgParser: MatrixMessageParser;
	constructor(
		private puppet: PuppetBridge,
	) {
		this.discordMsgParser = new DiscordMessageParser();
		this.matrixMsgParser = new MatrixMessageParser();
	}

	public getRemoteUser(puppetId: number, user: Discord.User): IRemoteUser {
		return {
			userId: user.id,
			puppetId,
			avatarUrl: user.avatarURL,
			name: user.username,
		};
	}

	public getSendParams(puppetId: number, msg: Discord.Message | Discord.Channel, user?: Discord.User): IReceiveParams {
		let channel: Discord.Channel;
		if (!user) {
			channel = (msg as Discord.Message).channel;
			user = (msg as Discord.Message).author;
		} else {
			channel = msg as Discord.Channel;
		}
		return {
			chan: {
				roomId: channel.type === "dm" ? `dm-${user.id}` : channel.id,
				puppetId,
				isDirect: channel.type === "dm",
			},
			user: this.getRemoteUser(puppetId, user),
		} as IReceiveParams;
	}

	public async insertNewEventId(puppetId: number, matrixId: string, msgs: Discord.Message | Discord.Message[]) {
		if (!Array.isArray(msgs)) {
			msgs = [msgs];
		}
		for (const m of msgs) {
			await this.puppet.eventStore.insert(puppetId, matrixId, m.id);
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
		const reply = await chan.send(sendMsg);
		await this.insertNewEventId(room.puppetId, data.eventId!, reply);
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
		if (size < MAXFILESIZE) {
			const attachment = await Util.DownloadFile(data.url);
			size = attachment.byteLength;
			if (size < MAXFILESIZE) {
				// send as attachment
				const filename = this.getFilenameForMedia(data.filename, mimetype);
				const reply = await chan!.send(new Discord.Attachment(attachment, filename));
				await this.insertNewEventId(room.puppetId, data.eventId!, reply);
				return;
			}
		}
		if (mimetype && mimetype.split("/")[0] === "image") {
			const embed = new Discord.RichEmbed()
				.setTitle(data.filename)
				.setImage(data.url);
			const reply = await chan.send(embed);
			await this.insertNewEventId(room.puppetId, data.eventId!, reply);
		} else {
			const reply = await chan.send(`Uploaded File: [${data.filename}](${data.url})`);
			await this.insertNewEventId(room.puppetId, data.eventId!, reply);
		}
	}

	public async handleMatrixRedact(room: IRemoteChan, eventId: string, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
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
		const reply = await msg.edit(sendMsg);
		await this.insertNewEventId(room.puppetId, data.eventId!, reply);
	}

	public async handleDiscordMessage(puppetId: number, msg: Discord.Message) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		if (msg.author.id === p.client.user.id) {
			return; // TODO: proper filtering for double-puppetting
		}
		log.info("Received new message!");
		if (msg.channel.type !== "dm") {
			log.info("Only handling DM channels, dropping message...");
			return;
		}
		const params = this.getSendParams(puppetId, msg);
		params.eventId = msg.id;
		for ( const [_, attachment] of Array.from(msg.attachments)) {
			await this.puppet.sendFileDetect(params, attachment.url, attachment.filename);
		}
		if (msg.content) {
			const opts = {
				callbacks: this.getDiscordMsgParserCallbacks(puppetId),
			} as IDiscordMessageParserOpts;
			const reply = await this.discordMsgParser.FormatMessage(opts, msg);
			await this.puppet.sendMessage(params, {
				body: reply.body,
				formattedBody: reply.formattedBody,
				emote: reply.msgtype === "m.emote",
				notice: reply.msgtype === "m.notice",
			});
		}
	}

	public async handleDiscordMessageUpdate(puppetId: number, msg1: Discord.Message, msg2: Discord.Message) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		if (msg1.author.id === p.client.user.id) {
			return; // TODO: proper filtering for double-puppetting
		}
		if (msg1.channel.type !== "dm") {
			log.info("Only handling DM channels, dropping message...");
			return;
		}
		const params = this.getSendParams(puppetId, msg1);
		const opts = {
			callbacks: this.getDiscordMsgParserCallbacks(puppetId),
		} as IDiscordMessageParserOpts;
		const reply = await this.discordMsgParser.FormatMessage(opts, msg2);
		await this.puppet.sendEdit(params, msg1.id, {
			body: reply.body,
			formattedBody: reply.formattedBody,
			emote: reply.msgtype === "m.emote",
			notice: reply.msgtype === "m.notice",
		});
	}

	public async handleDiscordMessageDelete(puppetId: number, msg: Discord.Message) {
		const params = this.getSendParams(puppetId, msg);
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
		});
		client.on("message", async (msg: Discord.Message) => {
			await this.handleDiscordMessage(puppetId, msg);
		});
		client.on("messageUpdate", async (msg1: Discord.Message, msg2: Discord.Message) => {
			await this.handleDiscordMessageUpdate(puppetId, msg1, msg2);
		});
		client.on("messageDelete", async (msg: Discord.Message) => {
			await this.handleDiscordMessageDelete(puppetId, msg);
		});
		client.on("messageDeleteBulk", async (msgs: Discord.Collection<Discord.Snowflake, Discord.Message>) => {
			for (const [_, msg] of Array.from(msgs)) {
				await this.handleDiscordMessageDelete(puppetId, msg);
			}
		});
		client.on("typingStart", async (chan: Discord.Channel, user: Discord.User) => {
			const params = this.getSendParams(puppetId, chan, user);
			await this.puppet.setUserTyping(params, true);
		});
		client.on("typingStop", async (chan: Discord.Channel, user: Discord.User) => {
			const params = this.getSendParams(puppetId, chan, user);
			await this.puppet.setUserTyping(params, false);
		});
		client.on("presenceUpdate", async (_, member: Discord.GuildMember) => {
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
		});
		this.puppets[puppetId] = {
			client,
			data,
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
				getEmojiId: async (mxc: string, name: string) => null, // TODO: handle emoji
				mxcUrlToHttp: (mxc: string) => this.puppet.getUrlFromMxc(mxc),
			},
		} as IMatrixMessageParserOpts;
		const msg = await this.matrixMsgParser.FormatMessage(opts, eventContent);
		return msg;
	}

	private getUserById(client: Discord.Client, id: string): Discord.User | null {
		for (const [_, guild] of Array.from(client.guilds)) {
			const a = guild.members.find((m) => m.user.id === id);
			if (a) {
				return a.user as Discord.User;
			}
		}
		return null;
	}

	private async getDiscordChan(client: Discord.Client, id: string): Promise<Discord.DMChannel | null> {
		if (!id.startsWith("dm-")) {
			return null; // not a DM channel, not implemented yet
		}
		const lookupId = id.substring("dm-".length);
		const user = this.getUserById(client, lookupId);
		if (!user) {
			return null;
		}
		const chan = await user.createDM();
		return chan;
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
				const user = this.getUserById(p.client, id);
				if (user) {
					name = user.username;
				}
				return {
					mxid,
					name,
				};
			},
			getChannel: async (id: string) => null, // we don't handle channels
			getEmoji: async (name: string, animated: boolean, id: string) => null, // TODO: handle emoji
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
