// Dou Di Zhu table: owns per-room game state, routes incoming player actions through the pure
// engine, and emits per-seat projections to the server transport.

import {
	applyClaimLandlord,
	applyDeal,
	applyDeclineLandlord,
	applyPass,
	applyPlayCards,
	awardPoints,
	createInitialGameState,
} from "./doudizhu/engine.js";
import { dealInitialHands, shuffledDeckFor } from "./doudizhu/deck.js";
import { createSessionToken } from "./sessionStore.js";

const MIN_PLAYERS = 2;
const DEFAULT_MAX_SEATS = 4;
const MAX_NOTIFICATIONS = 8;

export class Table {
	constructor({
		tableId,
		maxSeats = DEFAULT_MAX_SEATS,
		onChange = () => {},
	}) {
		this.tableId = tableId;
		this.maxSeats = Math.max(2, Math.min(maxSeats ?? DEFAULT_MAX_SEATS, 4));
		this.onChange = onChange;
		this.gameState = createInitialGameState({ mode: "single", players: [] });
		this.notifications = [];
		this.readySet = new Set(); // seatIndex values who have clicked Ready
		this.seatsByToken = new Map(); // sessionToken -> seatIndex
		this.connectedSeats = new Set(); // seatIndex values with a live socket
	}

	/* ---------------- Seat management ---------------- */

	getPlayerBySeat(seatIndex) {
		return this.gameState.players.find((p) => p.seatIndex === seatIndex) ?? null;
	}

	getPlayerBySession(sessionToken) {
		const seatIndex = this.seatsByToken.get(sessionToken);
		if (seatIndex === undefined) return null;
		return this.getPlayerBySeat(seatIndex);
	}

	firstFreeSeat() {
		const taken = new Set(this.gameState.players.map((p) => p.seatIndex));
		for (let i = 0; i < this.maxSeats; i++) {
			if (!taken.has(i)) return i;
		}
		return -1;
	}

	join({ seatIndex, name, sessionToken }) {
		if (sessionToken) {
			const existing = this.getPlayerBySession(sessionToken);
			if (existing) return { sessionToken, seatIndex: existing.seatIndex };
		}
		const seatHinted = typeof seatIndex === "number" && Number.isInteger(seatIndex) &&
			seatIndex >= 0 && seatIndex < this.maxSeats;
		let resolvedSeat = seatIndex;
		if (!seatHinted) {
			resolvedSeat = this.firstFreeSeat();
			if (resolvedSeat === -1) return { error: "table full" };
		} else if (this.getPlayerBySeat(resolvedSeat)) {
			return { error: "seat taken" };
		}
		if (this.gameState.players.length >= this.maxSeats) return { error: "table full" };
		if (this.gameState.phase !== "waiting" && this.gameState.phase !== "finished") {
			return { error: "hand in progress" };
		}
		const safeName = typeof name === "string" && name.trim()
			? name.trim().slice(0, 20)
			: `Seat ${resolvedSeat + 1}`;
		this.gameState.players.push({
			seatIndex: resolvedSeat,
			name: safeName,
			hand: [],
			role: null,
			hasPassed: false,
			score: 0,
		});
		this.gameState.players.sort((a, b) => a.seatIndex - b.seatIndex);
		const newToken = sessionToken ?? createSessionToken();
		this.seatsByToken.set(newToken, resolvedSeat);
		this.pushNotification(`${safeName} joined seat ${resolvedSeat + 1}.`);
		this.emitChange();
		return { sessionToken: newToken, seatIndex: resolvedSeat };
	}

	leave(sessionToken) {
		const player = this.getPlayerBySession(sessionToken);
		if (!player) return { error: "unknown session" };
		const seatIndex = player.seatIndex;
		if (this.gameState.phase === "playing" || this.gameState.phase === "bidding") {
			this.pushNotification(`${player.name} left mid-hand — the hand is aborted.`);
			this.abortHand();
		}
		this.gameState.players = this.gameState.players.filter((p) => p.seatIndex !== seatIndex);
		this.seatsByToken.delete(sessionToken);
		this.readySet.delete(seatIndex);
		this.connectedSeats.delete(seatIndex);
		this.pushNotification(`${player.name} left the table.`);
		this.emitChange();
		return { ok: true };
	}

