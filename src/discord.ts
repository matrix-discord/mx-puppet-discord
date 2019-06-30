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
} from "matrix-discord-parser";

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
			user: {
				userId: user.id,
				puppetId,
				avatarUrl: user.avatarURL,
				name: user.username,
			},
		} as IReceiveParams;
	}

	public async handleMatrixMessage(room: IRemoteChan, data: IMessageEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}

		const opts = {
			displayname: "", // something too short
			callbacks: {
				canNotifyRoom: async () => true,
				getUserId: async (mxid: string) => {
					const parts = this.puppet.userSync.getPartsFromMxid(mxid);
					if (!parts || parts.puppetId !== room.puppetId) {
						return null;
					}
					return parts.userId;
				},
				getChannelId: async (mxid: string) => null,
				getEmojiId: async (mxc: string, name: string) => null, // TODO: handle emoji
				mxcUrlToHttp: (mxc: string) => this.puppet.getUrlFromMxc(mxc),
			},
		} as IMatrixMessageParserOpts;
		const sendMsg = await this.matrixMsgParser.FormatMessage(opts, event.content);
		await chan.send(sendMsg);
	}

	public async handleMatrixFile(room: IRemoteChan, data: IFileEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}

		const size = data.info ? data.info.size || 0 : 0;
		if (size < MAXFILESIZE) {
			const attachment = await Util.DownloadFile(data.url);
			if (size < MAXFILESIZE) {
				// send as attachment
				await chan.send(new Discord.Attachment(attachment, data.filename));
				return;
			}
		}
		await chan.send(`Uploaded File: [${data.filename}](${data.url})`);
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
		for ( const [_, attachment] of Array.from(msg.attachments)) {
			await this.puppet.sendFileDetect(params, attachment.url, attachment.filename);
		}
		if (msg.content) {
			const opts = {
				callbacks: {
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
				},
			} as IDiscordMessageParserOpts;
			const reply = await this.discordMsgParser.FormatMessage(opts, msg);
			await this.puppet.sendMessage(params, {
				body: reply.body,
				formatted_body: reply.formattedBody,
				emote: reply.msgtype === "m.emote",
				notice: reply.msgtype === "m.notice",
			});
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
			d.username = client.user.tag;
			d.id = client.user.id;
			await this.puppet.setUserId(puppetId, client.user.id);
			await this.puppet.setPuppetData(puppetId, d);
		});
		client.on("message", async (msg: Discord.Message) => {
			await this.handleDiscordMessage(puppetId, msg);
		});
		client.on("typingStart", async (chan: Discord.Channel, user: Discord.User) => {
			const params = this.getSendParams(puppetId, chan, user);
			await this.puppet.setUserTyping(params, true);
		});
		client.on("typingStop", async (chan: Discord.Channel, user: Discord.User) => {
			const params = this.getSendParams(puppetId, chan, user);
			await this.puppet.setUserTyping(params, false);
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

	private getUserById(client: Discord.Client, id: string): Discord.User | null {
		for (const [_, guild] of Array.from(client.guilds)) {
			const a = guild.members.find((m) => m.user.id === id);
			if (a) {
				return a.user as Discord.User;
			}
		}
		return null;
	}

	private getDiscordChan(client: Discord.Client, id: string): Discord.DMChannel | null {
		if (!id.startsWith("dm-")) {
			return null; // not a DM channel, not implemented yet
		}
		const lookupId = id.substring("dm-".length);
		const user = this.getUserById(client, lookupId);
		return user ? user as any : null;
	}
}
