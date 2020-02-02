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
	IPuppetBridgeRegOpts,
	Log,
	IRetData,
	IProtocolInformation,
} from "mx-puppet-bridge";
import * as commandLineArgs from "command-line-args";
import * as commandLineUsage from "command-line-usage";
import { DiscordClass } from "./discord";

const log = new Log("DiscordPuppet:index");

const commandOptions = [
	{ name: "register", alias: "r", type: Boolean },
	{ name: "registration-file", alias: "f", type: String },
	{ name: "config", alias: "c", type: String },
	{ name: "help", alias: "h", type: Boolean },
];
const options = Object.assign({
	"register": false,
	"registration-file": "discord-registration.yaml",
	"config": "config.yaml",
	"help": false,
}, commandLineArgs(commandOptions));

if (options.help) {
	// tslint:disable-next-line:no-console
	console.log(commandLineUsage([
		{
			header: "Matrix Discord Puppet Bridge",
			content: "A matrix puppet bridge for discord",
		},
		{
			header: "Options",
			optionList: commandOptions,
		},
	]));
	process.exit(0);
}

const protocol = {
	features: {
		file: true,
		presence: true,
		edit: true,
		reply: true,
	},
	id: "discord",
	displayname: "Discord",
	externalUrl: "https://discordapp.com/",
	namePatterns: {
		user: ":name",
		userOverride: ":displayname",
		room: "[:guild?#:name - :guild,:name]",
		group: ":name",
	},
} as IProtocolInformation;

const puppet = new PuppetBridge(options["registration-file"], options.config, protocol);

if (options.register) {
	// okay, all we have to do is generate a registration file
	puppet.readConfig();
	try {
		puppet.generateRegistration({
			prefix: "_discordpuppet_",
			id: "discord-puppet",
			url: `http://${puppet.Config.bridge.bindAddress}:${puppet.Config.bridge.port}`,
		} as IPuppetBridgeRegOpts);
	} catch (err) {
		// tslint:disable-next-line:no-console
		console.log("Couldn't generate registration file:", err);
	}
	process.exit(0);
}

async function run() {
	await puppet.init();
	const discord = new DiscordClass(puppet);
	await discord.init();
	puppet.on("puppetNew", discord.newPuppet.bind(discord));
	puppet.on("puppetDelete", discord.deletePuppet.bind(discord));
	puppet.on("message", discord.handleMatrixMessage.bind(discord));
	puppet.on("file", discord.handleMatrixFile.bind(discord));
	puppet.on("redact", discord.handleMatrixRedact.bind(discord));
	puppet.on("edit", discord.handleMatrixEdit.bind(discord));
	puppet.on("reply", discord.handleMatrixReply.bind(discord));
	puppet.on("reaction", discord.handleMatrixReaction.bind(discord));
	puppet.on("removeReaction", discord.handleMatrixRemoveReaction.bind(discord));
	puppet.on("puppetName", discord.handlePuppetName.bind(discord));
	puppet.on("puppetAvatar", discord.handlePuppetAvatar.bind(discord));
	puppet.setCreateRoomHook(discord.createRoom.bind(discord));
	puppet.setCreateUserHook(discord.createUser.bind(discord));
	puppet.setCreateGroupHook(discord.createGroup.bind(discord));
	puppet.setGetDmRoomIdHook(discord.getDmRoom.bind(discord));
	puppet.setListUsersHook(discord.listUsers.bind(discord));
	puppet.setListRoomsHook(discord.listRooms.bind(discord));
	puppet.setGetDescHook(async (puppetId: number, data: any): Promise<string> => {
		let s = "Discord";
		if (data.username) {
			s += ` as \`${data.username}\``;
		}
		if (data.id) {
			s += ` (\`${data.id}\`)`;
		}
		return s;
	});
	puppet.setGetDataFromStrHook(async (str: string): Promise<IRetData> => {
		const retData = {
			success: false,
		} as IRetData;
		if (!str) {
			retData.error = "Please specify a token to link!";
			return retData;
		}
		const parts = str.split(" ");
		const PARTS_LENGTH = 2;
		if (parts.length !== PARTS_LENGTH) {
			retData.error = "Please specify if your token is a user or a bot token! `link <user|bot> token`";
			return retData;
		}
		const type = parts[0].toLowerCase();
		if (!["bot", "user"].includes(type)) {
			retData.error = "Please specify if your token is a user or a bot token! `link <user|bot> token`";
			return retData;
		}
		retData.success = true;
		retData.data = {
			token: parts[1].trim(),
			bot: type === "bot",
		};
		return retData;
	});
	puppet.setBotHeaderMsgHook((): string => {
		return "Discord Puppet Bridge";
	});
	puppet.registerCommand("syncprofile", {
		fn: discord.commandSyncProfile.bind(discord),
		help: `Enable/disable the syncing of the matrix profile to the discord one (name and avatar)

Usage: \`syncprofile <puppetId> <1/0>\``,
	});
	puppet.registerCommand("joinentireguild", {
		fn: discord.commandJoinEntireGuild.bind(discord),
		help: `Join all the channels in a guild, if it is bridged

Usage: \`joinentireguild <puppetId> <guildId>\``,
	});
	puppet.registerCommand("listguilds", {
		fn: discord.commandListGuilds.bind(discord),
		help: `List all guilds that can be bridged

Usage: \`listguilds <puppetId>\``,
	});
	puppet.registerCommand("acceptinvite", {
		fn: discord.commandAcceptInvite.bind(discord),
		help: `Accept a discord.gg invite

Usage: \`acceptinvite <puppetId> <inviteLink>\``,
	});
	puppet.registerCommand("bridgeguild", {
		fn: discord.commandBridgeGuild.bind(discord),
		help: `Bridge a guild

Usage: \`bridgeguild <puppetId> <guildId>\``,
	});
	puppet.registerCommand("unbridgeguild", {
		fn: discord.commandUnbridgeGuild.bind(discord),
		help: `Unbridge a guild

Usage: \`unbridgeguild <puppetId> <guildId>\``,
	});
	puppet.registerCommand("bridgechannel", {
		fn: discord.commandBridgeChannel.bind(discord),
		help: `Bridge a channel

Usage: \`bridgechannel <puppetId> <channelId>\``,
	});
	puppet.registerCommand("unbridgechannel", {
		fn: discord.commandUnbridgeChannel.bind(discord),
		help: `Unbridge a channel

Usage: \`unbridgechannel <puppetId> <channelId>\``,
	});
	puppet.registerCommand("enablefriendsmanagement", {
		fn: discord.commandEnableFriendsManagement.bind(discord),
		help: `Enables friends management on the discord account

Usage: \`enablefriendsmanagement <puppetId>\``,
	});
	puppet.registerCommand("listfriends", {
		fn: discord.commandListFriends.bind(discord),
		help: `List all your current friends

Usage: \`listfriends <puppetId>\``,
	});
	puppet.registerCommand("addfriend", {
		fn: discord.commandAddFriend.bind(discord),
		help: `Add a new friend

Usage: \`addfriend <puppetId> <friend>\`, friend can be either the full username or the user ID`,
	});
	puppet.registerCommand("removefriend", {
		fn: discord.commandRemoveFriend.bind(discord),
		help: `Remove a friend

Usage: \`removefriend <puppetId> <friend>\`, friend can be either the full username or the user ID`,
	});
	await puppet.start();
}

// tslint:disable-next-line:no-floating-promises
run(); // start the thing!
