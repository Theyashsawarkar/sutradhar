// Replays: one recorder for the agent's `record` tool, the panel's button and
// `sutradhar record`. It films the tab sutradhar works in (pointer, captions
// and all: they are part of the page) and makes a GIF or WebM.

import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { notify } from './notify.ts';
import { paths } from './paths.ts';
import { D, log, type BrowserConn } from './state.ts';

const run = promisify(execFile);

export interface Recording { browserId: string; tab: number; dir: string; frames: number; format: 'gif' | 'webm'; timer: ReturnType<typeof setInterval>; started: number }

export const recorder: { current: Recording | null } = { current: null };

export function frame(tab: number, b64: string) {
  const rec = recorder.current;
  if (!rec || rec.tab !== tab) return;
  rec.frames++;
  writeFileSync(join(rec.dir, String(rec.frames).padStart(5, '0') + '.jpg'), Buffer.from(b64, 'base64'));
}

export function startRecording(b: BrowserConn, tab: number, format: 'gif' | 'webm' = 'gif') {
  if (recorder.current) clearInterval(recorder.current.timer);
  const dir = mkdtempSync(join(tmpdir(), 'sutradhar-rec-'));
  const rec: Recording = {
    browserId: b.id, tab, dir, frames: 0, format, started: Date.now(),
    // Two frames a second; a frame after every step too (agent-router).
    timer: setInterval(() => {
      b.client.page.screenshot.query({ tab, format: 'jpeg', quality: 75, maxWidth: 1280 }).then((i) => frame(tab, i.data)).catch(() => {});
    }, 500),
  };
  recorder.current = rec;
  log({ event: 'record-start', tab, format });
  return rec;
}

export async function stopRecording(out?: string) {
  const rec = recorder.current;
  if (!rec) throw new Error('not recording');
  clearInterval(rec.timer);
  recorder.current = null;
  if (!rec.frames) { rmSync(rec.dir, { recursive: true, force: true }); throw new Error('no frames were captured (is the tab still open?)'); }
  const path = out ?? join(paths.downloads, `sutradhar-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${rec.format}`);
  mkdirSync(dirname(path), { recursive: true });
  const scale = 'scale=trunc(min(iw\\,1280)/2)*2:-2';
  const input = ['-y', '-framerate', '2', '-start_number', '1', '-i', join(rec.dir, '%05d.jpg')];
  const args = rec.format === 'gif'
    ? [...input, '-vf', `${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`, path]
    : [...input, '-vf', scale, '-c:v', 'libvpx-vp9', '-b:v', '1500k', path];
  await run('ffmpeg', args, { maxBuffer: 10e6 });
  rmSync(rec.dir, { recursive: true, force: true });
  log({ event: 'record-stop', path, frames: rec.frames });
  notify({
    title: 'sutradhar: replay saved', body: `${path}\n${rec.frames} frames, ${Math.round((Date.now() - rec.started) / 1000)} s`, urgency: 'normal',
    actions: { open: 'Open' },
    onAction: (k) => { if (k === 'open' || k === 'default') spawn('xdg-open', [path], { detached: true, stdio: 'ignore' }).unref(); },
  });
  return { path, frames: rec.frames };
}

/** The tab to film when the user asks (panel, CLI): the one sutradhar used last. */
export async function workingTab(): Promise<{ b: BrowserConn; tab: number } | null> {
  const recent = [...D.sessions.values()].filter((s) => s.tab !== undefined && s.browserId).sort((a, b) => b.started - a.started)[0];
  if (recent) { const b = D.browsers.get(recent.browserId!); if (b) return { b, tab: recent.tab! }; }
  for (const b of D.browsers.values()) {
    const tabs = await b.client.tabs.list.query().catch(() => []);
    const t = tabs.find((x: any) => x.group === 'sutra' || x.agent);
    if (t) return { b, tab: t.id };
  }
  return null;
}
