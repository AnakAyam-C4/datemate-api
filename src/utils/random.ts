/**
 * Deterministic PRNG (mulberry32) seeded from a string.
 *
 * Why deterministic: both clients may race to generate the deck. Only one write
 * wins the transaction, but seeding from the session id means both would have
 * produced the *same* deck anyway — so a lost race is never a visible
 * inconsistency, and a deck can be reproduced when debugging a session.
 */
export const seededRandom = (seed: string): (() => number) => {
  let hash = 1779033703 ^ seed.length;

  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }

  let state = hash >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Fisher-Yates using a supplied RNG. Does not mutate the input. */
export const shuffle = <T>(items: T[], random: () => number): T[] => {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    [result[index], result[swapWith]] = [result[swapWith], result[index]];
  }

  return result;
};
