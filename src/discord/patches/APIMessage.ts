import { MessageAttachment, MessageEmbed, MessageFlags, Util } from "better-discord.js"

const APIMessage = require('better-discord.js').APIMessage;

APIMessage.prototype.resolveData = function afterResolveData() {
	console.log("\n\n\Data:", this.data, "\n\n\n");
	if (this.data) return this;

	const content = this.makeContent();
	const tts = Boolean(this.options.tts);

	let nonce;
	if (typeof this.options.nonce !== 'undefined') {
		nonce = parseInt(this.options.nonce);
		if (isNaN(nonce) || nonce < 0) throw new RangeError('MESSAGE_NONCE_TYPE');
	}

	const embedLikes = [];
	if (this.isWebhook) {
		if (this.options.embeds) {
			// @ts-ignore
			embedLikes.push(...this.options.embeds);
		}
	} else if (this.options.embed) {
		// @ts-ignore
		embedLikes.push(this.options.embed);
	}
	const embeds = embedLikes.map(e => new MessageEmbed(e).toJSON());

	let username;
	let avatarURL;
	if (this.isWebhook) {
		username = this.options.username || this.target.name;
		if (this.options.avatarURL) avatarURL = this.options.avatarURL;
	}

	let flags;
	if (this.isMessage) {
		// eslint-disable-next-line eqeqeq
		flags = this.options.flags != null ? new MessageFlags(this.options.flags).bitfield : this.target.flags.bitfield;
	}

	let allowedMentions =
		typeof this.options.allowedMentions === 'undefined'
			? this.target.client.options.allowedMentions
			: this.options.allowedMentions;
	if (this.options.reply) {
		const id = this.target.client.users.resolveID(this.options.reply);
		if (allowedMentions) {
			// Clone the object as not to alter the ClientOptions object
			allowedMentions = Util.cloneObject(allowedMentions);
			const parsed = allowedMentions.parse && allowedMentions.parse.includes('users');
			// Check if the mention won't be parsed, and isn't supplied in `users`
			if (!parsed && !(allowedMentions.users && allowedMentions.users.includes(id))) {
				if (!allowedMentions.users) allowedMentions.users = [];
				allowedMentions.users.push(id);
			}
		} else {
			allowedMentions = { users: [id] };
		}
	}

	this.data = {
		content,
		tts,
		nonce,
		embed: this.options.embed === null ? null : embeds[0],
		embeds,
		username,
		avatar_url: avatarURL,
		allowed_mentions: typeof content === 'undefined' ? undefined : allowedMentions,
		flags,
		message_reference: this.options.message_reference,
	};
	return this;
};

function transformOptions(content, options, extra = {}, isWebhook = false) {
	if (!options && typeof content === 'object' && !Array.isArray(content)) {
		options = content;
		content = undefined;
	}


	if (options && options.messageReference) {
		extra = {
			...extra,
			message_reference: options.messageReference,
		};
		console.log("\n\n\n", extra, "\n\n\n")
		delete options.messageReference;
	}

	if (!options) {
		options = {};
	} else if (options instanceof MessageEmbed) {
		return isWebhook ? { content, embeds: [options], ...extra } : { content, embed: options, ...extra };
	} else if (options instanceof MessageAttachment) {
		return { content, files: [options], ...extra };
	}

	if (Array.isArray(options)) {
		const [embeds, files] = this.partitionMessageAdditions(options);
		return isWebhook ? { content, embeds, files, ...extra } : { content, embed: embeds[0], files, ...extra };
	} else if (Array.isArray(content)) {
		const [embeds, files] = this.partitionMessageAdditions(content);
		if (embeds.length || files.length) {
			return isWebhook ? { embeds, files, ...extra } : { embed: embeds[0], files, ...extra };
		}
	}

	return { content, ...options, ...extra };
}

APIMessage.transformOptions = transformOptions;
