import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Table } from "../src/table.js";

function newTable({ seats = 3 } = {}) {
	const table = new Table({
		tableId: "t1",
		maxSeats: 4,
		turnTimeoutMs: 60_000,
	});
	const tokens = [];
	for (let i = 0; i < seats; i++) {
		const res = table.join({ seatIndex: i, name: `P${i}` });
		assert.ok(!res.error, `join ${i}: ${res.error}`);
		tokens.push(res.sessionToken);
	}
	return { table, tokens };
}

describe("Table — Dou Di Zhu lifecycle", () => {
	it("accepts up to 4 players, rejects a 5th", () => {
		const { table } = newTable({ seats: 4 });
		const fifth = table.join({ name: "E" });
		assert.equal(fifth.error, "table full");
	});

	it("requires every seat ready before starting a hand", () => {
		const { table, tokens } = newTable({ seats: 3 });
		table.ready(tokens[0]);
		table.ready(tokens[1]);
		assert.equal(table.gameState.phase, "waiting");
		table.ready(tokens[2]);
		assert.equal(table.gameState.phase, "bidding");
	});

	it("3-player hand uses single deck; 4-player uses double deck", () => {
		const three = newTable({ seats: 3 });
		three.tokens.forEach((t) => three.table.ready(t));
		assert.equal(three.table.gameState.mode, "single");
		const handSizes = three.table.gameState.players.map((p) => p.hand.length);
		assert.deepEqual(handSizes, [17, 17, 17]);

		const four = newTable({ seats: 4 });
		four.tokens.forEach((t) => four.table.ready(t));
		assert.equal(four.table.gameState.mode, "double");
		assert.deepEqual(four.table.gameState.players.map((p) => p.hand.length), [25, 25, 25, 25]);
	});

	it("landlord claim transfers kitty to claimer's hand", () => {
		const { table, tokens } = newTable({ seats: 3 });
		tokens.forEach((t) => table.ready(t));
		const firstBidder = table.gameState.bidTurnSeatIndex;
		const bidderToken = tokens[firstBidder];
		const preHand = table.getPlayerBySeat(firstBidder).hand.length;
		const res = table.claimLandlord({
			sessionToken: bidderToken,
			turnToken: table.currentTurnToken,
		});
		assert.ok(!res.error);
		const postHand = table.getPlayerBySeat(firstBidder).hand.length;
		assert.equal(postHand, preHand + 3);
		assert.equal(table.gameState.phase, "playing");
		assert.equal(table.gameState.landlordSeatIndex, firstBidder);
	});

	it("rejects a play of cards the player does not hold", () => {
		const { table, tokens } = newTable({ seats: 3 });
		tokens.forEach((t) => table.ready(t));
		table.claimLandlord({
			sessionToken: tokens[table.gameState.bidTurnSeatIndex],
			turnToken: table.currentTurnToken,
		});
		const seat = table.gameState.turnSeatIndex;
		const res = table.playCards({
			sessionToken: tokens[seat],
			turnToken: table.currentTurnToken,
			cards: ["nope"],
		});
		assert.ok(res.error);
	});

	it("pass cycles turn and clearing the table after all passes", () => {
		const { table, tokens } = newTable({ seats: 3 });
		tokens.forEach((t) => table.ready(t));
		const landlordSeat = table.gameState.bidTurnSeatIndex;
		table.claimLandlord({
			sessionToken: tokens[landlordSeat],
			turnToken: table.currentTurnToken,
		});
		const landlord = table.getPlayerBySeat(landlordSeat);
		// Landlord plays their lowest card as a single.
		const firstCard = landlord.hand[0];
		const r1 = table.playCards({
			sessionToken: tokens[landlordSeat],
			turnToken: table.currentTurnToken,
			cards: [firstCard],
		});
		assert.ok(!r1.error, `play: ${r1.error}`);
		assert.equal(table.gameState.lastMove.combo.type, "single");
		// Each other seat passes in turn.
		let passer = (landlordSeat + 1) % 3;
		let r = table.pass({ sessionToken: tokens[passer], turnToken: table.currentTurnToken });
		assert.ok(!r.error, `pass1: ${r.error}`);
		passer = (landlordSeat + 2) % 3;
		r = table.pass({ sessionToken: tokens[passer], turnToken: table.currentTurnToken });
		assert.ok(!r.error, `pass2: ${r.error}`);
		// Table cleared; landlord is back on a free round.
		assert.equal(table.gameState.lastMove, null);
		assert.equal(table.gameState.turnSeatIndex, landlordSeat);
	});

	it("empty hand finishes the hand and awards scores", () => {
		const { table, tokens } = newTable({ seats: 3 });
		tokens.forEach((t) => table.ready(t));
		const landlordSeat = table.gameState.bidTurnSeatIndex;
		table.claimLandlord({
			sessionToken: tokens[landlordSeat],
			turnToken: table.currentTurnToken,
		});
		const landlord = table.getPlayerBySeat(landlordSeat);
		const lastCard = landlord.hand[0];
		// Artificially shrink the hand to 1 card so one play ends it.
		landlord.hand = [lastCard];
		const r = table.playCards({
			sessionToken: tokens[landlordSeat],
			turnToken: table.currentTurnToken,
			cards: [lastCard],
		});
		assert.ok(!r.error, `play: ${r.error}`);
		assert.equal(table.gameState.phase, "finished");
		assert.equal(table.gameState.winnerSide, "landlord");
		assert.equal(table.getPlayerBySeat(landlordSeat).score, 2);
	});

	it("seat projection never leaks another seat's hand", () => {
		const { table, tokens } = newTable({ seats: 3 });
		tokens.forEach((t) => table.ready(t));
		const view = table.buildSeatPayload(0);
		assert.ok(view.seat);
		assert.equal(view.seat.seatIndex, 0);
		assert.equal(view.seat.hand.length, 17);
		const serialized = JSON.stringify(view);
		// Build another seat's hand from gameState and assert no string match.
		const otherHand = table.getPlayerBySeat(1).hand;
		// We only check that at least one card from seat 1's hand that isn't also in seat 0 is absent.
		const seat0Set = new Set(table.getPlayerBySeat(0).hand);
		for (const card of otherHand) {
			if (!seat0Set.has(card)) {
				// Use `"card"` with quotes so we don't false-positive on substring matches.
				assert.equal(
					serialized.includes(`"${card}"`),
					false,
					`seat 1's card ${card} leaked into seat 0's payload`,
				);
			}
		}
	});
});
