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

import {
	PuppetBridge,
	Log,
	Util,
	IRetList,
	MessageDeduplicator,
	ExpireSet,
	IRemoteRoom,
} from "mx-puppet-bridge";
import * as Discord from "better-discord.js";
import {
	DiscordMessageParser,
	MatrixMessageParser,
} from "matrix-discord-parser";
import * as path from "path";
import * as mime from "mime";
import { DiscordStore } from "./store";
import { DiscordUtil } from "./discord/DiscordUtil";
import { MatrixUtil } from "./matrix/MatrixUtil";
import { Commands } from "./Commands";

const log = new Log("DiscordPuppet:App");
export const AVATAR_SETTINGS: Discord.ImageURLOptions & { dynamic?: boolean | undefined; }
= { format: "png", size: 2048, dynamic: true };
export const MAXFILESIZE = 8000000;

export interface IDiscordPuppet {
	client: Discord.Client;
	data: any;
	deletedMessages: ExpireSet<string>;
}

export interface IDiscordPuppets {
	[puppetId: number]: IDiscordPuppet;
}

export interface IDiscordSendFile {
	buffer: Buffer;
	filename: string;
	url: string;
	isImage: boolean;
}

export class App {
	public puppets: IDiscordPuppets = {};
	public discordMsgParser: DiscordMessageParser;
	public matrixMsgParser: MatrixMessageParser;
	public messageDeduplicator: MessageDeduplicator;
	public store: DiscordStore;
	public lastEventIds: {[chan: string]: string} = {};

	public readonly discord: DiscordUtil;
	public readonly matrix: MatrixUtil;
	public readonly commands: Commands;

	constructor(
		public puppet: PuppetBridge,
	) {
		this.discordMsgParser = new DiscordMessageParser();
		this.matrixMsgParser = new MatrixMessageParser();
		this.messageDeduplicator = new MessageDeduplicator();
		this.store = new DiscordStore(puppet.store);

		this.discord = new DiscordUtil(this);
		this.matrix = new MatrixUtil(this);
		this.commands = new Commands(this);
	}

