import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

import { WebSocketServer } from "ws";

import {
	CLIENT_MESSAGE_TYPES,
	ERROR_CODES,
	encodeServerMessage,
	parseClientMessage,
	SCHEMA_VERSION,
	SERVER_MESSAGE_TYPES,
} from "./protocol.js";
import { SessionStore } from "./sessionStore.js";
import { TableRegistry } from "./tableRegistry.js";

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

function newSocketId() {
	return randomBytes(8).toString("hex");
}

function send(socket, type, payload) {
	if (socket.readyState !== socket.OPEN) {
		return;
	}
	socket.send(encodeServerMessage(type, payload));
}

function sendError(socket, code, message) {
	send(socket, SERVER_MESSAGE_TYPES.ERROR, { code, message });
}

function broadcastTableState(table, sessions) {
	const now = Date.now();
	const seatPayloads = new Map();
	for (const player of table.gameState.players) {
		seatPayloads.set(player.seatIndex, table.buildSeatPayload(player.seatIndex, now));
	}
	const spectatorPayload = table.buildSpectatorPayload(now);

	for (const session of sessions.sessions.values()) {
		if (session.tableId !== table.tableId || !session.socket) {
			continue;
		}
		const seatPayload =
			session.seatIndex !== null && seatPayloads.has(session.seatIndex)
				? seatPayloads.get(session.seatIndex)
				: spectatorPayload;
		send(session.socket, SERVER_MESSAGE_TYPES.STATE, seatPayload);
	}
}

class WsSessionStore extends SessionStore {
	constructor() {
		super();
	}
	create({ tableId, seatIndex, name, socket }) {
		const token = super.create({ tableId, seatIndex, name });
		const session = this.get(token);
		session.socket = socket;
		return token;
	}
	attachSocket(token, socket) {
		const session = this.get(token);
		if (!session) return false;
		session.socket = socket;
		return true;
	}
	detachSocket(token) {
		const session = this.get(token);
		if (!session) return;
		session.socket = null;
	}
	findBySocket(socket) {
		for (const session of this.sessions.values()) {
			if (session.socket === socket) {
				return session;
			}
		}
		return null;
	}
}

function startServer({ port = PORT, host = HOST } = {}) {
	const sessions = new WsSessionStore();
	const registry = new TableRegistry({
		onChange: (table) => broadcastTableState(table, sessions),
	});

	const httpServer = createServer((req, res) => {
		if (req.url === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, schemaVersion: SCHEMA_VERSION }));
			return;
		}
		res.writeHead(404);
		res.end();
	});

	const wss = new WebSocketServer({ server: httpServer });

	wss.on("connection", (socket) => {
		socket.socketId = newSocketId();

		socket.on("message", (buffer) => {
			const raw = buffer.toString("utf8");
			const parsed = parseClientMessage(raw);
			if (parsed.error) {
				sendError(socket, ERROR_CODES.BAD_REQUEST, parsed.error);
				return;
			}
			handleClientMessage({ socket, msg: parsed.msg, sessions, registry });
		});

		socket.on("close", () => {
			const session = sessions.findBySocket(socket);
			if (session) {
				session.socket = null;
			}
		});
	});

	return new Promise((resolve) => {
		httpServer.listen(port, host, () => {
			const address = httpServer.address();
			console.log(
				`doudizhu-server listening on ws://${address.address}:${address.port} (schema v${SCHEMA_VERSION})`,
			);
			resolve({ httpServer, wss, sessions, registry });
		});
	});
}

