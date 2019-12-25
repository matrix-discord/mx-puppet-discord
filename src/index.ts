import {
	PuppetBridge,
	IPuppetBridgeFeatures,
	IPuppetBridgeRegOpts,
	Log,
	IRetData,
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

const features = {
	file: true,
	presence: true,
	edit: true,
	reply: true,
} as IPuppetBridgeFeatures;

const puppet = new PuppetBridge(options["registration-file"], options.config, features);

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
	puppet.setCreateChanHook(discord.createChan.bind(discord));
	puppet.setCreateUserHook(discord.createUser.bind(discord));
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
	puppet.registerCommand("listguilds", {
		fn: discord.commandListGuilds.bind(discord),
		help: "List all guilds that are currently bridged",
	});
	puppet.registerCommand("bridgeguild", {
		fn: discord.commandBridgeGuild.bind(discord),
		help: "Bridge a guild",
	});
	puppet.registerCommand("unbridgeguild", {
		fn: discord.commandUnbridgeGuild.bind(discord),
		help: "Unbridge a guild",
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
