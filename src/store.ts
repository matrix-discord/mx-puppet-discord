import { Store } from "mx-puppet-bridge";

const CURRENT_SCHEMA = 1;

export class IDbEmoji {
	emojiId: string;
	name: string;
	animated: boolean;
	mxcUrl: string;
}

export class DiscordStore {
	constructor(
		private store: Store,
	) { }

	public async init(): Promise<void> {
		await this.store.init(CURRENT_SCHEMA, "discord_schema", (version: number) => {
			return require(`./db/schema/v${version}.js`).Schema;
		});
	}

	public async getEmoji(id: string): Promise <IDbEmoji | null> {
		const row = await this.store.db.Get("SELECT * FROM discord_emoji WHERE emoji_id = $id", {
			id,
		});
		if (!row) {
			return null;
		}
		return {
			emojiId: row.emoji_id as string,
			name: row.name as string,
			animated: Boolean(row.animated), // they are stored as numbers
			mxcUrl: row.mxc_url as string,
		} as IDbEmoji;
	}

	public async setEmoji(emoji: IDbEmoji): Promise<void> {
		const exists = await this.store.db.Get("SELECT 1 from discord_emoji WHERE emoji_id = $id", {
			id: emoji.emojiId,
		});
		let query = "";
		if (exists) {
			// update an existing record
			query = `UPDATE discord_emoji SET name = $name, animated = $animated, mxc_url = $mxcUrl WHERE emoji_id = $emojiId`;
		} else {
			// insert a new record
			query = `INSERT INTO discord_emoji (emoji_id, name, animated, mxc_url) VALUES ($emojiId, $name, $animated, $mxcUrl)`;
		}
		await this.store.db.Run(query, {
			emojiId: emoji.emojiId,
			name: emoji.name,
			animated: Number(emoji.animated), // bools are stored as numbers as sqlite is silly
			mxcUrl: emoji.mxcUrl,
		});
	}
}
