// Dou Di Zhu combination detection and comparison.
//
// detectCombination(cards, { mode }) returns a normalized combination descriptor
// or null if the multiset does not form any legal combination.
//
// canBeat(next, prev) returns true if `next` is legally able to beat `prev`.
//
// Combination descriptor shape:
//   { type: COMBO.*, rank: <number>, size: <number>, cards: <string[]> }
// `rank` is the comparable strength (rank order of the lead rank, or 0 for
// non-comparable combos like super_rocket where only type matters).
// `size` is total card count (used for bomb-vs-bomb size comparison).

import {
	COMBO,
	groupByRank,
	isJoker,
	isSequenceRank,
	RANKS,
	rankOf,
	rankOrder,
	sortByRank,
} from "./types.js";

/** @typedef {{ type: string, rank: number, size: number, cards: string[], extraRank?: number }} Combo */

const RANK_ORDER_MAP = RANKS.reduce((acc, r, i) => {
	acc[r] = i;
	return acc;
}, /** @type {Record<string, number>} */ ({}));

function ro(rank) {
	return RANK_ORDER_MAP[rank];
}

function countJokers(cards) {
	let n = 0;
	for (const c of cards) if (isJoker(c)) n++;
	return n;
}

function hasConsecutiveRanks(ranks) {
	// ranks: list of sequence-eligible rank strings, sorted by rankOrder.
	if (ranks.length === 0) return true;
	for (let i = 1; i < ranks.length; i++) {
		if (ro(ranks[i]) - ro(ranks[i - 1]) !== 1) return false;
	}
	return true;
}

/**
 * @param {string[]} cards
 * @param {{ mode?: "single" | "double" }} [options]
 * @returns {Combo | null}
 */
export function detectCombination(cards, options = {}) {
	const mode = options.mode ?? "single";
	if (!Array.isArray(cards) || cards.length === 0) return null;

	const sorted = sortByRank(cards);
	const size = sorted.length;
	const groups = groupByRank(sorted);
	const ranksPresent = Object.keys(groups);
	const counts = Object.values(groups).sort((a, b) => b - a);
	const jokerCount = countJokers(sorted);

	const smallJokerCount = sorted.filter((c) => rankOf(c) === "sj").length;
	const bigJokerCount = sorted.filter((c) => rankOf(c) === "bj").length;
	// Super-rocket: 4 jokers (both smalls + both bigs, double-deck 4-player only).
	if (mode === "double" && size === 4 && smallJokerCount === 2 && bigJokerCount === 2) {
		return { type: COMBO.SUPER_ROCKET, rank: 0, size: 4, cards: sorted };
	}
	// Rocket: one small joker + one big joker. Only valid in single-deck mode.
	if (mode === "single" && size === 2 && smallJokerCount === 1 && bigJokerCount === 1) {
		return { type: COMBO.ROCKET, rank: 0, size: 2, cards: sorted };
	}

	// Bomb: n-of-a-kind where n >= 4. In single-deck only 4-of-a-kind is possible.
	// Double-deck permits up to 8 of a kind (two decks * 4 suits). Compare bombs by size, then rank.
	if (ranksPresent.length === 1 && size >= 4 && !isJoker(sorted[0])) {
		return { type: COMBO.BOMB, rank: ro(ranksPresent[0]), size, cards: sorted };
	}

	// Single.
	if (size === 1) {
		return { type: COMBO.SINGLE, rank: rankOrder(sorted[0]), size: 1, cards: sorted };
	}

	// Pair: two of same rank, non-joker (jokers don't form natural pairs — that would be a rocket).
	if (size === 2 && ranksPresent.length === 1 && !isJoker(sorted[0])) {
		return { type: COMBO.PAIR, rank: ro(ranksPresent[0]), size: 2, cards: sorted };
	}

	// Triple (naked).
	if (size === 3 && ranksPresent.length === 1 && !isJoker(sorted[0])) {
		return { type: COMBO.TRIPLE, rank: ro(ranksPresent[0]), size: 3, cards: sorted };
	}

	// Triple + single / triple + pair.
	if (size === 4 && counts[0] === 3 && counts[1] === 1) {
		const tripleRank = Object.keys(groups).find((r) => groups[r] === 3);
		return {
			type: COMBO.TRIPLE_WITH_SINGLE,
			rank: ro(tripleRank),
			size: 4,
			cards: sorted,
		};
	}
	if (size === 5 && counts[0] === 3 && counts[1] === 2) {
		const tripleRank = Object.keys(groups).find((r) => groups[r] === 3);
		return {
			type: COMBO.TRIPLE_WITH_PAIR,
			rank: ro(tripleRank),
			size: 5,
			cards: sorted,
		};
	}

	// Straight: >= 5 consecutive unique sequence-eligible ranks, no 2/jokers.
	if (size >= 5 && ranksPresent.length === size) {
		if (ranksPresent.every(isSequenceRank)) {
			const sortedRanks = ranksPresent.slice().sort((a, b) => ro(a) - ro(b));
			if (hasConsecutiveRanks(sortedRanks)) {
				return {
					type: COMBO.STRAIGHT,
					rank: ro(sortedRanks[0]),
					size,
					cards: sorted,
				};
			}
		}
	}

	// Double sequence: >= 3 consecutive pairs, no 2/jokers.
	if (size >= 6 && size % 2 === 0) {
		const pairRanks = [];
		let allPairs = true;
		for (const r of Object.keys(groups)) {
			if (groups[r] !== 2 || !isSequenceRank(r)) {
				allPairs = false;
				break;
			}
			pairRanks.push(r);
		}
		if (allPairs && pairRanks.length === size / 2) {
			const sortedRanks = pairRanks.slice().sort((a, b) => ro(a) - ro(b));
			if (hasConsecutiveRanks(sortedRanks)) {
				return {
					type: COMBO.DOUBLE_SEQUENCE,
					rank: ro(sortedRanks[0]),
					size,
					cards: sorted,
				};
			}
		}
	}

	// Airplane: >= 2 consecutive triples, optionally with the same count of single or pair
	// attachments (one attachment per triple).
	const airplane = detectAirplane(groups, sorted, size);
	if (airplane) return airplane;

	return null;
}

