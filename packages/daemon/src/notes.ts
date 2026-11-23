// Site recipes: short notes per site about what worked there ("LinkedIn
// post: Start a post → editor → photo icon beside the emoji → Next → Post"),
// so the next run starts from what the last one learned. Kept on this
// machine, in ~/.local/state/sutradhar/sites/<host>.json.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.ts';

export interface Note { text: string; time: string }

/** "www.linkedin.com" and "linkedin.com" share notes. */
export function siteKey(urlOrHost: string) {
  let host = urlOrHost;
  try { host = new URL(urlOrHost).hostname; } catch { /* a bare host */ }
  return host.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '');
}

const file = (key: string) => join(paths.state, 'sites', `${key}.json`);

export function readNotes(urlOrHost: string): Note[] {
  const key = siteKey(urlOrHost);
  if (!key) return [];
  try { return JSON.parse(readFileSync(file(key), 'utf8')).notes ?? []; } catch { return []; }
}

export function writeNotes(urlOrHost: string, notes: Note[]) {
  const key = siteKey(urlOrHost);
  mkdirSync(join(paths.state, 'sites'), { recursive: true });
  writeFileSync(file(key), JSON.stringify({ site: key, notes }, null, 2) + '\n');
}

export function addNote(urlOrHost: string, text: string) {
  const notes = readNotes(urlOrHost).filter((n) => n.text !== text);
  notes.push({ text: text.trim().slice(0, 1200), time: new Date().toISOString() });
  writeNotes(urlOrHost, notes.slice(-30));
  return notes;
}

export function formatNotes(urlOrHost: string) {
  const notes = readNotes(urlOrHost);
  if (!notes.length) return '';
  return `\nNotes for ${siteKey(urlOrHost)} from earlier runs (site_notes):\n` + notes.map((n, i) => `  ${i + 1}. ${n.text}`).join('\n');
}