	kick({ requesterToken, targetSeatIndex }) {
		const requester = this.getPlayerBySession(requesterToken);
		if (!requester) return { error: "unknown session" };
		if (requester.seatIndex !== 0) return { error: "only seat 0 can kick players" };
		const target = this.getPlayerBySeat(targetSeatIndex);
		if (!target) return { error: "target seat not found" };
		if (targetSeatIndex === 0) return { error: "cannot kick yourself" };
		const targetToken = this.tokenForSeat(targetSeatIndex);
		if (this.gameState.phase === "playing" || this.gameState.phase === "bidding") {
			this.pushNotification(`${target.name} was kicked — hand aborted.`);
			this.abortHand();
		}
		this.gameState.players = this.gameState.players.filter((p) => p.seatIndex !== targetSeatIndex);
		if (targetToken) this.seatsByToken.delete(targetToken);
		this.readySet.delete(targetSeatIndex);
		this.connectedSeats.delete(targetSeatIndex);
		this.pushNotification(`${target.name} was kicked.`);
		this.emitChange();
		return { ok: true, targetToken };
	}

	setConnected(seatIndex, isConnected) {
		if (isConnected) this.connectedSeats.add(seatIndex);
		else this.connectedSeats.delete(seatIndex);
	}

	tokenForSeat(seatIndex) {
		for (const [token, idx] of this.seatsByToken.entries()) {
			if (idx === seatIndex) return token;
		}
		return null;
	}

	ready(sessionToken) {
		const player = this.getPlayerBySession(sessionToken);
		if (!player) return { error: "unknown session" };
		if (this.gameState.phase === "playing" || this.gameState.phase === "bidding") {
			return { ok: true };
		}
		this.readySet.add(player.seatIndex);
		this.pushNotification(`${player.name} is ready.`);
		const readyPlayers = this.gameState.players.filter((p) => this.readySet.has(p.seatIndex));
		if (readyPlayers.length === this.gameState.players.length && readyPlayers.length >= MIN_PLAYERS) {
			this.startHand();
		} else {
			this.emitChange();
		}
		return { ok: true };
	}

	/* ---------------- Hand lifecycle ---------------- */

	startHand() {
		const playerCount = this.gameState.players.length;
		if (playerCount < MIN_PLAYERS) return;
		const mode = playerCount === 4 ? "double" : playerCount === 2 ? "pair" : "single";
		// Preserve running scores across hands.
		const carriedScores = new Map(this.gameState.players.map((p) => [p.seatIndex, p.score]));
		let state = createInitialGameState({
			mode,
			players: this.gameState.players.map((p) => ({
				seatIndex: p.seatIndex,
				name: p.name,
				score: carriedScores.get(p.seatIndex) ?? 0,
			})),
		});
		state.handNumber = this.gameState.handNumber; // keep counter; applyDeal increments

		// Shuffle + deal. Retry dealing up to a few times if everyone declines (handled in
		// decline path). First bidder defaults to seat 0.
		const deck = shuffledDeckFor(playerCount);
		const dealt = dealInitialHands(playerCount, deck);
		state = applyDeal(state, {
			hands: dealt.hands,
			kitty: dealt.kitty,
			firstBidderSeat: 0,
		});
		this.gameState = state;
		this.readySet.clear();
		const modeLabel = mode === "double" ? "4-player" : mode === "pair" ? "2-player" : "3-player";
		const startVerb = mode === "pair" ? "plays" : "bids";
		this.pushNotification(
			`Hand ${state.handNumber} dealt (${modeLabel}). ${state.players[0].name} ${startVerb} first.`,
		);
		this.emitChange();
	}

	abortHand() {
		this.gameState = {
			...this.gameState,
			phase: "waiting",
			turnSeatIndex: null,
			bidTurnSeatIndex: null,
			lastMove: null,
			landlordSeatIndex: null,
			winnerSide: null,
			passesSinceLastMove: 0,
			players: this.gameState.players.map((p) => ({
				...p,
				hand: [],
				role: null,
				hasPassed: false,
			})),
		};
		this.readySet.clear();
	}

	/* ---------------- Actions ---------------- */