/**
 * @param {Record<string,number>} groups
 * @param {string[]} sorted
 * @param {number} size
 * @returns {Combo | null}
 */
function detectAirplane(groups, sorted, size) {
	// Find all sequence-eligible ranks with count >= 3.
	const tripleRanks = [];
	for (const r of Object.keys(groups)) {
		if (groups[r] >= 3 && isSequenceRank(r)) tripleRanks.push(r);
	}
	if (tripleRanks.length < 2) return null;
	tripleRanks.sort((a, b) => ro(a) - ro(b));

	// Find the longest run of consecutive triples.
	let bestStart = 0;
	let bestLen = 1;
	let curStart = 0;
	let curLen = 1;
	for (let i = 1; i < tripleRanks.length; i++) {
		if (ro(tripleRanks[i]) - ro(tripleRanks[i - 1]) === 1) {
			curLen++;
			if (curLen > bestLen) {
				bestLen = curLen;
				bestStart = curStart;
			}
		} else {
			curStart = i;
			curLen = 1;
		}
	}
	if (bestLen < 2) return null;

	const runTripleRanks = tripleRanks.slice(bestStart, bestStart + bestLen);
	const coreSize = runTripleRanks.length * 3;

	// Pure airplane: size exactly coreSize.
	if (size === coreSize) {
		// Every card must belong to those triples.
		for (const r of Object.keys(groups)) {
			if (!runTripleRanks.includes(r)) return null;
			if (groups[r] !== 3) return null;
		}
		return {
			type: COMBO.AIRPLANE,
			rank: ro(runTripleRanks[0]),
			size,
			cards: sorted,
		};
	}

	// Airplane with single attachments: one extra card per triple.
	if (size === coreSize + runTripleRanks.length) {
		// Outside the run, all remaining cards must be distinct singles (but can include jokers
		// or "2" — they just can't themselves be one of the run triples).
		const attachmentCount = runTripleRanks.length;
		let attachments = 0;
		for (const r of Object.keys(groups)) {
			if (runTripleRanks.includes(r)) {
				if (groups[r] !== 3) return null;
				continue;
			}
			// attachments: each rank contributes up to `groups[r]` singles
			attachments += groups[r];
		}
		if (attachments === attachmentCount) {
			return {
				type: COMBO.AIRPLANE,
				rank: ro(runTripleRanks[0]),
				size,
				cards: sorted,
				extraRank: attachmentCount, // encodes attachment kind/size for display
			};
		}
	}

	// Airplane with pair attachments: one pair per triple.
	if (size === coreSize + runTripleRanks.length * 2) {
		const attachmentCount = runTripleRanks.length;
		const pairAttachments = [];
		let bad = false;
		for (const r of Object.keys(groups)) {
			if (runTripleRanks.includes(r)) {
				if (groups[r] !== 3) {
					bad = true;
					break;
				}
				continue;
			}
			// must be a clean pair (two of the same rank). Jokers as attachment pair is invalid
			// because two jokers = rocket, not a pair.
			if (groups[r] === 2 && !isJoker(r)) {
				pairAttachments.push(r);
			} else {
				bad = true;
				break;
			}
		}
		if (!bad && pairAttachments.length === attachmentCount) {
			return {
				type: COMBO.AIRPLANE,
				rank: ro(runTripleRanks[0]),
				size,
				cards: sorted,
				extraRank: attachmentCount,
			};
		}
	}

	return null;
}

/**
 * Can `next` legally beat `prev`?
 * @param {Combo} next
 * @param {Combo} prev
 * @returns {boolean}
 */
export function canBeat(next, prev) {
	if (!next || !prev) return false;

	// Super-rocket beats anything (including rocket).
	if (next.type === COMBO.SUPER_ROCKET) return true;
	if (prev.type === COMBO.SUPER_ROCKET) return false;

	// Rocket beats anything except super-rocket.
	if (next.type === COMBO.ROCKET) return true;
	if (prev.type === COMBO.ROCKET) return false;

	// Bomb beats any non-bomb.
	if (next.type === COMBO.BOMB && prev.type !== COMBO.BOMB) return true;
	if (prev.type === COMBO.BOMB && next.type !== COMBO.BOMB) return false;

	// Bomb vs bomb: bigger size wins; same size → higher rank wins.
	if (next.type === COMBO.BOMB && prev.type === COMBO.BOMB) {
		if (next.size !== prev.size) return next.size > prev.size;
		return next.rank > prev.rank;
	}

	// Otherwise, only same type + same size can compare.
	if (next.type !== prev.type) return false;
	if (next.size !== prev.size) return false;
	return next.rank > prev.rank;
}
