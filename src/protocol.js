export const SCHEMA_VERSION = 1;

export const CLIENT_MESSAGE_TYPES = Object.freeze({
	CREATE_TABLE: "create_table",
	JOIN_TABLE: "join_table",
	LEAVE_TABLE: "leave_table",
	READY: "ready",
	CLAIM_LANDLORD: "claim_landlord",
	DECLINE_LANDLORD: "decline_landlord",
	PLAY_CARDS: "play_cards",
	PASS: "pass",
	PING: "ping",
});

export const SERVER_MESSAGE_TYPES = Object.freeze({
	SESSION: "session",
	STATE: "state",
	ERROR: "error",
	PONG: "pong",
});

export const ERROR_CODES = Object.freeze({
	BAD_REQUEST: "bad_request",
	UNKNOWN_TABLE: "unknown_table",
	SEAT_TAKEN: "seat_taken",
	SEAT_UNKNOWN: "seat_unknown",
	NOT_YOUR_TURN: "not_your_turn",
	INVALID_ACTION: "invalid_action",
	INVALID_COMBINATION: "invalid_combination",
	MUST_BEAT_TABLE: "must_beat_table",
	INVALID_SESSION: "invalid_session",
	TABLE_FULL: "table_full",
	HAND_IN_PROGRESS: "hand_in_progress",
	INTERNAL: "internal",
});

export function parseClientMessage(raw) {
	if (typeof raw !== "string") return { error: "message must be a JSON string" };
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return { error: "invalid JSON" };
	}
	if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
		return { error: "missing type" };
	}
	const known = new Set(Object.values(CLIENT_MESSAGE_TYPES));
	if (!known.has(msg.type)) return { error: `unknown type ${msg.type}` };
	return { msg };
}

export function encodeServerMessage(type, payload = {}) {
	return JSON.stringify({ type, ...payload });
}
