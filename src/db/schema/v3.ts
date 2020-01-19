/*
Copyright 2020 mx-puppet-discord
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
