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
import { App, IDiscordSendFile } from "../app";
import * as Discord from "better-discord.js";
import { DiscordEventHandler } from "./DiscordEventHandler";
import { ISendingUser, Log, IRemoteRoom } from "mx-puppet-bridge";
import { IDiscordMessageParserCallbacks } from "matrix-discord-parser";

const log = new Log("DiscordPuppet:DiscordUtil");

export type TextGuildChannel = Discord.TextChannel | Discord.NewsChannel;
export type TextChannel = TextGuildChannel | Discord.DMChannel | Discord.GroupDMChannel;

export type BridgeableGuildChannel = Discord.TextChannel | Discord.NewsChannel;
export type BridgeableChannel = BridgeableGuildChannel | Discord.DMChannel | Discord.GroupDMChannel;

export class DiscordUtil {
	public readonly events: DiscordEventHandler;

	public constructor(private readonly app: App) {
		this.events = new DiscordEventHandler(app);
	}

	public async getDiscordChan(
		room: IRemoteRoom,
	): Promise<BridgeableChannel | null> {
		const p = this.app.puppets[room.puppetId];
		if (!p) {
			return null;
		}
		const id = room.roomId;
		const client = p.client;
		if (!id.startsWith("dm-")) {
			// first fetch from the client channel cache
			const chan = client.channels.resolve(id);
			if (this.isBridgeableChannel(chan)) {
				return chan as BridgeableChannel;
			}
			// next iterate over all the guild channels
			for (const guild of client.guilds.cache.array()) {
				const c = guild.channels.resolve(id);
				if (this.isBridgeableChannel(c)) {
					return c as BridgeableChannel;
				}
			}
			return null; // nothing found
		} else {
			// we have a DM channel
			const parts = id.split("-");
			if (Number(parts[1]) !== room.puppetId) {
				return null;
			}
			const PART_USERID = 2;
			const lookupId = parts[PART_USERID];
			const user = await this.getUserById(client, lookupId);
			if (!user) {
				return null;
			}
			const chan = await user.createDM();
			return chan;
		}
	}

