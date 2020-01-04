import { IDbSchema, Store } from "mx-puppet-bridge";

export class Schema implements IDbSchema {
	public description = "Channels Bridged";
	public async run(store: Store) {
		await store.createTable(`
			CREATE TABLE discord_bridged_channels (
				id SERIAL PRIMARY KEY,
				puppet_id INTEGER NOT NULL,
				channel_id TEXT NOT NULL
			);`, "discord_bridged_channels");
	}
	public async rollBack(store: Store) {
		await store.db.Exec("DROP TABLE IF EXISTS discord_bridged_channels");
	}
}
