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

const MIN_PLAYERS = 3;
const DEFAULT_MAX_SEATS = 4;
const DEFAULT_TURN_TIMEOUT_MS = 60_000;
const MAX_NOTIFICATIONS = 8;

export class Table {
	constructor({
		tableId,
		maxSeats = DEFAULT_MAX_SEATS,
		turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
		onChange = () => {},
	}) {
		this.tableId = tableId;
		this.maxSeats = Math.max(MIN_PLAYERS, Math.min(maxSeats, 4));
		this.turnTimeoutMs = turnTimeoutMs;
		this.onChange = onChange;
		this.gameState = createInitialGameState({ mode: "single", players: [] });
		this.notifications = [];
		this.currentTurnToken = null;
		this.turnTimer = null;
		this.readySet = new Set(); // seatIndex values who have clicked Ready
		this.seatsByToken = new Map(); // sessionToken -> seatIndex
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
		this.pushNotification(`${player.name} left the table.`);
		this.emitChange();
		return { ok: true };
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
		const mode = playerCount === 4 ? "double" : "single";
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
		this.clearTurnTimer();
		this.startBidTimer(state.bidTurnSeatIndex);
		this.pushNotification(
			`Hand ${state.handNumber} dealt (${mode === "double" ? "4-player" : "3-player"}). ${state.players[0].name} bids first.`,
		);
		this.emitChange();
	}

	abortHand() {
		this.clearTurnTimer();
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

	claimLandlord({ sessionToken, turnToken }) {
		const player = this.getPlayerBySession(sessionToken);
		if (!player) return { error: "unknown session" };
		if (turnToken && turnToken !== this.currentTurnToken) return { error: "stale turn token" };
		const res = applyClaimLandlord(this.gameState, player.seatIndex);
		if (res.error) return res;
		this.gameState = res.state;
		this.clearTurnTimer();
		this.startPlayTimer(this.gameState.turnSeatIndex);
		this.pushNotification(`${player.name} is the landlord.`);
		this.emitChange();
		return { ok: true };
	}

	declineLandlord({ sessionToken, turnToken }) {
		const player = this.getPlayerBySession(sessionToken);
		if (!player) return { error: "unknown session" };
		if (turnToken && turnToken !== this.currentTurnToken) return { error: "stale turn token" };
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
		this.clearTurnTimer();
		this.startBidTimer(this.gameState.bidTurnSeatIndex);
		this.pushNotification(`${player.name} declined.`);
		this.emitChange();
		return { ok: true };
	}

	playCards({ sessionToken, turnToken, cards }) {
		const player = this.getPlayerBySession(sessionToken);
		if (!player) return { error: "unknown session" };
		if (turnToken && turnToken !== this.currentTurnToken) return { error: "stale turn token" };
		const res = applyPlayCards(this.gameState, player.seatIndex, cards);
		if (res.error) return res;
		this.gameState = res.state;
		this.clearTurnTimer();
		const comboName = res.state.lastMove?.combo?.type ?? "move";
		this.pushNotification(`${player.name} played ${comboName} (${cards.length}).`);
		if (res.handFinished) {
			this.gameState = awardPoints(this.gameState);
			this.pushNotification(
				`${res.state.winnerSide === "landlord" ? "Landlord" : "Farmers"} win the hand.`,
			);
		} else {
			this.startPlayTimer(this.gameState.turnSeatIndex);
		}
		this.emitChange();
		return { ok: true };
	}

	pass({ sessionToken, turnToken }) {
		const player = this.getPlayerBySession(sessionToken);
		if (!player) return { error: "unknown session" };
		if (turnToken && turnToken !== this.currentTurnToken) return { error: "stale turn token" };
		const res = applyPass(this.gameState, player.seatIndex);
		if (res.error) return res;
		this.gameState = res.state;
		this.clearTurnTimer();
		this.pushNotification(`${player.name} passed.`);
		this.startPlayTimer(this.gameState.turnSeatIndex);
		this.emitChange();
		return { ok: true };
	}

	/* ---------------- Turn timers ---------------- */

	mintTurnToken() {
		this.currentTurnToken = createSessionToken();
		return this.currentTurnToken;
	}

	startBidTimer(seatIndex) {
		this.mintTurnToken();
		const token = this.currentTurnToken;
		this.turnTimer = setTimeout(() => {
			if (
				this.currentTurnToken === token &&
				this.gameState.phase === "bidding" &&
				this.gameState.bidTurnSeatIndex === seatIndex
			) {
				this.declineLandlord({ sessionToken: this.tokenForSeat(seatIndex) });
			}
		}, this.turnTimeoutMs);
		if (typeof this.turnTimer?.unref === "function") this.turnTimer.unref();
	}

	startPlayTimer(seatIndex) {
		if (seatIndex === null || seatIndex === undefined) return;
		this.mintTurnToken();
		const token = this.currentTurnToken;
		this.turnTimer = setTimeout(() => {
			if (
				this.currentTurnToken === token &&
				this.gameState.phase === "playing" &&
				this.gameState.turnSeatIndex === seatIndex
			) {
				// Auto-pass if possible; otherwise auto-play the lowest single card.
				if (this.gameState.lastMove) {
					this.pass({ sessionToken: this.tokenForSeat(seatIndex) });
				} else {
					const player = this.getPlayerBySeat(seatIndex);
					if (player && player.hand.length > 0) {
						this.playCards({
							sessionToken: this.tokenForSeat(seatIndex),
							cards: [player.hand[0]],
						});
					}
				}
			}
		}, this.turnTimeoutMs);
		if (typeof this.turnTimer?.unref === "function") this.turnTimer.unref();
	}

	clearTurnTimer() {
		if (this.turnTimer) {
			clearTimeout(this.turnTimer);
			this.turnTimer = null;
		}
	}

	tokenForSeat(seatIndex) {
		for (const [token, idx] of this.seatsByToken.entries()) {
			if (idx === seatIndex) return token;
		}
		return null;
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
					turnToken: this.currentTurnToken,
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
