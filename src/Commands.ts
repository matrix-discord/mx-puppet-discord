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

import { App } from "./app";
import { SendMessageFn, Log } from "mx-puppet-bridge";
import * as Discord from "better-discord.js";
import { BridgeableGuildChannel } from "./discord/DiscordUtil";

const log = new Log("DiscordPuppet:Commands");
const MAX_MSG_SIZE = 4000;

export class Commands {
	constructor(private readonly app: App) {}

	public async commandSyncProfile(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.app.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		// only bots are allowed to profile sync, for security reasons
		const syncProfile = p.client.user!.bot ? param === "1" || param.toLowerCase() === "true" : false;
		p.data.syncProfile = syncProfile;
		await this.app.puppet.setPuppetData(puppetId, p.data);
		if (syncProfile) {
			await sendMessage("Syncing discord profile with matrix profile now");
			await this.app.updateUserInfo(puppetId);
		} else {
			await sendMessage("Stopped syncing discord profile with matrix profile");
		}
	}

	public async commandJoinEntireGuild(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.app.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		const guild = p.client.guilds.cache.get(param);
		if (!guild) {
			await sendMessage("Guild not found!");
			return;
		}
		if (!(await this.app.store.isGuildBridged(puppetId, guild.id))) {
			await sendMessage("Guild not bridged!");
			return;
		}
		for (const chan of guild.channels.cache.array()) {
			if (!this.app.discord.isBridgeableGuildChannel(chan)) {
				continue;
			}
			const gchan = chan as BridgeableGuildChannel;
			if (gchan.members.has(p.client.user!.id)) {
				const remoteChan = this.app.matrix.getRemoteRoom(puppetId, gchan);
				await this.app.puppet.bridgeRoom(remoteChan);
			}
		}
		await sendMessage(`Invited to all channels in guild ${guild.name}!`);
	}

	public async commandListGuilds(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.app.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		const guilds = await this.app.store.getBridgedGuilds(puppetId);
		let sendStr = "Guilds:\n";
		for (const guild of p.client.guilds.cache.array()) {
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
		const p = this.app.puppets[puppetId];
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
		const p = this.app.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		const guild = p.client.guilds.cache.get(param);
		if (!guild) {
			await sendMessage("Guild not found!");
			return;
		}
		await this.app.store.setBridgedGuild(puppetId, guild.id);
		let msg = `Guild ${guild.name} (\`${guild.id}\`) is now being bridged!

Either type \`joinentireguild ${puppetId} ${guild.id}\` to get invited to all the channels of that guild `;
		msg += `or type \`listrooms\` and join that way.

Additionally you will be invited to guild channels as messages are sent in them.`;
		await sendMessage(msg);
	}

	public async commandUnbridgeGuild(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.app.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		const bridged = await this.app.store.isGuildBridged(puppetId, param);
		if (!bridged) {
			await sendMessage("Guild wasn't bridged!");
			return;
		}
		await this.app.store.removeBridgedGuild(puppetId, param);
		await sendMessage("Unbridged guild!");
	}

	public async commandBridgeChannel(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.app.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		let channel: BridgeableGuildChannel | undefined;
		let guild: Discord.Guild | undefined;
		for (const g of p.client.guilds.cache.array()) {
			channel = g.channels.resolve(param) as BridgeableGuildChannel;
			if (this.app.discord.isBridgeableGuildChannel(channel)) {
				guild = g;
				break;
			}
			channel = undefined;
		}
		if (!channel || !guild) {
			await sendMessage("Channel not found!");
			return;
		}
		await this.app.store.setBridgedChannel(puppetId, channel.id);
		await sendMessage(`Channel ${channel.name} (\`${channel.id}\`) of guild ${guild.name} is now been bridged!`);
	}

	public async commandUnbridgeChannel(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.app.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		const bridged = await this.app.store.isChannelBridged(puppetId, param);
		if (!bridged) {
			await sendMessage("Channel wasn't bridged!");
			return;
		}
		await this.app.store.removeBridgedChannel(puppetId, param);
		await sendMessage("Unbridged channel!");
	}

	public async commandBridgeAll(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.app.puppets[puppetId];
		if (!p) {
			await sendMessage("Puppet not found!");
			return;
		}
		if (param == null || param == undefined) {
			await sendMessage("Command is missing parameters. Usage: bridgeall <puppetId> <1/0>");
		}
		const bridgeAll = param === "1" || param.toLowerCase() === "true";
		p.data.bridgeAll = bridgeAll;
		await this.app.puppet.setPuppetData(puppetId, p.data);
		if (bridgeAll) {
			await sendMessage("Bridging everything now");
		} else {
			await sendMessage("Not bridging everything anymore");
		}
	}

	public async commandEnableFriendsManagement(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.app.puppets[puppetId];
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
			await this.app.puppet.setPuppetData(puppetId, p.data);
			await sendMessage("Friends management enabled!");
			return;
		}
		await sendMessage(`Using user accounts is against discords TOS. As this is required for friends management, you ` +
			`will be breaking discords TOS if you enable this feature. Development of it has already softlocked accounts. ` +
			`USE AT YOUR OWN RISK!\n\nIf you want to enable friends management type \`enablefriendsmanagement ${puppetId} ` +
			`YES I KNOW THE RISKS\``);
	}

	public async commandListFriends(puppetId: number, param: string, sendMessage: SendMessageFn) {
		const p = this.app.puppets[puppetId];
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
			for (const user of p.client.user!.relationships.friends.array()) {
				const mxid = await this.app.puppet.getMxidForUser({
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
			for (const user of incoming.array()) {
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
			for (const user of outgoing.array()) {
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
		const p = this.app.puppets[puppetId];
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
		const p = this.app.puppets[puppetId];
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
}
