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
import { App, AVATAR_SETTINGS } from "../app";
import * as Discord from "better-discord.js";
import { IStringFormatterVars, IRemoteUser, IRemoteRoom,
	IRemoteGroup, IRemoteUserRoomOverride, IReceiveParams, IRetList, Log,
} from "mx-puppet-bridge";
import * as escapeHtml from "escape-html";
import { IMatrixMessageParserOpts } from "matrix-discord-parser";
import { MatrixEventHandler } from "./MatrixEventHandler";
import { TextGuildChannel, TextChannel, BridgeableGuildChannel, BridgeableChannel } from "../discord/DiscordUtil";

const log = new Log("DiscordPuppet:MatrixUtil");

export class MatrixUtil {
	public readonly events: MatrixEventHandler;

	public constructor(private readonly app: App) {
		this.events = new MatrixEventHandler(app);
	}

	public async getDmRoom(user: IRemoteUser): Promise<string | null> {
		const p = this.app.puppets[user.puppetId];
		if (!p) {
			return null;
		}
		const u = await this.app.discord.getUserById(p.client, user.userId);
		if (!u) {
			return null;
		}
		return `dm-${user.puppetId}-${u.id}`;
	}

	public async getEmojiMxc(puppetId: number, name: string, animated: boolean, id: string): Promise<string | null> {
		const emoji = await this.app.puppet.emoteSync.get({
			puppetId,
			emoteId: id,
		});
		if (emoji && emoji.avatarMxc) {
			return emoji.avatarMxc;
		}
		const { emote } = await this.app.puppet.emoteSync.set({
			puppetId,
			emoteId: id,
			avatarUrl: `https://cdn.discordapp.com/emojis/${id}${animated ? ".gif" : ".png"}`,
			name,
			data: {
				animated,
				name,
			},
		});
		return emote.avatarMxc || null;
	}

	public getSendParams(
		puppetId: number,
		msgOrChannel: Discord.Message | BridgeableChannel,
		user?: Discord.User | Discord.GuildMember,
	): IReceiveParams {
		let channel: BridgeableChannel;
		let eventId: string | undefined;
		let externalUrl: string | undefined;
		let isWebhook = false;
		let guildChannel: BridgeableGuildChannel | undefined;
		if (!user) {
			const msg = msgOrChannel as Discord.Message;
			channel = msg.channel;
			user = msg.member || msg.author;
			eventId = msg.id;
			isWebhook = msg.webhookID ? true : false;
			if (this.app.discord.isBridgeableGuildChannel(channel)) {
				guildChannel = channel as BridgeableGuildChannel;
				externalUrl = `https://discordapp.com/channels/${guildChannel.guild.id}/${guildChannel.id}/${eventId}`;
			} else if (["group", "dm"].includes(channel.type)) {
				externalUrl = `https://discordapp.com/channels/@me/${channel.id}/${eventId}`;
			}
		} else {
			channel = msgOrChannel as BridgeableChannel;
		}
		return {
			room: this.getRemoteRoom(puppetId, channel),
			user: this.getRemoteUser(puppetId, user, isWebhook, guildChannel),
			eventId,
			externalUrl,
		};
	}

	public getRemoteUserRoomOverride(member: Discord.GuildMember, chan: BridgeableGuildChannel): IRemoteUserRoomOverride {
		const nameVars: IStringFormatterVars = {
			name: member.user.username,
			discriminator: member.user.discriminator,
			displayname: member.displayName,
			channel: chan.name,
			guild: chan.guild.name,
		};
		return {
			nameVars,
		};
	}

