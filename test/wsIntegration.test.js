import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import WebSocket from "ws";

import { startServer } from "../src/server.js";

let serverHandle;
let port;

function openClient(url) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		const buffered = [];
		const waiters = [];
		socket.on("message", (buf) => {
			let msg;
			try {
				msg = JSON.parse(buf.toString("utf8"));
			} catch {
				return;
			}
			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i].predicate(msg)) {
					clearTimeout(waiters[i].timer);
					waiters[i].resolve(msg);
					waiters.splice(i, 1);
					return;
				}
			}
			buffered.push(msg);
		});
		socket.once("open", () => {
			resolve({
				send: (msg) => socket.send(JSON.stringify(msg)),
				wait: (predicate, timeoutMs = 3000) =>
					new Promise((res, rej) => {
						for (let i = 0; i < buffered.length; i++) {
							if (predicate(buffered[i])) {
								const msg = buffered[i];
								buffered.splice(i, 1);
								res(msg);
								return;
							}
						}
						const timer = setTimeout(() => {
							const idx = waiters.findIndex((w) => w.resolve === res);
							if (idx !== -1) waiters.splice(idx, 1);
							rej(new Error("timeout waiting for ws message"));
						}, timeoutMs);
						waiters.push({ predicate, resolve: res, timer });
					}),
				close: () => socket.close(),
			});
		});
		socket.once("error", reject);
	});
}

describe("WebSocket integration — 3-player hand", () => {
	before(async () => {
		serverHandle = await startServer({ port: 0, host: "127.0.0.1" });
		port = serverHandle.httpServer.address().port;
	});

	after(() => {
		for (const table of serverHandle.registry.tables.values()) {
			table.clearTurnTimer();
		}
		serverHandle.wss.close();
		serverHandle.httpServer.close();
	});

	it("creates a table, three seats join, bidding + a move flow through the socket", async () => {
		const url = `ws://127.0.0.1:${port}`;

		const creator = await openClient(url);
		creator.send({ type: "create_table" });
		const created = await creator.wait((m) => m.type === "session" && m.tableId);
		const tableId = created.tableId;
		creator.close();

		const clients = [];
		for (let i = 0; i < 3; i++) {
			const c = await openClient(url);
			c.send({ type: "join_table", tableId, seatIndex: i, name: `P${i}` });
			const s = await c.wait((m) => m.type === "session" && m.seatIndex === i);
			clients.push({ ...c, seatIndex: i, sessionToken: s.sessionToken });
		}

		// Every seat clicks Ready.
		for (const c of clients) c.send({ type: "ready" });

		// Wait for the bidding state to land at each client.
		const biddingStates = await Promise.all(
			clients.map((c) => c.wait((m) => m.type === "state" && m.table.phase === "bidding")),
		);
		for (const state of biddingStates) {
			assert.ok(state.seat);
			assert.ok(state.seat.hand.length === 17);
			// No leak of other seats' hands.
			const otherCards = new Set();
			for (const p of state.table.playersPublic) {
				if (p.seatIndex === state.seat.seatIndex) continue;
				// publicPlayers should have NO hand, just handCount.
				assert.equal(p.hand, undefined);
				assert.ok(typeof p.handCount === "number");
			}
		}

		// The bidder claims landlord.
		const table = serverHandle.registry.get(tableId);
		const firstBidder = table.gameState.bidTurnSeatIndex;
		const bidder = clients.find((c) => c.seatIndex === firstBidder);
		bidder.send({
			type: "claim_landlord",
			turnToken: table.currentTurnToken,
		});

		// Await the play phase on the bidder's socket.
		const playState = await bidder.wait(
			(m) => m.type === "state" && m.table.phase === "playing",
		);
		assert.equal(playState.table.landlordSeatIndex, firstBidder);
		assert.equal(playState.seat.hand.length, 20, "landlord receives 3-card kitty");

		// Landlord plays their lowest card as a single.
		const firstCard = playState.seat.hand[0];
		bidder.send({
			type: "play_cards",
			turnToken: table.currentTurnToken,
			cards: [firstCard],
		});
		const afterPlay = await bidder.wait(
			(m) => m.type === "state" && m.table.lastMove !== null,
		);
		assert.equal(afterPlay.table.lastMove.seatIndex, firstBidder);
		assert.deepEqual(afterPlay.table.lastMove.cards, [firstCard]);

		for (const c of clients) c.close();
	});
});