	public async sendToDiscord(
		chan: TextChannel,
		msg: string | IDiscordSendFile,
		asUser: ISendingUser | null,
	): Promise<Discord.Message | Discord.Message[]> {
		log.debug("Sending something to discord...");
		let sendThing: string | Discord.MessageAdditions;
		if (typeof msg === "string") {
			sendThing = msg;
		} else {
			sendThing = new Discord.MessageAttachment(msg.buffer, msg.filename);
		}
		if (!asUser) {
			// we don't want to relay, so just send off nicely
			log.debug("Not in relay mode, just sending as user");
			return await chan.send(sendThing);
		}
		// alright, we have to send as if it was another user. First try webhooks.
		if (this.isTextGuildChannel(chan)) {
			chan = chan as TextGuildChannel;
			const permissions = chan.permissionsFor(chan.client.user!);
			if (permissions && permissions.has(Discord.Permissions.FLAGS.MANAGE_WEBHOOKS)) {
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
						split: true,
					};
					if (typeof sendThing === "string") {
						return await hook.send(sendThing, hookOpts);
					}
					if (sendThing instanceof Discord.MessageAttachment) {
						hookOpts.files = [sendThing];
					}
					return await hook.send(hookOpts);
				}
				log.debug("Couldn't send as webhook");
			}
		}
		// alright, we either weren't able to send as webhook or we aren't in a webhook-able channel.
		// so.....let's try to send as embed next
		if (chan.client.user!.bot) {
			log.debug("Trying to send as embed...");
			const embed = new Discord.MessageEmbed();
			if (typeof msg === "string") {
				embed.setDescription(msg);
			} else if (msg.isImage) {
				embed.setTitle(msg.filename);
				embed.setImage(msg.url);
			} else {
				const filename = await this.discordEscape(msg.filename);
				embed.setDescription(`Uploaded a file \`${filename}\`: ${msg.url}`);
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
		} else {
			const filename = await this.discordEscape(msg.filename);
			sendMsg = `**${displayname}** uploaded a file \`${filename}\`: ${msg.url}`;
		}
		return await chan.send(sendMsg);
	}

	public async discordEscape(msg: string): Promise<string> {
		return await this.app.matrix.parseMatrixMessage(-1, {
			body: msg,
			msgtype: "m.text",
		});
	}

	public async updatePresence(puppetId: number, presence: Discord.Presence) {
		const p = this.app.puppets[puppetId];
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
				break;
			}
			const statusParts: string[] = [];
			if (activity.type !== "CUSTOM_STATUS") {
				const lower = activity.type.toLowerCase();
				statusParts.push(lower.charAt(0).toUpperCase() + lower.substring(1));
				if (activity.type === "LISTENING") {
					statusParts.push(`to ${activity.details} by ${activity.state}`);
				} else {
					if (activity.name) {
						statusParts.push(activity.name);
					}
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
		const remoteUser = this.app.matrix.getRemoteUser(puppetId, presence.user!);
		await this.app.puppet.setUserPresence(remoteUser, matrixPresence);
		if (statusMsg) {
			await this.app.puppet.setUserStatus(remoteUser, statusMsg);
		}
	}

	public getDiscordMsgParserCallbacks(puppetId: number): IDiscordMessageParserCallbacks {
		const p = this.app.puppets[puppetId];
		return {
			getUser: async (id: string) => {
				const mxid = await this.app.puppet.getMxidForUser({
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
				const room: IRemoteRoom = {
					puppetId,
					roomId: id,
				};
				const mxid = await this.app.puppet.getMxidForRoom(room);
				let name = mxid;
				const chan = await this.getDiscordChan(room);
				if (chan && !(chan instanceof Discord.DMChannel)) {
					name = chan.name || "";
				}
				return {
					mxid,
					name,
				};
			},
			getEmoji: async (name: string, animated: boolean, id: string) => {
				return await this.app.matrix.getEmojiMxc(puppetId, name, animated, id);
			},
		};
	}

	public async getDiscordEmoji(puppetId: number, mxc: string): Promise<Discord.GuildEmoji | null> {
		const p = this.app.puppets[puppetId];
		if (!p) {
			return null;
		}
		const emote = await this.app.puppet.emoteSync.getByMxc(puppetId, mxc);
		if (!emote) {
			return null;
		}
		const emoji = p.client.emojis.resolve(emote.emoteId);
		return emoji || null;
	}

	public async iterateGuildStructure(
		puppetId: number,
		guild: Discord.Guild,
		catCallback: (cat: Discord.CategoryChannel) => Promise<void>,
		chanCallback: (chan: BridgeableGuildChannel) => Promise<void>,
	) {
		const bridgedGuilds = await this.app.store.getBridgedGuilds(puppetId);
		const bridgedChannels = await this.app.store.getBridgedChannels(puppetId);
		const client = guild.client;
		const bridgeAll = Boolean(this.app.puppets[puppetId] && this.app.puppets[puppetId].data.bridgeAll);
		// first we iterate over the non-sorted channels
		for (const chan of guild.channels.cache.array()) {
			if (!bridgedGuilds.includes(guild.id) && !bridgedChannels.includes(chan.id) && !bridgeAll) {
				continue;
			}
			if (!chan.parentID && this.isBridgeableGuildChannel(chan) && chan.members.has(client.user!.id)) {
				await chanCallback(chan as BridgeableGuildChannel);
			}
		}
		// next we iterate over the categories and all their children
		for (const cat of guild.channels.cache.array()) {
			if (!(cat instanceof Discord.CategoryChannel)) {
				continue;
			}
			if (cat.members.has(client.user!.id)) {
				let doCat = false;
				for (const chan of cat.children.array()) {
					if (!bridgedGuilds.includes(guild.id) && !bridgedChannels.includes(chan.id) && !bridgeAll) {
						continue;
					}
					if (this.isBridgeableGuildChannel(chan) && chan.members.has(client.user!.id)) {
						if (!doCat) {
							doCat = true;
							await catCallback(cat);
						}
						await chanCallback(chan as BridgeableGuildChannel);
					}
				}
			}
		}
	}

	public async getUserById(client: Discord.Client, id: string): Promise<Discord.User | null> {
		for (const guild of client.guilds.cache.array()) {
			const a = guild.members.cache.find((m) => m.user.id === id);
			if (a) {
				return a.user;
			}
		}
		if (client.user) {
			const user = client.user.relationships.friends.get(id);
			if (user) {
				return user;
			}
		}
		try {
			const user = await client.users.fetch(id);
			if (user) {
				return user;
			}
		} catch (err) {
			// user not found
		}
		return null;
	}

	public isTextGuildChannel(chan?: Discord.Channel | null): boolean {
		return Boolean(chan && ["text", "news"].includes(chan.type));
	}

	public isTextChannel(chan?: Discord.Channel | null): boolean {
		return Boolean(chan && ["text", "news", "dm", "group"].includes(chan.type));
	}

	public isBridgeableGuildChannel(chan?: Discord.Channel | null): boolean {
		return Boolean(chan && ["text", "news"].includes(chan.type));
	}

	public isBridgeableChannel(chan?: Discord.Channel | null): boolean {
		return Boolean(chan && ["text", "news", "dm", "group"].includes(chan.type));
	}
}