function handleClientMessage({ socket, msg, sessions, registry }) {
	switch (msg.type) {
		case CLIENT_MESSAGE_TYPES.PING:
			send(socket, SERVER_MESSAGE_TYPES.PONG, {});
			return;
		case CLIENT_MESSAGE_TYPES.CREATE_TABLE: {
			const opts = msg.options ?? {};
			const table = registry.create({
				maxSeats: opts.maxSeats,
				initialStack: opts.initialStack,
				turnTimeoutMs: opts.turnTimeoutMs,
			});
			send(socket, SERVER_MESSAGE_TYPES.SESSION, {
				tableId: table.tableId,
				seatIndex: null,
				sessionToken: null,
			});
			return;
		}
		case CLIENT_MESSAGE_TYPES.JOIN_TABLE: {
			const table = registry.get(msg.tableId);
			if (!table) {
				sendError(socket, ERROR_CODES.UNKNOWN_TABLE, "no such table");
				return;
			}
			const resumeToken = typeof msg.sessionToken === "string" ? msg.sessionToken : null;
			if (resumeToken) {
				const session = sessions.get(resumeToken);
				if (session && session.tableId === table.tableId) {
					sessions.attachSocket(resumeToken, socket);
					const res = table.join({
						seatIndex: session.seatIndex,
						name: session.name,
						sessionToken: resumeToken,
					});
					if (res.error) {
						sendError(socket, ERROR_CODES.INVALID_SESSION, res.error);
						return;
					}
					send(socket, SERVER_MESSAGE_TYPES.SESSION, {
						tableId: table.tableId,
						seatIndex: session.seatIndex,
						sessionToken: resumeToken,
					});
					broadcastTableState(table, sessions);
					return;
				}
			}
			const res = table.join({ seatIndex: msg.seatIndex, name: msg.name });
			if (res.error) {
				const code = res.error === "seat taken" ? ERROR_CODES.SEAT_TAKEN
					: res.error === "table full" ? ERROR_CODES.TABLE_FULL
					: ERROR_CODES.BAD_REQUEST;
				sendError(socket, code, res.error);
				return;
			}
			// Register the token we generated inside the table with the session store
			const tokenAlreadyKnown = sessions.get(res.sessionToken);
			if (tokenAlreadyKnown) {
				sessions.attachSocket(res.sessionToken, socket);
				tokenAlreadyKnown.tableId = table.tableId;
				tokenAlreadyKnown.seatIndex = res.seatIndex;
				tokenAlreadyKnown.name = msg.name ?? tokenAlreadyKnown.name;
			} else {
				// Seed the session store with this token (table already minted it).
				sessions.sessions.set(res.sessionToken, {
					token: res.sessionToken,
					tableId: table.tableId,
					seatIndex: res.seatIndex,
					name: typeof msg.name === "string" ? msg.name : `Seat ${res.seatIndex + 1}`,
					socket,
					createdAt: Date.now(),
				});
			}
			send(socket, SERVER_MESSAGE_TYPES.SESSION, {
				tableId: table.tableId,
				seatIndex: res.seatIndex,
				sessionToken: res.sessionToken,
			});
			broadcastTableState(table, sessions);
			return;
		}
		case CLIENT_MESSAGE_TYPES.LEAVE_TABLE: {
			const session = sessions.findBySocket(socket);
			if (!session) {
				sendError(socket, ERROR_CODES.INVALID_SESSION, "not at a table");
				return;
			}
			const table = registry.get(session.tableId);
			if (!table) {
				sendError(socket, ERROR_CODES.UNKNOWN_TABLE, "no such table");
				return;
			}
			table.leave(session.token);
			sessions.drop(session.token);
			broadcastTableState(table, sessions);
			return;
		}
		case CLIENT_MESSAGE_TYPES.READY: {
			const session = sessions.findBySocket(socket);
			if (!session) {
				sendError(socket, ERROR_CODES.INVALID_SESSION, "not at a table");
				return;
			}
			const table = registry.get(session.tableId);
			if (!table) {
				sendError(socket, ERROR_CODES.UNKNOWN_TABLE, "no such table");
				return;
			}
			table.ready(session.token);
			broadcastTableState(table, sessions);
			return;
		}
		case CLIENT_MESSAGE_TYPES.CLAIM_LANDLORD:
		case CLIENT_MESSAGE_TYPES.DECLINE_LANDLORD:
		case CLIENT_MESSAGE_TYPES.PLAY_CARDS:
		case CLIENT_MESSAGE_TYPES.PASS: {
			const session = sessions.findBySocket(socket);
			if (!session) {
				sendError(socket, ERROR_CODES.INVALID_SESSION, "not at a table");
				return;
			}
			const table = registry.get(session.tableId);
			if (!table) {
				sendError(socket, ERROR_CODES.UNKNOWN_TABLE, "no such table");
				return;
			}
			let res;
			if (msg.type === CLIENT_MESSAGE_TYPES.CLAIM_LANDLORD) {
				res = table.claimLandlord({
					sessionToken: session.token,
					turnToken: msg.turnToken,
				});
			} else if (msg.type === CLIENT_MESSAGE_TYPES.DECLINE_LANDLORD) {
				res = table.declineLandlord({
					sessionToken: session.token,
					turnToken: msg.turnToken,
				});
			} else if (msg.type === CLIENT_MESSAGE_TYPES.PLAY_CARDS) {
				res = table.playCards({
					sessionToken: session.token,
					turnToken: msg.turnToken,
					cards: Array.isArray(msg.cards) ? msg.cards : [],
				});
			} else {
				res = table.pass({
					sessionToken: session.token,
					turnToken: msg.turnToken,
				});
			}
			if (res.error) {
				const code = mapErrorCode(res.error);
				sendError(socket, code, res.error);
				return;
			}
			broadcastTableState(table, sessions);
			return;
		}
		default:
			sendError(socket, ERROR_CODES.BAD_REQUEST, "unsupported message type");
	}
}

function mapErrorCode(error) {
	switch (error) {
		case "not your turn":
		case "stale turn token":
		case "not your turn to claim":
			return ERROR_CODES.NOT_YOUR_TURN;
		case "invalid combination":
			return ERROR_CODES.INVALID_COMBINATION;
		case "must beat current combination":
			return ERROR_CODES.MUST_BEAT_TABLE;
		case "card not in hand":
		case "no cards":
			return ERROR_CODES.INVALID_ACTION;
		case "cannot pass on a free round":
			return ERROR_CODES.INVALID_ACTION;
		case "hand in progress":
			return ERROR_CODES.HAND_IN_PROGRESS;
		default:
			return ERROR_CODES.BAD_REQUEST;
	}
}

export { startServer };

const isEntryPoint =
	process.argv[1] &&
	import.meta.url.replace(/\\/g, "/").endsWith(process.argv[1].replace(/\\/g, "/"));

if (isEntryPoint) {
	startServer().catch((err) => {
		console.error("Failed to start server:", err);
		process.exit(1);
	});
}

