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

	public async getEmojiMxc(name: string, animated: boolean, id: string): Promise<string | null> {
		let emoji = await this.app.store.getEmoji(id);
		if (emoji) {
			return emoji.mxcUrl;
		}
		const url = `https://cdn.discordapp.com/emojis/${id}${animated ? ".gif" : ".png"}`;
		const mxcUrl = await this.app.puppet.uploadContent(
			null,
			url,
		);
		emoji = {
			emojiId: id,
			name,
			animated,
			mxcUrl,
		};
		await this.app.store.setEmoji(emoji);
		return emoji.mxcUrl;
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
				for (const gchan of member.guild.channels.array()) {
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
			async (chan: Discord.TextChannel) => {
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

	public async insertNewEventId(puppetId: number, matrixId: string, msgs: Discord.Message | Discord.Message[]) {
		const p = this.app.puppets[puppetId];
		if (!Array.isArray(msgs)) {
			msgs = [msgs];
		}
		for (const m of msgs) {
			const lockKey = `${puppetId};${m.channel.id}`;
			await this.app.puppet.eventSync.insert(puppetId, matrixId, m.id);
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
		for (const guild of p.client.guilds.array()) {
			const member = guild.members.get(u.id);
			if (member) {
				for (const chan of guild.channels.array()) {
					if (chan.type === "text") {
						remoteUser.roomOverrides[chan.id] = this.getRemoteUserRoomOverride(member, chan);
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

		const guild = p.client.guilds.get(group.groupId);
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
		for (const guild of p.client.guilds.array()) {
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
		for (const chan of p.client.channels.array()) {
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
					const dbEmoji = await this.app.store.getEmojiByMxc(mxc);
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
		} else if (chan instanceof Discord.TextChannel) {
			msg = `Failed to send message into channel ${chan.name} of guild ${chan.guild.name}`;
		} else {
			msg = `Failed to send message into channel with id \`${(chan as Discord.Channel).id}\``;
		}
		await this.app.puppet.sendStatusMessage(room, msg);
	}
}