	public getRemoteUser(
		puppetId: number,
		userOrMember: Discord.User | Discord.GuildMember,
		isWebhook: boolean = false,
		chan?: BridgeableGuildChannel,
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
				for (const gchan of member.guild.channels.cache.array()) {
					if (this.app.discord.isBridgeableGuildChannel(gchan)) {
						response.roomOverrides[gchan.id] = this.getRemoteUserRoomOverride(member, gchan as BridgeableGuildChannel);
					}
				}
			}
		}
		return response;
	}

	public getRemoteRoom(puppetId: number, channel: BridgeableChannel): IRemoteRoom {
		let roomId = channel.id;
		if (channel instanceof Discord.DMChannel) {
			roomId = `dm-${puppetId}-${channel.recipient.id}`;
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
		if (this.app.discord.isBridgeableGuildChannel(channel)) {
			const gchan = channel as BridgeableGuildChannel;
			ret.nameVars = {
				name: gchan.name,
				guild: gchan.guild.name,
			};
			ret.avatarUrl = gchan.guild.iconURL(AVATAR_SETTINGS);
			ret.groupId = gchan.guild.id;
			ret.topic = gchan.topic;
			ret.emotes = gchan.guild.emojis.cache.map((e) => {
				return {
					emoteId: e.id,
					name: e.name,
					avatarUrl: e.url,
					data: {
						animated: e.animated,
						name: e.name,
					},
					roomId: null,
				};
			});
		}
		return ret;
	}

	public async getRemoteRoomById(room: IRemoteRoom): Promise<IRemoteRoom | null> {
		const chan = await this.app.discord.getDiscordChan(room);
		if (!chan) {
			return null;
		}
		if (!await this.app.bridgeRoom(room.puppetId, chan)) {
			return null;
		}
		return this.getRemoteRoom(room.puppetId, chan);
	}

	public async getRemoteGroup(puppetId: number, guild: Discord.Guild): Promise<IRemoteGroup> {
		const roomIds: string[] = [];
		let description = `<h1>${escapeHtml(guild.name)}</h1>`;
		description += `<h2>Channels:</h2><ul>`;
		await this.app.discord.iterateGuildStructure(puppetId, guild,
			async (cat: Discord.CategoryChannel) => {
				const name = escapeHtml(cat.name);
				description += `</ul><h3>${name}</h3><ul>`;
			},
			async (chan: BridgeableGuildChannel) => {
				roomIds.push(chan.id);
				const mxid = await this.app.puppet.getMxidForRoom({
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

	public async insertNewEventId(room: IRemoteRoom, matrixId: string, msgs: Discord.Message | Discord.Message[]) {
		const p = this.app.puppets[room.puppetId];
		if (!Array.isArray(msgs)) {
			msgs = [msgs];
		}
		for (const m of msgs) {
			const lockKey = `${room.puppetId};${m.channel.id}`;
			await this.app.puppet.eventSync.insert(room, matrixId, m.id);
			this.app.messageDeduplicator.unlock(lockKey, p.client.user!.id, m.id);
			this.app.lastEventIds[m.channel.id] = m.id;
		}
	}

	public async createRoom(chan: IRemoteRoom): Promise<IRemoteRoom | null> {
		return await this.getRemoteRoomById(chan);
	}

	public async createUser(user: IRemoteUser): Promise<IRemoteUser | null> {
		const p = this.app.puppets[user.puppetId];
		if (!p) {
			return null;
		}
		if (user.userId.startsWith("webhook-")) {
			return null;
		}
		const u = await this.app.discord.getUserById(p.client, user.userId);
		if (!u) {
			return null;
		}
		const remoteUser = this.getRemoteUser(user.puppetId, u);
		remoteUser.roomOverrides = {};
		for (const guild of p.client.guilds.cache.array()) {
			const member = guild.members.resolve(u.id);
			if (member) {
				for (const chan of guild.channels.cache.array()) {
					if (this.app.discord.isBridgeableGuildChannel(chan)) {
						remoteUser.roomOverrides[chan.id] = this.getRemoteUserRoomOverride(member, chan as BridgeableGuildChannel);
					}
				}
			}
		}
		return remoteUser;
	}

	public async createGroup(group: IRemoteGroup): Promise<IRemoteGroup | null> {
		const p = this.app.puppets[group.puppetId];
		if (!p) {
			return null;
		}

		const guild = p.client.guilds.resolve(group.groupId);
		if (!guild) {
			return null;
		}
		return await this.getRemoteGroup(group.puppetId, guild);
	}

	public async listRooms(puppetId: number): Promise<IRetList[]> {
		const retGroups: IRetList[] = [];
		const retGuilds: IRetList[] = [];
		const p = this.app.puppets[puppetId];
		if (!p) {
			return [];
		}
		for (const guild of p.client.guilds.cache.array()) {
			let didGuild = false;
			let didCat = false;
			await this.app.discord.iterateGuildStructure(puppetId, guild,
				async (cat: Discord.CategoryChannel) => {
					didCat = true;
					retGuilds.push({
						category: true,
						name: `${guild.name} - ${cat.name}`,
					});
				},
				async (chan: BridgeableGuildChannel) => {
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
		for (const chan of p.client.channels.cache.array()) {
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

	public async parseMatrixMessage(puppetId: number, eventContent: any): Promise<string> {
		const opts: IMatrixMessageParserOpts = {
			displayname: "", // something too short
			callbacks: {
				canNotifyRoom: async () => true,
				getUserId: async (mxid: string) => {
					const parts = this.app.puppet.userSync.getPartsFromMxid(mxid);
					if (!parts || (parts.puppetId !== puppetId && parts.puppetId !== -1)) {
						return null;
					}
					return parts.userId;
				},
				getChannelId: async (mxid: string) => {
					const parts = await this.app.puppet.roomSync.getPartsFromMxid(mxid);
					if (!parts || (parts.puppetId !== puppetId && parts.puppetId !== -1)) {
						return null;
					}
					return parts.roomId;
				},
				getEmoji: async (mxc: string, name: string) => {
					const emote = await this.app.puppet.emoteSync.getByMxc(puppetId, mxc);
					log.info("Found emoji", emote);
					if (!emote) {
						return null;
					}
					return {
						animated: Boolean(emote.data && emote.data.animated),
						name: ((emote.data && emote.data.name) || emote.name) as string,
						id: emote.emoteId,
					};
				},
				mxcUrlToHttp: (mxc: string) => this.app.puppet.getUrlFromMxc(mxc),
			},
			determineCodeLanguage: true,
		};
		const msg = await this.app.matrixMsgParser.FormatMessage(opts, eventContent);
		return msg;
	}

	public async sendMessageFail(room: IRemoteRoom) {
		const chan = await this.app.discord.getDiscordChan(room);
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
				for (const user of chan.recipients.array()) {
					names.push(user.username);
				}
				name = names.join(", ");
			}
			msg = `Failed to send message into Group DM ${name}`;
		} else if (this.app.discord.isBridgeableGuildChannel(chan)) {
			const gchan = chan as BridgeableGuildChannel;
			msg = `Failed to send message into channel ${gchan.name} of guild ${gchan.guild.name}`;
		} else {
			msg = `Failed to send message into channel with id \`${chan.id}\``;
		}
		await this.app.puppet.sendStatusMessage(room, msg);
	}
}
