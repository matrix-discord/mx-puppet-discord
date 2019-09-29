import { IDbSchema, Store } from "mx-puppet-bridge";

export class Schema implements IDbSchema {
	public description = "Schema, Emotestore";
	public async run(store: Store) {
		await store.createTable(`
			CREATE TABLE discord_schema (
				version	INTEGER UNIQUE NOT NULL
			);`, "discord_schema");
		await store.db.Exec("INSERT INTO discord_schema VALUES (0);");
		await store.createTable(`
            CREATE TABLE discord_emoji (
                emoji_id TEXT NOT NULL,
                name TEXT NOT NULL,
                animated INTEGER NOT NULL,
                mxc_url TEXT NOT NULL,
                PRIMARY KEY(emoji_id)
        );`, "discord_emoji");
	}
	public async rollBack(store: Store) {
		await store.db.Exec("DROP TABLE IF EXISTS discord_schema");
		await store.db.Exec("DROP TABLE IF EXISTS discord_emoji");
	}
}
