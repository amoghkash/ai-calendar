import type { DirectoryContact } from './messaging.js';

/**
 * Resolving a person's name out of an event title.
 *
 * The governing rule is **extract liberally, resolve strictly**. A candidate
 * that matches nobody costs nothing - it simply produces no suggestion - while
 * a name we failed to extract costs the whole feature. So extraction guesses
 * freely and the matcher is where the discipline lives.
 *
 * Nothing here links anything. It produces suggestions for a human to confirm,
 * because picking the wrong Sarah is the same class of mistake as moving the
 * wrong meeting.
 */

export interface NameCandidate {
  /** As it appeared in the title, for display. */
  readonly text: string;
  /** Lowercased and depunctuated, for matching. */
  readonly normalized: string;
}

export type MatchReason = 'exact_full_name' | 'exact_first_name' | 'exact_other_name' | 'prefix';

export interface ContactMatch {
  readonly contact: DirectoryContact;
  readonly score: number;
  readonly reason: MatchReason;
}

export type NameResolution =
  | { readonly kind: 'none'; readonly candidate: NameCandidate }
  | { readonly kind: 'unique'; readonly candidate: NameCandidate; readonly match: ContactMatch }
  | {
      readonly kind: 'ambiguous';
      readonly candidate: NameCandidate;
      readonly matches: readonly ContactMatch[];
    };

const SCORES: Record<MatchReason, number> = {
  exact_full_name: 1,
  exact_first_name: 0.8,
  exact_other_name: 0.75,
  prefix: 0.55,
};

/**
 * Words that are never a person.
 *
 * Activity nouns, connectors and filler. Being over-inclusive here is safe:
 * dropping a word that happens to be someone's name only loses that one
 * suggestion, whereas keeping "lunch" means matching a contact called Lunch.
 */
const STOPWORDS = new Set([
  'lunch', 'dinner', 'breakfast', 'brunch', 'coffee', 'drinks', 'drink', 'tea', 'beer',
  'call', 'meeting', 'meet', 'sync', 'standup', 'chat', 'catchup', 'catch', 'hangout',
  'hang', 'session', 'appointment', 'appt', 'interview', 'review', 'intro', 'walk', 'run',
  'with', 'w', 'and', 'at', 'the', 'a', 'an', 'for', 're', 'about', 'my', 'our', 'up',
  'out', 'on', 'in', 'to', 'of', 'time', 'quick', 'weekly', 'monthly', 'biweekly',
]);

/** Splits a title into groups, each of which may name one person. */
const SEPARATORS = /[,+&/]|\band\b/i;

/**
 * Pull the possible people out of an event title.
 *
 * "Lunch with Sarah" -> Sarah. "coffee w/ sarah + mike" -> Sarah, Mike.
 * "Lunch @ Sarah's" -> Sarah. "Lunch at Blue Bottle" -> Blue Bottle, which
 * simply matches no contact and disappears.
 */
export function extractCandidateNames(title: string): readonly NameCandidate[] {
  const candidates: NameCandidate[] = [];
  const seen = new Set<string>();

  for (const group of title.split(SEPARATORS)) {
    const words: string[] = [];
    for (const raw of group.split(/\s+/)) {
      const word = clean(raw);
      if (word === undefined) continue;
      if (STOPWORDS.has(word.toLowerCase())) {
        // A stopword ends the current name: "Lunch with Sarah re budget"
        // should offer "Sarah", not "Sarah budget".
        if (words.length > 0) {
          push(candidates, seen, words.join(' '));
          words.length = 0;
        }
        continue;
      }
      words.push(word);
    }
    if (words.length > 0) push(candidates, seen, words.join(' '));
  }
  return candidates;
}

function push(into: NameCandidate[], seen: Set<string>, text: string): void {
  const normalized = normalize(text);
  if (normalized.length < 2 || seen.has(normalized)) return;
  seen.add(normalized);
  into.push({ text, normalized });
}

/** Strip decoration from one word, or drop it entirely. */
function clean(raw: string): string | undefined {
  let word = raw.trim();
  // "w/" survives the split as its own token.
  if (word === 'w/' || word === '@') return undefined;
  word = word.replace(/^[@#(]+/, '').replace(/[).:!?]+$/, '');
  // Possessives: "Sarah's place" names Sarah.
  word = word.replace(/['’]s$/i, '');
  if (word.length === 0) return undefined;
  // Times, durations, counts: "1:1", "30m", "2026".
  if (/\d/.test(word)) return undefined;
  // An address is a handle, not a name; attendee matching covers those.
  if (word.includes('@')) return undefined;
  return word;
}

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Rank contacts against one candidate name.
 *
 * A contact with no way to reach them cannot be linked, so it is not a match
 * however well the name fits.
 */
export function resolveName(
  candidate: NameCandidate,
  contacts: readonly DirectoryContact[],
): NameResolution {
  const matches: ContactMatch[] = [];
  for (const contact of contacts) {
    if (contact.handles.length === 0) continue;
    const reason = classify(candidate.normalized, normalize(contact.displayName));
    if (reason === undefined) continue;
    matches.push({ contact, score: SCORES[reason], reason });
  }
  if (matches.length === 0) return { kind: 'none', candidate };

  matches.sort((a, b) => b.score - a.score || a.contact.displayName.localeCompare(b.contact.displayName));
  const best = matches[0]!;
  const tied = matches.filter((match) => match.score === best.score);

  // One clear winner is proposable; a tie is a question, and answering it by
  // picking the alphabetically first Sarah would be worse than asking.
  if (tied.length === 1) return { kind: 'unique', candidate, match: best };
  return { kind: 'ambiguous', candidate, matches: tied };
}

function classify(candidate: string, displayName: string): MatchReason | undefined {
  if (displayName.length === 0) return undefined;
  if (displayName === candidate) return 'exact_full_name';

  const parts = displayName.split(' ').filter((part) => part.length > 0);
  const first = parts[0];
  if (first === candidate) return 'exact_first_name';
  if (parts.some((part) => part === candidate)) return 'exact_other_name';
  // Short fragments match far too much to be worth proposing.
  if (candidate.length >= 3 && parts.some((part) => part.startsWith(candidate))) return 'prefix';
  return undefined;
}

/** Every name in a title, resolved. Callers usually drop the `none` results. */
export function resolveNamesInTitle(
  title: string,
  contacts: readonly DirectoryContact[],
): readonly NameResolution[] {
  return extractCandidateNames(title).map((candidate) => resolveName(candidate, contacts));
}
