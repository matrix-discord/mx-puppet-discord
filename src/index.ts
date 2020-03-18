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
	IPuppetBridgeRegOpts,
	Log,
	IRetData,
	IProtocolInformation,
} from "mx-puppet-bridge";
import * as commandLineArgs from "command-line-args";
import * as commandLineUsage from "command-line-usage";
import { App } from "./app";

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

const protocol: IProtocolInformation = {
	features: {
		file: true,
		presence: true,
		edit: true,
		reply: true,
		advancedRelay: true,
		globalNamespace: true,
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
};

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
	const app = new App(puppet);
	await app.init();
	puppet.on("puppetNew", app.newPuppet.bind(app));
	puppet.on("puppetDelete", app.deletePuppet.bind(app));
	puppet.on("message", app.matrix.events.handleMatrixMessage.bind(app.matrix.events));
	puppet.on("file", app.matrix.events.handleMatrixFile.bind(app.matrix.events));
	puppet.on("redact", app.matrix.events.handleMatrixRedact.bind(app.matrix.events));
	puppet.on("edit", app.matrix.events.handleMatrixEdit.bind(app.matrix.events));
	puppet.on("reply", app.matrix.events.handleMatrixReply.bind(app.matrix.events));
	puppet.on("reaction", app.matrix.events.handleMatrixReaction.bind(app.matrix.events));
	puppet.on("removeReaction", app.matrix.events.handleMatrixRemoveReaction.bind(app.matrix.events));
	puppet.on("puppetName", app.handlePuppetName.bind(app));
	puppet.on("puppetAvatar", app.handlePuppetAvatar.bind(app));
	puppet.setGetUserIdsInRoomHook(app.getUserIdsInRoom.bind(app));
	puppet.setCreateRoomHook(app.matrix.createRoom.bind(app.matrix));
	puppet.setCreateUserHook(app.matrix.createUser.bind(app.matrix));
	puppet.setCreateGroupHook(app.matrix.createGroup.bind(app.matrix));
	puppet.setGetDmRoomIdHook(app.matrix.getDmRoom.bind(app.matrix));
	puppet.setListUsersHook(app.listUsers.bind(app));
	puppet.setListRoomsHook(app.matrix.listRooms.bind(app.matrix));
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
		fn: app.commands.commandSyncProfile.bind(app.commands),
		help: `Enable/disable the syncing of the matrix profile to the discord one (name and avatar)

Usage: \`syncprofile <puppetId> <1/0>\``,
	});
	puppet.registerCommand("joinentireguild", {
		fn: app.commands.commandJoinEntireGuild.bind(app.commands),
		help: `Join all the channels in a guild, if it is bridged

Usage: \`joinentireguild <puppetId> <guildId>\``,
	});
	puppet.registerCommand("listguilds", {
		fn: app.commands.commandListGuilds.bind(app.commands),
		help: `List all guilds that can be bridged

Usage: \`listguilds <puppetId>\``,
	});
	puppet.registerCommand("acceptinvite", {
		fn: app.commands.commandAcceptInvite.bind(app.commands),
		help: `Accept a discord.gg invite

Usage: \`acceptinvite <puppetId> <inviteLink>\``,
	});
	puppet.registerCommand("bridgeguild", {
		fn: app.commands.commandBridgeGuild.bind(app.commands),
		help: `Bridge a guild

Usage: \`bridgeguild <puppetId> <guildId>\``,
	});
	puppet.registerCommand("unbridgeguild", {
		fn: app.commands.commandUnbridgeGuild.bind(app.commands),
		help: `Unbridge a guild

Usage: \`unbridgeguild <puppetId> <guildId>\``,
	});
	puppet.registerCommand("bridgechannel", {
		fn: app.commands.commandBridgeChannel.bind(app.commands),
		help: `Bridge a channel

Usage: \`bridgechannel <puppetId> <channelId>\``,
	});
	puppet.registerCommand("unbridgechannel", {
		fn: app.commands.commandUnbridgeChannel.bind(app.commands),
		help: `Unbridge a channel

Usage: \`unbridgechannel <puppetId> <channelId>\``,
	});
	puppet.registerCommand("bridgeall", {
		fn: app.commands.commandBridgeAll.bind(app.commands),
		help: `Bridge everything

Usage: \`bridgeall <puppetId> <1/0>\``,
	});
	puppet.registerCommand("enablefriendsmanagement", {
		fn: app.commands.commandEnableFriendsManagement.bind(app.commands),
		help: `Enables friends management on the discord account

Usage: \`enablefriendsmanagement <puppetId>\``,
	});
	puppet.registerCommand("listfriends", {
		fn: app.commands.commandListFriends.bind(app.commands),
		help: `List all your current friends

Usage: \`listfriends <puppetId>\``,
	});
	puppet.registerCommand("addfriend", {
		fn: app.commands.commandAddFriend.bind(app.commands),
		help: `Add a new friend

Usage: \`addfriend <puppetId> <friend>\`, friend can be either the full username or the user ID`,
	});
	puppet.registerCommand("removefriend", {
		fn: app.commands.commandRemoveFriend.bind(app.commands),
		help: `Remove a friend

Usage: \`removefriend <puppetId> <friend>\`, friend can be either the full username or the user ID`,
	});
	await puppet.start();
}

// tslint:disable-next-line:no-floating-promises
run(); // start the thing!
