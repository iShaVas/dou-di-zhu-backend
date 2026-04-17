// Pure state machine for Dou Di Zhu. No I/O, no DOM, no timers.
//
// GameState shape (owned by Table.js; see table.js for the live instance):
// {
//   phase: "waiting" | "bidding" | "playing" | "finished",
//   mode: "single" | "double" | "pair",
//   players: Array<{
//     seatIndex: number,
//     name: string,
//     hand: string[],           // card codes
//     role: "landlord" | "farmer" | null,
//     hasPassed: boolean,       // last move was a pass (reset each round)
//     score: number,            // cumulative across hands in the match
//   }>,
//   kitty: string[],            // revealed to all once landlord is chosen
//   turnSeatIndex: number | null,
//   bidTurnSeatIndex: number | null, // during bidding phase
//   passesSinceLastMove: number,
//   lastMove: null | {
//     seatIndex: number,
//     combo: Combo,             // descriptor from combinations.js
//   },
//   landlordSeatIndex: number | null,
//   winnerSide: null | "landlord" | "farmers",
//   handNumber: number,         // 1-based within the match
// }

import { canBeat, detectCombination } from "./combinations.js";
import { COMBO } from "./types.js";

export function createInitialGameState({ mode, players }) {
	return {
		phase: "waiting",
		mode,
		players: players.map((p) => ({
			...p,
			hand: [],
			role: null,
			hasPassed: false,
			score: p.score ?? 0,
		})),
		kitty: [],
		turnSeatIndex: null,
		bidTurnSeatIndex: null,
		passesSinceLastMove: 0,
		lastMove: null,
		landlordSeatIndex: null,
		winnerSide: null,
		handNumber: 0,
	};
}

/**
 * Assign dealt hands + kitty to an existing state. Pure wrt the input.
 * In "pair" mode there is no bidding phase: play starts immediately from firstBidderSeat.
 */
export function applyDeal(state, { hands, kitty, firstBidderSeat }) {
	const players = state.players.map((p, i) => ({
		...p,
		hand: hands[i].slice(),
		role: null,
		hasPassed: false,
	}));
	const base = {
		...state,
		players,
		kitty: [],
		passesSinceLastMove: 0,
		lastMove: null,
		landlordSeatIndex: null,
		winnerSide: null,
		handNumber: state.handNumber + 1,
	};
	if (state.mode === "pair") {
		return { ...base, phase: "playing", turnSeatIndex: firstBidderSeat, bidTurnSeatIndex: null };
	}
	return { ...base, phase: "bidding", kitty: kitty.slice(), turnSeatIndex: null, bidTurnSeatIndex: firstBidderSeat };
}

/**
 * Player with seatIndex claims the landlord role during the bidding phase.
 * First claim wins; kitty is handed to them and play begins.
 */
export function applyClaimLandlord(state, seatIndex) {
	if (state.phase !== "bidding") {
		return { error: "not in bidding phase" };
	}
	if (state.bidTurnSeatIndex !== seatIndex) {
		return { error: "not your turn to claim" };
	}
	const players = state.players.map((p) => ({
		...p,
		role: p.seatIndex === seatIndex ? "landlord" : "farmer",
		hand: p.seatIndex === seatIndex ? [...p.hand, ...state.kitty] : p.hand,
	}));
	return {
		ok: true,
		state: {
			...state,
			phase: "playing",
			players,
			turnSeatIndex: seatIndex,
			bidTurnSeatIndex: null,
			landlordSeatIndex: seatIndex,
			passesSinceLastMove: 0,
			lastMove: null,
		},
	};
}

/**
 * Player with seatIndex passes on claiming the landlord role.
 * If all players pass on the first round, we signal a redeal.
 */
export function applyDeclineLandlord(state, seatIndex) {
	if (state.phase !== "bidding") {
		return { error: "not in bidding phase" };
	}
	if (state.bidTurnSeatIndex !== seatIndex) {
		return { error: "not your turn to claim" };
	}
	const playerCount = state.players.length;
	const nextBidder = (seatIndex + 1) % playerCount;
	// If we've cycled back to the first bidder with nobody claiming, request a redeal.
	// The dealer (bidTurnSeatIndex at hand start) is tracked implicitly via nextBidder returning
	// to first-bidder. We detect "all passed" using a counter on the state.
	const declines = (state.bidDeclines ?? 0) + 1;
	if (declines >= playerCount) {
		return {
			ok: true,
			redeal: true,
			state: { ...state, bidDeclines: 0 },
		};
	}
	return {
		ok: true,
		state: {
			...state,
			bidTurnSeatIndex: nextBidder,
			bidDeclines: declines,
		},
	};
}

