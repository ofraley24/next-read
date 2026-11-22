// Shows exactly what the catalogues return for one book, so a missing cover can be diagnosed.
//   npm run cover-debug -- "When We Cease to Understand the World" "Benjamín Labatut"
//   npm run cover-debug -- "The Farthest Reaches" "Brett Hall" 9798994621219
import { diagnose } from '../server/covers.js';
const [title, author, isbn] = process.argv.slice(2);
if (!title || !author) { console.error('Usage: npm run cover-debug -- "<title>" "<author>" [isbn]'); process.exit(1); }
console.log(await diagnose(title, author, isbn, { googleKey: process.env.GOOGLE_BOOKS_API_KEY }));
