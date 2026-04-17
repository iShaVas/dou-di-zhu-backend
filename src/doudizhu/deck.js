import { randomInt } from "node:crypto";

function secureShuffle(array) {
	for (let i = array.length - 1; i > 0; i--) {
		const j = randomInt(0, i + 1);
		const tmp = array[i];
		array[i] = array[j];
		array[j] = tmp;
	}
	return array;
}

const SUITS = ["C", "D", "H", "S"];
const FACE_RANKS = ["3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A", "2"];

// Build a 54-card single deck (52 faces + 2 jokers), tagging each physical card with a unique
// "#<n>" instance suffix drawn from the caller-supplied counter. The tag lets callers (client
// selection, server ownership checks) distinguish two copies of the same rank+suit that appear
// in a double deck; rule logic continues to compare by rank alone via rankOf()/isJoker().
function buildSingleDeck(nextId) {
	const deck = [];
	for (const rank of FACE_RANKS) {
		for (const suit of SUITS) {
			deck.push(`${rank}${suit}#${nextId()}`);
		}
	}
	deck.push(`sj#${nextId()}`);
	deck.push(`bj#${nextId()}`);
	return deck;
}

function makeIdCounter() {
	let n = 0;
	return () => n++;
}

// 54-card single deck: 52 faces + 2 jokers. Each card has a unique instance tag.
export function createSingleDeck() {
	return buildSingleDeck(makeIdCounter());
}

// 108-card double deck. Two single decks concatenated, sharing a counter so every card is unique.
export function createDoubleDeck() {
	const nextId = makeIdCounter();
	return [...buildSingleDeck(nextId), ...buildSingleDeck(nextId)];
}

export function shuffledDeckFor(playerCount) {
	if (playerCount === 2 || playerCount === 3) {
		return secureShuffle(createSingleDeck());
	}
	if (playerCount === 4) {
		return secureShuffle(createDoubleDeck());
	}
	throw new Error(`unsupported player count ${playerCount}`);
}

// Deal a shuffled deck into per-player hands plus a kitty for the landlord.
// 2 players: 27 each + 0 kitty.  3 players: 17 each + 3 kitty.  4 players: 25 each + 8 kitty.
export function dealInitialHands(playerCount, deck) {
	const sizeMap = {
		2: { each: 27, kitty: 0 },
		3: { each: 17, kitty: 3 },
		4: { each: 25, kitty: 8 },
	};
	const sizes = sizeMap[playerCount];
	if (!sizes) {
		throw new Error(`unsupported player count ${playerCount}`);
	}
	const expected = sizes.each * playerCount + sizes.kitty;
	if (deck.length !== expected) {
		throw new Error(`deck size ${deck.length} does not match expected ${expected}`);
	}
	const hands = [];
	let cursor = 0;
	for (let p = 0; p < playerCount; p++) {
		hands.push(deck.slice(cursor, cursor + sizes.each));
		cursor += sizes.each;
	}
	const kitty = deck.slice(cursor);
	return { hands, kitty };
}
