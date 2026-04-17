// Domain types for Dou Di Zhu. Cards are strings (card codes); suits are decorative — rank alone
// drives rules. Jokers are special codes: "sj" = small joker, "bj" = big joker.
//
// Card code format:
//   base = rank+suit (e.g. "3H", "TS") or "sj" / "bj".
//   rank ∈ {"3","4","5","6","7","8","9","T","J","Q","K","A","2"}
//   suit ∈ {"C","D","H","S"}
//   Dealt cards carry an optional instance suffix "#<n>" to disambiguate the two physical copies
//   that exist in a double deck (e.g. "4D#17", "sj#54"). Parsers below strip the suffix; rules
//   compare by rank alone, so tagged and untagged codes are interchangeable.

export const RANKS = Object.freeze([
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"T",
	"J",
	"Q",
	"K",
	"A",
	"2",
	"sj",
	"bj",
]);

// Rank-ordering value. Higher number = stronger card.
const RANK_ORDER_MAP = Object.freeze(
	RANKS.reduce((acc, rank, idx) => {
		acc[rank] = idx;
		return acc;
	}, /** @type {Record<string, number>} */ ({})),
);

// Strip the optional "#N" instance suffix; returns the rank+suit / joker base.
export function baseCode(card) {
	const hash = card.indexOf("#");
	return hash === -1 ? card : card.slice(0, hash);
}

export function rankOf(card) {
	const base = baseCode(card);
	if (base === "sj" || base === "bj") return base;
	return base[0];
}

export function rankOrder(card) {
	return RANK_ORDER_MAP[rankOf(card)];
}

export function isJoker(card) {
	const base = baseCode(card);
	return base === "sj" || base === "bj";
}

// Ranks that are excluded from straights/double-sequences/airplanes.
// "2" and both jokers can never appear in ordered sequences.
export function isSequenceRank(rank) {
	return rank !== "2" && rank !== "sj" && rank !== "bj";
}

// Maximum sequence rank order (exclusive upper bound): A is the last rank allowed in a straight.
export const MAX_SEQUENCE_RANK_ORDER = RANK_ORDER_MAP["A"];

// Combination type enum.
export const COMBO = Object.freeze({
	SINGLE: "single",
	PAIR: "pair",
	TRIPLE: "triple",
	TRIPLE_WITH_SINGLE: "triple_with_single",
	TRIPLE_WITH_PAIR: "triple_with_pair",
	STRAIGHT: "straight",
	DOUBLE_SEQUENCE: "double_sequence",
	AIRPLANE: "airplane", // consecutive triples; optional attachments
	BOMB: "bomb", // n-of-a-kind where n >= 4 (in double-deck, 5, 6, 7, 8 also allowed and compare by size then rank)
	ROCKET: "rocket", // two jokers (single-deck only)
	SUPER_ROCKET: "super_rocket", // four jokers (double-deck 4-player mode)
});

// Group cards by rank. Returns { rank -> count }.
export function groupByRank(cards) {
	const map = Object.create(null);
	for (const card of cards) {
		const r = rankOf(card);
		map[r] = (map[r] || 0) + 1;
	}
	return map;
}

// Sort by ascending rank order.
export function sortByRank(cards) {
	return cards.slice().sort((a, b) => rankOrder(a) - rankOrder(b));
}