/**
 * Player plays a legal combination during the playing phase.
 * `cards` is an array of card codes; we validate the multiset, that the player
 * owns every card, and that the combination beats the current table (if any).
 */
export function applyPlayCards(state, seatIndex, cards) {
	if (state.phase !== "playing") return { error: "not in playing phase" };
	if (state.turnSeatIndex !== seatIndex) return { error: "not your turn" };
	if (!Array.isArray(cards) || cards.length === 0) return { error: "no cards" };

	const player = state.players.find((p) => p.seatIndex === seatIndex);
	if (!player) return { error: "unknown seat" };

	// Verify the player owns every card (as a multiset).
	const handCopy = player.hand.slice();
	for (const card of cards) {
		const idx = handCopy.indexOf(card);
		if (idx === -1) return { error: "card not in hand" };
		handCopy.splice(idx, 1);
	}

	const combo = detectCombination(cards, { mode: state.mode });
	if (!combo) return { error: "invalid combination" };

	// Free round (nobody holds the table): any valid combination is fine.
	if (state.lastMove) {
		if (!canBeat(combo, state.lastMove.combo)) {
			return { error: "must beat current combination" };
		}
	}

	const players = state.players.map((p) =>
		p.seatIndex === seatIndex
			? { ...p, hand: handCopy, hasPassed: false }
			: { ...p, hasPassed: false }
	);
	const playerCount = players.length;
	const nextTurn = (seatIndex + 1) % playerCount;
	const handFinished = handCopy.length === 0;

	let phase = state.phase;
	let winnerSide = state.winnerSide;
	if (handFinished) {
		phase = "finished";
		// In "pair" mode there are no roles; store the winning seatIndex directly.
		winnerSide = state.mode === "pair" ? seatIndex : (player.role === "landlord" ? "landlord" : "farmers");
	}

	return {
		ok: true,
		state: {
			...state,
			phase,
			players,
			turnSeatIndex: handFinished ? null : nextTurn,
			passesSinceLastMove: 0,
			lastMove: { seatIndex, combo },
			winnerSide,
		},
		handFinished,
	};
}

/**
 * Player passes during the playing phase.
 * If all other active players pass since the last move, clear the table and
 * let the last mover start fresh.
 */
export function applyPass(state, seatIndex) {
	if (state.phase !== "playing") return { error: "not in playing phase" };
	if (state.turnSeatIndex !== seatIndex) return { error: "not your turn" };
	if (!state.lastMove) return { error: "cannot pass on a free round" };

	const playerCount = state.players.length;
	const passes = state.passesSinceLastMove + 1;
	// All other players (playerCount - 1) have passed → table clears, last mover acts again.
	if (passes >= playerCount - 1) {
		return {
			ok: true,
			state: {
				...state,
				turnSeatIndex: state.lastMove.seatIndex,
				passesSinceLastMove: 0,
				lastMove: null,
				players: state.players.map((p) => ({ ...p, hasPassed: false })),
			},
		};
	}
	const nextTurn = (seatIndex + 1) % playerCount;
	return {
		ok: true,
		state: {
			...state,
			turnSeatIndex: nextTurn,
			passesSinceLastMove: passes,
			players: state.players.map((p) =>
				p.seatIndex === seatIndex ? { ...p, hasPassed: true } : p
			),
		},
	};
}

/**
 * Award points after a finished hand.
 * 2P: winner +1, loser −1.  3P: landlord ±2, farmers ∓1.  4P: landlord ±3, farmers ∓1.
 */
export function awardPoints(state) {
	if (state.phase !== "finished" || state.winnerSide == null) return state;
	if (state.mode === "pair") {
		// winnerSide is the winning seatIndex (number).
		const players = state.players.map((p) => ({
			...p,
			score: p.score + (p.seatIndex === state.winnerSide ? 1 : -1),
		}));
		return { ...state, players };
	}
	const is4p = state.players.length === 4;
	const landlordDelta = is4p ? 3 : 2;
	const farmerDelta = 1;
	const players = state.players.map((p) => {
		if (p.role === "landlord") {
			return {
				...p,
				score: p.score + (state.winnerSide === "landlord" ? landlordDelta : -landlordDelta),
			};
		}
		return {
			...p,
			score: p.score + (state.winnerSide === "farmers" ? farmerDelta : -farmerDelta),
		};
	});
	return { ...state, players };
}

export { COMBO };
