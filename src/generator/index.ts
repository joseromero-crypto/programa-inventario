// Public surface of the plan generator (pure, no I/O, deterministic).
export { generate, GENERATOR_VERSION } from './generate';
export { tierSource, parseTiers, countedTier, compareTiers } from './tiers';
export { normalize } from './normalize';
export { buildMatcher, normalizeName, normalizeBarcode } from './match';
export { cutSequence, cutInto } from './cut';
export { aisleComparator, unitComparator, aisleJumps } from './order';
export type * from './types';
