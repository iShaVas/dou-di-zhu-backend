import { randomBytes } from "node:crypto";

export function createSessionToken() {
	return randomBytes(16).toString("hex");
}

export class SessionStore {
	constructor() {
		this.sessions = new Map();
	}

	create({ tableId, seatIndex, name }) {
		const token = createSessionToken();
		this.sessions.set(token, {
			token,
			tableId,
			seatIndex,
			name,
			socketId: null,
			createdAt: Date.now(),
		});
		return token;
	}

	get(token) {
		if (typeof token !== "string") {
			return null;
		}
		return this.sessions.get(token) ?? null;
	}

	attachSocket(token, socketId) {
		const session = this.get(token);
		if (!session) {
			return false;
		}
		session.socketId = socketId;
		return true;
	}

	detachSocket(token) {
		const session = this.get(token);
		if (!session) {
			return;
		}
		session.socketId = null;
	}

	drop(token) {
		this.sessions.delete(token);
	}

	findBySocket(socketId) {
		for (const session of this.sessions.values()) {
			if (session.socketId === socketId) {
				return session;
			}
		}
		return null;
	}
}
