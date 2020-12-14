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
import { App } from "../app";
import * as Discord from "better-discord.js";
import { IDiscordMessageParserOpts, DiscordMessageParser } from "matrix-discord-parser";
import { Log } from "mx-puppet-bridge";
import { TextGuildChannel, DiscordUtil } from "./DiscordUtil";

const log = new Log("DiscordPuppet:DiscordEventHandler");

export class DiscordEventHandler {
	private discordMsgParser: DiscordMessageParser;

	public constructor(private readonly app: App) {
		this.discordMsgParser = this.app.discordMsgParser;
	}

	public async handleDiscordMessage(puppetId: number, msg: Discord.Message) {
		const p = this.app.puppets[puppetId];
		if (!p) {
			return;
		}
		if (msg.type !== "DEFAULT") {
			return;
		}
		log.info("Received new message!");
		if (!await this.app.bridgeRoom(puppetId, msg.channel)) {
			log.verbose("Unhandled channel, dropping message...");
			return;
		}
		const params = this.app.matrix.getSendParams(puppetId, msg);
		const lockKey = `${puppetId};${msg.channel.id}`;
		const dedupeMsg = msg.attachments.first() ? `file:${msg.attachments.first()!.name}` : msg.content;
		if (await this.app.messageDeduplicator.dedupe(lockKey, msg.author.id, msg.id, dedupeMsg)) {
			// dedupe message
			log.verbose("Deduping message, dropping...");
			return;
		}
		if (msg.webhookID && this.app.discord.isTextGuildChannel(msg.channel)) {
			// maybe we are a webhook from our webhook?
			const chan = msg.channel as TextGuildChannel;
			const hook = await this.app.discord.getOrCreateWebhook(chan);
			if (hook && msg.webhookID === hook.id) {
				log.verbose("Message sent from our webhook, deduping...");
				return;
			}
		}
		// if we are a bot we can safely ignore all our own messages sent
		if (p.client.user!.bot && msg.author.id === p.client.user!.id && !msg.content && msg.embeds.length > 0) {
			log.verbose("Message sent from our own bot, deduplicating...");
			return;
		}
		this.app.lastEventIds[msg.channel.id] = msg.id;
		if (msg.content || msg.embeds.length > 0) {
			const opts: IDiscordMessageParserOpts = {
				callbacks: this.app.discord.getDiscordMsgParserCallbacks(puppetId),
			};
			const reply = await this.discordMsgParser.FormatMessage(opts, msg);
			const replyId = (msg.reference && msg.reference.messageID) || null;
			if (replyId) {
				await this.app.puppet.sendReply(params, replyId, {
					body: reply.body,
					formattedBody: reply.formattedBody,
					emote: reply.msgtype === "m.emote",
					notice: reply.msgtype === "m.notice",
				});
			} else {
				await this.app.puppet.sendMessage(params, {
					body: reply.body,
					formattedBody: reply.formattedBody,
					emote: reply.msgtype === "m.emote",
					notice: reply.msgtype === "m.notice",
				});
			}
		}
		for (const attachment of msg.attachments.array()) {
			params.externalUrl = attachment.url;
			await this.app.puppet.sendFileDetect(params, attachment.url, attachment.name || undefined);
		}
	}

	public async handleDiscordMessageUpdate(puppetId: number, msg1: Discord.Message, msg2: Discord.Message) {
		if (msg1.content === msg2.content) {
			return; // nothing to do
		}
		const p = this.app.puppets[puppetId];
		if (!p) {
			return;
		}
		const params = this.app.matrix.getSendParams(puppetId, msg1);
		const lockKey = `${puppetId};${msg1.channel.id}`;
		if (await this.app.messageDeduplicator.dedupe(lockKey, msg2.author.id, msg2.id, msg2.content)) {
			// dedupe message
			log.verbose("Deduping message, dropping...");
			return;
		}
		if (msg2.webhookID && this.app.discord.isTextGuildChannel(msg2.channel)) {
			// maybe we are a webhook from our webhook?
			const chan = msg2.channel as TextGuildChannel;
			const hook = await this.app.discord.getOrCreateWebhook(chan);
			if (hook && msg2.webhookID === hook.id) {
				log.verbose("Message sent from our webhook, deduping...");
				return;
			}
		}
		// if we are a bot we can safely ignore all our own messages sent
		if (p.client.user!.bot && msg2.author.id === p.client.user!.id && !msg2.content && msg2.embeds.length > 0) {
			log.verbose("Message sent from our own bot, deduplicating...");
			return;
		}
		if (!await this.app.bridgeRoom(puppetId, msg1.channel)) {
			log.verbose("Unhandled channel, dropping message...");
			return;
		}
		const opts: IDiscordMessageParserOpts = {
			callbacks: this.app.discord.getDiscordMsgParserCallbacks(puppetId),
		};
		const reply = await this.discordMsgParser.FormatMessage(opts, msg2);
		if (msg1.content) {
			// okay we have an actual edit
			await this.app.puppet.sendEdit(params, msg1.id, {
				body: reply.body,
				formattedBody: reply.formattedBody,
				emote: reply.msgtype === "m.emote",
				notice: reply.msgtype === "m.notice",
			});
		} else {
			// we actually just want to insert a new message
			await this.app.puppet.sendMessage(params, {
				body: reply.body,
				formattedBody: reply.formattedBody,
				emote: reply.msgtype === "m.emote",
				notice: reply.msgtype === "m.notice",
			});
		}
	}

	public async handleDiscordMessageDelete(puppetId: number, msg: Discord.Message) {
		const p = this.app.puppets[puppetId];
		if (!p) {
			return;
		}
		const params = this.app.matrix.getSendParams(puppetId, msg);
		const lockKey = `${puppetId};${msg.channel.id}`;
		if (p.deletedMessages.has(msg.id) ||
			await this.app.messageDeduplicator.dedupe(lockKey, msg.author.id, msg.id, msg.content)) {
			// dedupe message
			return;
		}
		if (!await this.app.bridgeRoom(puppetId, msg.channel)) {
			log.info("Unhandled channel, dropping message...");
			return;
		}
		await this.app.puppet.sendRedact(params, msg.id);
	}
}