	claimLandlord({ sessionToken }) {
		const player = this.getPlayerBySession(sessionToken);
		if (!player) return { error: "unknown session" };
		const res = applyClaimLandlord(this.gameState, player.seatIndex);
		if (res.error) return res;
		this.gameState = res.state;
		this.pushNotification(`${player.name} is the landlord.`);
		this.emitChange();
		return { ok: true };
	}

	declineLandlord({ sessionToken }) {
		const player = this.getPlayerBySession(sessionToken);
		if (!player) return { error: "unknown session" };
		const res = applyDeclineLandlord(this.gameState, player.seatIndex);
		if (res.error) return res;
		if (res.redeal) {
			this.pushNotification("Everyone declined. Redealing.");
			this.gameState = res.state;
			// Full redeal.
			this.startHand();
			return { ok: true };
		}
		this.gameState = res.state;
		this.pushNotification(`${player.name} declined.`);
		this.emitChange();
		return { ok: true };
	}

	playCards({ sessionToken, cards }) {
		const player = this.getPlayerBySession(sessionToken);
		if (!player) return { error: "unknown session" };
		const res = applyPlayCards(this.gameState, player.seatIndex, cards);
		if (res.error) return res;
		this.gameState = res.state;
		const comboName = res.state.lastMove?.combo?.type ?? "move";
		this.pushNotification(`${player.name} played ${comboName} (${cards.length}).`);
		if (res.handFinished) {
			this.gameState = awardPoints(this.gameState);
			let winMsg;
			if (this.gameState.mode === "pair") {
				const winner = this.getPlayerBySeat(res.state.winnerSide);
				winMsg = `${winner?.name ?? "Unknown"} wins the hand.`;
			} else {
				winMsg = `${res.state.winnerSide === "landlord" ? "Landlord" : "Farmers"} win the hand.`;
			}
			this.pushNotification(winMsg);
		}
		this.emitChange();
		return { ok: true };
	}

	pass({ sessionToken }) {
		const player = this.getPlayerBySession(sessionToken);
		if (!player) return { error: "unknown session" };
		const res = applyPass(this.gameState, player.seatIndex);
		if (res.error) return res;
		this.gameState = res.state;
		this.pushNotification(`${player.name} passed.`);
		this.emitChange();
		return { ok: true };
	}

	/* ---------------- Projections for the server transport ---------------- */

	pushNotification(msg) {
		this.notifications.unshift(msg);
		if (this.notifications.length > MAX_NOTIFICATIONS) {
			this.notifications.length = MAX_NOTIFICATIONS;
		}
	}

	buildPublicView() {
		const state = this.gameState;
		return {
			phase: state.phase,
			mode: state.mode,
			turnSeatIndex: state.turnSeatIndex,
			bidTurnSeatIndex: state.bidTurnSeatIndex,
			landlordSeatIndex: state.landlordSeatIndex,
			lastMove: state.lastMove
				? {
					seatIndex: state.lastMove.seatIndex,
					cards: state.lastMove.combo.cards.slice(),
					type: state.lastMove.combo.type,
				}
				: null,
			// Kitty is visible to everyone once the landlord has claimed (matches classic rules).
			kitty: state.landlordSeatIndex !== null || state.phase === "finished"
				? state.kitty.slice()
				: [],
			winnerSide: state.winnerSide,
			handNumber: state.handNumber,
			playersPublic: state.players.map((p) => ({
				seatIndex: p.seatIndex,
				name: p.name,
				handCount: p.hand.length,
				role: p.role,
				hasPassed: p.hasPassed,
				score: p.score,
				ready: this.readySet.has(p.seatIndex),
				connected: this.connectedSeats.has(p.seatIndex),
			})),
			notifications: this.notifications.slice(),
		};
	}

	buildSeatPayload(seatIndex) {
		const pub = this.buildPublicView();
		const player = this.getPlayerBySeat(seatIndex);
		return {
			table: pub,
			seat: player
				? {
					seatIndex: player.seatIndex,
					name: player.name,
					hand: player.hand.slice(),
					role: player.role,
					score: player.score,
					isMyTurn: pub.turnSeatIndex === seatIndex ||
						pub.bidTurnSeatIndex === seatIndex,
				}
				: null,
			updatedAt: new Date().toISOString(),
		};
	}

	buildSpectatorPayload() {
		return { table: this.buildPublicView(), seat: null, updatedAt: new Date().toISOString() };
	}

	emitChange() {
		this.onChange(this);
	}
}
