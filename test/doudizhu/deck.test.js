import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createDoubleDeck, createSingleDeck, shuffledDeckFor } from "../../src/doudizhu/deck.js";
import { rankOf } from "../../src/doudizhu/types.js";

describe("deck — instance tagging", () => {
	it("single deck contains 54 cards, all unique strings", () => {
		const deck = createSingleDeck();
		assert.equal(deck.length, 54);
		assert.equal(new Set(deck).size, 54);
	});

	it("double deck contains 108 cards, all unique strings", () => {
		// The pre-fix bug: a double deck had 108 entries but only 54 distinct strings, so the
		// frontend's Set-keyed selection treated two 4D as one card. Keep them distinct.
		const deck = createDoubleDeck();
		assert.equal(deck.length, 108);
		assert.equal(new Set(deck).size, 108);
	});

	it("double deck has every rank+suit exactly twice by base code", () => {
		const deck = createDoubleDeck();
		const byBase = new Map();
		for (const card of deck) {
			const hash = card.indexOf("#");
			const base = hash === -1 ? card : card.slice(0, hash);
			byBase.set(base, (byBase.get(base) ?? 0) + 1);
		}
		for (const [base, count] of byBase.entries()) {
			assert.equal(count, 2, `expected 2 copies of ${base}, got ${count}`);
		}
	});

	it("shuffledDeckFor(4) preserves uniqueness after shuffle", () => {
		const deck = shuffledDeckFor(4);
		assert.equal(deck.length, 108);
		assert.equal(new Set(deck).size, 108);
	});

	it("every tagged card classifies by its base rank", () => {
		for (const card of createDoubleDeck()) {
			const r = rankOf(card);
			assert.ok(
				["3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A", "2", "sj", "bj"].includes(r),
				`rankOf(${card}) = ${r}`,
			);
		}
	});
});
