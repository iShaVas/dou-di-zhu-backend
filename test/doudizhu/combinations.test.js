import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canBeat, detectCombination } from "../../src/doudizhu/combinations.js";
import { COMBO } from "../../src/doudizhu/types.js";

function detect(cards, mode = "single") {
	return detectCombination(cards, { mode });
}

describe("detectCombination — atoms", () => {
	it("detects a single", () => {
		const c = detect(["3H"]);
		assert.equal(c.type, COMBO.SINGLE);
	});
	it("detects a pair of non-joker cards", () => {
		const c = detect(["3H", "3D"]);
		assert.equal(c.type, COMBO.PAIR);
	});
	it("rejects two jokers as a pair (is a rocket)", () => {
		const c = detect(["sj", "bj"]);
		assert.equal(c.type, COMBO.ROCKET);
	});
	it("rejects two of the same joker code", () => {
		// Two small jokers is impossible in single-deck but let's be robust; the double-joker
		// rocket requires one of each.
		const c = detect(["sj", "sj"]);
		assert.equal(c, null);
	});
	it("detects a triple", () => {
		const c = detect(["5H", "5D", "5S"]);
		assert.equal(c.type, COMBO.TRIPLE);
	});
	it("detects triple+single", () => {
		const c = detect(["5H", "5D", "5S", "3C"]);
		assert.equal(c.type, COMBO.TRIPLE_WITH_SINGLE);
	});
	it("detects triple+pair", () => {
		const c = detect(["5H", "5D", "5S", "3C", "3H"]);
		assert.equal(c.type, COMBO.TRIPLE_WITH_PAIR);
	});
});

describe("detectCombination — straights and sequences", () => {
	it("detects a 5-card straight", () => {
		const c = detect(["3C", "4H", "5D", "6S", "7C"]);
		assert.equal(c.type, COMBO.STRAIGHT);
		assert.equal(c.size, 5);
	});
	it("rejects a straight containing a 2", () => {
		const c = detect(["T", "J", "Q", "K", "A", "2"].map((r, i) => `${r}${"CDHS"[i % 4]}`));
		assert.equal(c, null);
	});
	it("rejects a straight of only 4 cards", () => {
		const c = detect(["3C", "4H", "5D", "6S"]);
		assert.equal(c, null);
	});
	it("detects a double sequence of 3 pairs", () => {
		const c = detect(["3C", "3D", "4H", "4S", "5C", "5D"]);
		assert.equal(c.type, COMBO.DOUBLE_SEQUENCE);
	});
	it("rejects a double sequence containing a 2", () => {
		const c = detect(["A", "A", "2", "2", "K", "K"].map((r, i) => `${r}${"CDHS"[i % 4]}`));
		assert.equal(c, null);
	});
});

describe("detectCombination — airplane", () => {
	it("detects a pure airplane (two triples)", () => {
		const c = detect(["5H", "5D", "5S", "6H", "6D", "6S"]);
		assert.equal(c.type, COMBO.AIRPLANE);
	});
	it("detects an airplane with single attachments", () => {
		const c = detect(["5H", "5D", "5S", "6H", "6D", "6S", "3C", "4C"]);
		assert.equal(c.type, COMBO.AIRPLANE);
	});
	it("detects an airplane with pair attachments", () => {
		const c = detect(["5H", "5D", "5S", "6H", "6D", "6S", "3C", "3H", "4C", "4D"]);
		assert.equal(c.type, COMBO.AIRPLANE);
	});
	it("rejects a non-consecutive two-triple", () => {
		const c = detect(["5H", "5D", "5S", "7H", "7D", "7S"]);
		assert.equal(c, null);
	});
});

describe("detectCombination — bombs and rockets", () => {
	it("detects a 4-of-a-kind bomb", () => {
		const c = detect(["5H", "5D", "5S", "5C"]);
		assert.equal(c.type, COMBO.BOMB);
		assert.equal(c.size, 4);
	});
	it("detects a 5-of-a-kind bomb in double-deck mode", () => {
		const c = detect(["5H", "5D", "5S", "5C", "5H"], "double");
		assert.equal(c.type, COMBO.BOMB);
		assert.equal(c.size, 5);
	});
	it("detects a rocket from two distinct jokers in single-deck", () => {
		const c = detect(["sj", "bj"], "single");
		assert.equal(c.type, COMBO.ROCKET);
	});
	it("detects a super-rocket (4 jokers) in double-deck", () => {
		const c = detect(["sj", "sj", "bj", "bj"], "double");
		assert.equal(c.type, COMBO.SUPER_ROCKET);
	});
});

describe("detectCombination — instance-tagged cards (double deck)", () => {
	// In a double deck the same rank+suit can occur twice; dealt cards carry a "#N" instance tag
	// so the two physical copies are distinct strings. Rule logic must classify by rank alone.
	it("treats same-rank tagged cards as a pair", () => {
		const c = detect(["4D#17", "4D#88"], "double");
		assert.equal(c?.type, COMBO.PAIR);
	});
	it("detects a bomb built from tagged duplicates across both decks", () => {
		const c = detect(["5H#1", "5D#2", "5S#3", "5C#4", "5H#55", "5D#56"], "double");
		assert.equal(c?.type, COMBO.BOMB);
		assert.equal(c?.size, 6);
	});
	it("detects a super-rocket from tagged jokers", () => {
		const c = detect(["sj#54", "sj#108", "bj#55", "bj#107"], "double");
		assert.equal(c?.type, COMBO.SUPER_ROCKET);
	});
});

describe("canBeat — ordering", () => {
	it("higher single beats lower single", () => {
		assert.equal(canBeat(detect(["5H"]), detect(["3H"])), true);
		assert.equal(canBeat(detect(["3H"]), detect(["5H"])), false);
	});
	it("2 is stronger than A in singles", () => {
		assert.equal(canBeat(detect(["2H"]), detect(["AH"])), true);
	});
	it("bomb beats any non-bomb", () => {
		assert.equal(
			canBeat(detect(["5H", "5D", "5S", "5C"]), detect(["2H"])),
			true,
		);
	});
	it("larger bomb beats smaller bomb (double-deck)", () => {
		assert.equal(
			canBeat(
				detect(["3H", "3D", "3S", "3C", "3H"], "double"),
				detect(["AH", "AD", "AS", "AC"], "double"),
			),
			true,
		);
	});
	it("same-size bomb: higher rank wins", () => {
		assert.equal(
			canBeat(
				detect(["AH", "AD", "AS", "AC"]),
				detect(["3H", "3D", "3S", "3C"]),
			),
			true,
		);
	});
	it("rocket beats every non-rocket", () => {
		assert.equal(
			canBeat(
				detect(["sj", "bj"]),
				detect(["3H", "3D", "3S", "3C"]),
			),
			true,
		);
	});
	it("super-rocket beats rocket", () => {
		assert.equal(
			canBeat(
				detect(["sj", "sj", "bj", "bj"], "double"),
				detect(["sj", "bj"]),
			),
			true,
		);
	});
	it("cross-type (non-bomb/rocket) never compares", () => {
		assert.equal(
			canBeat(detect(["5H", "5D"]), detect(["3H"])),
			false,
			"pair vs single is not a legal comparison",
		);
	});
	it("requires matching size in same-type comparisons", () => {
		// 5-card straight cannot beat a 6-card straight
		assert.equal(
			canBeat(
				detect(["3C", "4H", "5D", "6S", "7C"]),
				detect(["3C", "4H", "5D", "6S", "7C", "8D"]),
			),
			false,
		);
	});
});
