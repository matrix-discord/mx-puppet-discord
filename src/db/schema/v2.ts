import { IDbSchema, Store } from "mx-puppet-bridge";

export class Schema implements IDbSchema {
	public description = "Guilds Bridged";
	public async run(store: Store) {
		store.createTable(`
			CREATE TABLE discord_bridged_guilds (
				id SERIAL PRIMARY KEY,
				puppet_id INTEGER NOT NULL,
				guild_id TEXT NOT NULL
			);`, "discord_bridged_guilds");
	}
	public async rollBack(store: Store) {
		await store.db.Exec("DROP TABLE IF EXISTS discord_bridged_guilds");
	}
}
