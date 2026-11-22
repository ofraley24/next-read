'use strict';
// Prompts for the two engine steps. Kept separate so they are easy to iterate on.

function bookLine(b) {
  const review = b.review ? `\n   MY REVIEW: ${String(b.review).slice(0, 700)}` : '';
  return `${b.rating ? b.rating + '★ ' : ''}${b.title}${b.series ? ' [' + b.series + ']' : ''} — ${b.author}` +
    `${b.year ? ' (' + b.year + ')' : ''}${b.pages ? ', ' + b.pages + 'pp' : ''}${review}`;
}

function libraryText(lib) {
  const g = s => lib.filter(b => b.shelf === s);
  const block = (title, rows) => `${title}:\n${rows.map(bookLine).join('\n') || '(none)'}`;
  return [
    block('READ & RATED (out of 5; 0 = unrated)', [...g('read')].sort((a, b) => b.rating - a.rating)),
    block('DID NOT FINISH', g('did-not-finish')),
    block('CURRENTLY READING', g('currently-reading')),
    block('TO-READ (already on the reader\'s list)', g('to-read')),
  ].join('\n\n');
}

function profilePrompt(lib) {
  return `You are the taste analyst for a book recommender. Below is one reader's Goodreads library. Write a concise taste profile (150-220 words, plain prose, second person "you") covering:
1. What they value, framed as what books ARGUE or explore, not genre labels (e.g. whether an author believes in human ingenuity vs. pessimism about the limits of knowledge; ideas, explanation, epistemology, society-building).
2. Style and narrative voice they respond to, and what they dislike (infer from low ratings, DNFs, reviews).
3. One or two interesting tensions or gaps in their taste.
Use their own reviews as strong evidence. Do not invent books they have not listed. Output only the profile text.

${libraryText(lib)}`;
}

function recommendPrompt({ library, profile, steer = [], pinned = [], dismissed = [] }) {
  return `You are the engine behind a personal bookshop. Recommend books for this reader, using their library and taste profile.

RULES
- Recommend only REAL, well-known published books you are confident exist, with the correct author. If unsure a book exists, leave it out. Never invent titles. (Every title is checked against a real catalogue and dropped if not found.)
- Do NOT recommend anything already in their library (read, DNF, currently reading) EXCEPT on the "From your to-read pile" shelf, which must pick from their TO-READ list only, using the exact title and author as listed.
- Link on underlying ideas, themes and narrative voice, not genre, popularity, or "readers also liked". Every "why" must name specific books FROM THEIR LIBRARY it connects to, and say what is shared and, where relevant, how this author's take DIFFERS (e.g. optimistic vs pessimistic about human ingenuity).
- Be honest: include a "caution" (one short line) about where it may not land for this reader.
- Respect the steering below. Avoid previously dismissed books. Pinned books show what they liked from past picks; do not repeat them.

OUTPUT: JSON only, no commentary: an array of 4 shelf objects:
[{"shelf":"<shelf title>","blurb":"<one line>","books":[{"title":"","author":"","year":"","pitch":"<max 12 words, the hook>","why":"<2-3 sentences>","links":["<library book titles this connects to>"],"themes":["<2-3 short theme tags>"],"caution":""}]}]
Shelves (4 objects, in this order): (1) "From your to-read pile": 5 books ranked as what to read next, from TO-READ only; (2) "Closest fit": 8 new books; (3) "Stretch": 6 books that share the reader's underlying ideas but come from a different genre, era or form (non-fiction allowed where it fits); (4) "Wildcards": 4 surprising picks with a strong but non-obvious link to the reader's taste. Keep "why" to 2-3 sentences and "pitch" very short.

TASTE PROFILE (reader-edited, authoritative):
${profile}

STEERING: ${steer.length ? steer.join('; ') : 'none'}
PINNED: ${pinned.join('; ') || 'none'}
DISMISSED: ${dismissed.join('; ') || 'none'}

LIBRARY:
${libraryText(library)}`;
}

module.exports = { libraryText, profilePrompt, recommendPrompt };
