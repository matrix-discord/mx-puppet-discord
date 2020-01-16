import {
	PuppetBridge,
	IPuppetBridgeFeatures,
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
	puppet.on("puppetName", discord.handlePuppetName.bind(discord));
	puppet.on("puppetAvatar", discord.handlePuppetAvatar.bind(discord));
	puppet.setCreateChanHook(discord.createChan.bind(discord));
	puppet.setCreateUserHook(discord.createUser.bind(discord));
	puppet.setCreateGroupHook(discord.createGroup.bind(discord));
	puppet.setGetDmRoomIdHook(discord.getDmRoom.bind(discord));
	puppet.setListUsersHook(discord.listUsers.bind(discord));
	puppet.setListChansHook(discord.listChans.bind(discord));
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
	puppet.setGetDastaFromStrHook(async (str: string): Promise<IRetData> => {
		const retData = {
			success: false,
		} as IRetData;
		if (!str) {
			retData.error = "Please specify a token to link!";
			return retData;
		}
		retData.success = true;
		retData.data = {
			token: str.trim(),
		};
		return retData;
	});
	puppet.setBotHeaderMsgHook((): string => {
		return "Discord Puppet Bridge";
	});
	puppet.registerCommand("syncprofile", {
		fn: discord.commandSyncProfile.bind(discord),
		help: "Enable/disable the syncing of the profile",
	});
	puppet.registerCommand("joinentireguild", {
		fn: discord.commandJoinEntireGuild.bind(discord),
		help: "Join all the channels in a guild, if it is bridged",
	});
	puppet.registerCommand("listguilds", {
		fn: discord.commandListGuilds.bind(discord),
		help: "List all guilds that are currently bridged",
	});
	puppet.registerCommand("acceptinvite", {
		fn: discord.commandAcceptInvite.bind(discord),
		help: "Accept a discord.gg invite",
	});
	puppet.registerCommand("bridgeguild", {
		fn: discord.commandBridgeGuild.bind(discord),
		help: "Bridge a guild",
	});
	puppet.registerCommand("unbridgeguild", {
		fn: discord.commandUnbridgeGuild.bind(discord),
		help: "Unbridge a guild",
	});
	puppet.registerCommand("bridgechannel", {
		fn: discord.commandBridgeChannel.bind(discord),
		help: "Bridge a channel",
	});
	puppet.registerCommand("unbridgechannel", {
		fn: discord.commandUnbridgeChannel.bind(discord),
		help: "Unbridge a channel",
	});
	puppet.registerCommand("enablefriendsmanagement", {
		fn: discord.commandEnableFriendsManagement.bind(discord),
		help: "Enable friends management",
	});
	puppet.registerCommand("listfriends", {
		fn: discord.commandListFriends.bind(discord),
		help: "List all your current friends",
	});
	puppet.registerCommand("addfriend", {
		fn: discord.commandAddFriend.bind(discord),
		help: "Add a new friend",
	});
	puppet.registerCommand("removefriend", {
		fn: discord.commandRemoveFriend.bind(discord),
		help: "Remove a friend",
	});
	await puppet.start();
}

// tslint:disable-next-line:no-floating-promises
run(); // start the thing!
