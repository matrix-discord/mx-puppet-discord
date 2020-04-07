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

import { Log, IDbSchema, Store } from "mx-puppet-bridge";

export class Schema implements IDbSchema {
	public description = "migrate dm room IDs";
	public async run(store: Store) {
		try {
			let rows: any[];
			try {
				rows = await store.db.All("SELECT * FROM chan_store WHERE room_id LIKE 'dm%'");
			} catch (e) {
				rows = await store.db.All("SELECT * FROM room_store WHERE room_id LIKE 'dm%'");
			}
			for (const row of rows) {
				const parts = (row.room_id as string).split("-");
				row.room_id = `dm-${row.puppet_id}-${parts[1]}`;
				try {
					await store.db.Run(`UPDATE chan_store SET
						room_id = $room_id,
						puppet_id = $puppet_id,
						name = $name,
						avatar_url = $avatar_url,
						avatar_mxc = $avatar_mxc,
						avatar_hash = $avatar_hash,
						topic = $topic,
						group_id = $group_id
						WHERE mxid = $mxid`, row);
				} catch (e) {
					await store.db.Run(`UPDATE room_store SET
						room_id = $room_id,
						puppet_id = $puppet_id,
						name = $name,
						avatar_url = $avatar_url,
						avatar_mxc = $avatar_mxc,
						avatar_hash = $avatar_hash,
						topic = $topic,
						group_id = $group_id
						WHERE mxid = $mxid`, row);
				}
			}
		} catch (err) {
			const log = new Log("DiscordPuppet::DbUpgrade");
			log.error("Failed to migrate room ID data:", err);
		}
	}
	public async rollBack(store: Store) { } // no rollback
}