	public async init(): Promise<void> {
		await this.store.init();
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
			for (const user of client.users.array()) {
				await this.discord.updatePresence(puppetId, user.presence);
			}
		});
		client.on("message", async (msg: Discord.Message) => {
			try {
				await this.discord.events.handleDiscordMessage(puppetId, msg);
			} catch (err) {
				log.error("Error handling discord message event", err.error || err.body || err);
			}
		});
		client.on("messageUpdate", async (msg1: Discord.Message, msg2: Discord.Message) => {
			try {
				await this.discord.events.handleDiscordMessageUpdate(puppetId, msg1, msg2);
			} catch (err) {
				log.error("Error handling discord messageUpdate event", err.error || err.body || err);
			}
		});
		client.on("messageDelete", async (msg: Discord.Message) => {
			try {
				await this.discord.events.handleDiscordMessageDelete(puppetId, msg);
			} catch (err) {
				log.error("Error handling discord messageDelete event", err.error || err.body || err);
			}
		});
		client.on("messageDeleteBulk", async (msgs: Discord.Collection<Discord.Snowflake, Discord.Message>) => {
			for (const msg of msgs.array()) {
				try {
					await this.discord.events.handleDiscordMessageDelete(puppetId, msg);
				} catch (err) {
					log.error("Error handling one discord messageDeleteBulk event", err.error || err.body || err);
				}
			}
		});
		client.on("typingStart", async (chan: Discord.Channel, user: Discord.User) => {
			try {
				const params = this.matrix.getSendParams(puppetId, chan, user);
				await this.puppet.setUserTyping(params, true);
			} catch (err) {
				log.error("Error handling discord typingStart event", err.error || err.body || err);
			}
		});
		client.on("typingStop", async (chan: Discord.Channel, user: Discord.User) => {
			try {
				const params = this.matrix.getSendParams(puppetId, chan, user);
				await this.puppet.setUserTyping(params, false);
			} catch (err) {
				log.error("Error handling discord typingStop event", err.error || err.body || err);
			}
		});
		client.on("presenceUpdate", async (_, presence: Discord.Presence) => {
			try {
				await this.discord.updatePresence(puppetId, presence);
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
				const params = this.matrix.getSendParams(puppetId, chan, user);
				if (reaction.emoji.id) {
					const mxc = await this.matrix.getEmojiMxc(reaction.emoji.name, reaction.emoji.animated, reaction.emoji.id);
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
				const params = this.matrix.getSendParams(puppetId, chan, user);
				if (reaction.emoji.id) {
					const mxc = await this.matrix.getEmojiMxc(reaction.emoji.name, reaction.emoji.animated, reaction.emoji.id);
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
				const params = this.matrix.getSendParams(puppetId, chan, user);
				await this.puppet.removeAllReactions(params, message.id);
			} catch (err) {
				log.error("Error handling discord messageReactionRemoveAll event", err.error || err.body || err);
			}
		});
		client.on("channelUpdate", async (_, channel: Discord.Channel) => {
			const remoteChan = this.matrix.getRemoteRoom(puppetId, channel);
			await this.puppet.updateRoom(remoteChan);
		});
		client.on("guildMemberUpdate", async (oldMember: Discord.GuildMember, newMember: Discord.GuildMember) => {
			const promiseList: Promise<void>[] = [];
			if (oldMember.displayName !== newMember.displayName) {
				promiseList.push((async () => {
					const remoteUser = this.matrix.getRemoteUser(puppetId, newMember);
					await this.puppet.updateUser(remoteUser);
				})());
			}
			// aaaand check for role change
			const leaveRooms = new Set<Discord.TextChannel>();
			const joinRooms = new Set<Discord.TextChannel>();
			for (const chan of newMember.guild.channels.array()) {
				if (!(chan instanceof Discord.TextChannel)) {
					continue;
				}
				if (chan.members.has(newMember.id)) {
					joinRooms.add(chan);
				} else {
					leaveRooms.add(chan);
				}
			}
			for (const chan of leaveRooms) {
				promiseList.push((async () => {
					const params = this.matrix.getSendParams(puppetId, chan, newMember);
					await this.puppet.removeUser(params);
				})());
			}
			for (const chan of joinRooms) {
				promiseList.push((async () => {
					const params = this.matrix.getSendParams(puppetId, chan, newMember);
					await this.puppet.addUser(params);
				})());
			}
			await Promise.all(promiseList);
		});
		client.on("userUpdate", async (_, user: Discord.User) => {
			const remoteUser = this.matrix.getRemoteUser(puppetId, user);
			await this.puppet.updateUser(remoteUser);
		});
		client.on("guildUpdate", async (_, guild: Discord.Guild) => {
			try {
				const remoteGroup = await this.matrix.getRemoteGroup(puppetId, guild);
				await this.puppet.updateGroup(remoteGroup);
				for (const chan of guild.channels.array()) {
					const remoteChan = this.matrix.getRemoteRoom(puppetId, chan);
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
		client.on("guildMemberAdd", async (member: Discord.GuildMember) => {
			const promiseList: Promise<void>[] = [];
			for (const chan of member.guild.channels.array()) {
				if ((await this.bridgeRoom(puppetId, chan)) && chan.members.has(member.id)) {
					promiseList.push((async () => {
						const params = this.matrix.getSendParams(puppetId, chan, member);
						await this.puppet.addUser(params);
					})());
				}
			}
			await Promise.all(promiseList);
		});
		client.on("guildMemberRemove", async (member: Discord.GuildMember) => {
			const promiseList: Promise<void>[] = [];
			for (const chan of member.guild.channels.array()) {
				promiseList.push((async () => {
					const params = this.matrix.getSendParams(puppetId, chan, member);
					await this.puppet.removeUser(params);
				})());
			}
			await Promise.all(promiseList);
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
			for (const member of guild.members.array()) {
				if (!blacklistedIds.includes(member.user.id)) {
					retGuilds.push({
						name: member.user.username,
						id: member.user.id,
					});
				}
			}
		}

		for (const user of p.client.users.array()) {
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

	public async getUserIdsInRoom(room: IRemoteRoom): Promise<Set<string> | null> {
		const chan = await this.discord.getDiscordChan(room);
		if (!chan) {
			return null;
		}
		const users = new Set<string>();
		if (chan instanceof Discord.DMChannel) {
			users.add(chan.recipient.id);
			return users;
		}
		if (chan instanceof Discord.GroupDMChannel) {
			for (const recipient of chan.recipients.array()) {
				users.add(recipient.id);
			}
			return users;
		}
		if (chan instanceof Discord.TextChannel) {
			// chan.members already does a permission check, yay!
			for (const member of chan.members.array()) {
				users.add(member.id);
			}
			return users;
		}
		return null;
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

	public async bridgeRoom(puppetId: number, chan: Discord.Channel): Promise<boolean> {
		if (["dm", "group"].includes(chan.type)) {
			return true; // we handle all dm and group channels
		}
		if (!["text", "news"].includes(chan.type)) {
			return false; // we only handle text and news things
		}
		if (this.puppets[puppetId] && this.puppets[puppetId].data.bridgeAll) {
			return true; // we want to bridge everything anyways, no need to hit the store
		}
		if (chan instanceof Discord.TextChannel || chan instanceof Discord.NewsChannel) {
			// we have a guild text channel, maybe we handle it!
			if (await this.store.isGuildBridged(puppetId, chan.guild.id)) {
				return true;
			}
			// maybe it is a single channel override?
			return await this.store.isChannelBridged(puppetId, chan.id);
		}
		return false;
	}

	public getFilenameForMedia(filename: string, mimetype: string): string {
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
