import { randomBytes } from "node:crypto";

import { Table } from "./table.js";

function createTableId() {
	return randomBytes(4).toString("hex");
}

export class TableRegistry {
	constructor({ onChange = () => {} } = {}) {
		this.tables = new Map();
		this.onChange = onChange;
	}

	create({ maxSeats, initialStack, turnTimeoutMs } = {}) {
		let tableId;
		do {
			tableId = createTableId();
		} while (this.tables.has(tableId));
		const table = new Table({
			tableId,
			maxSeats,
			initialStack,
			turnTimeoutMs,
			onChange: (t) => this.onChange(t),
		});
		this.tables.set(tableId, table);
		return table;
	}

	get(tableId) {
		if (typeof tableId !== "string") {
			return null;
		}
		return this.tables.get(tableId) ?? null;
	}

	delete(tableId) {
		const table = this.tables.get(tableId);
		if (table) {
			table.clearTurnTimer();
		}
		this.tables.delete(tableId);
	}
}
