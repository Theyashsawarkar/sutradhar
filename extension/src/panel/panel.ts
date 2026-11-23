// The toolbar panel: what agents are doing, steps waiting on you, Stop, and
// this site's rules.

declare const chrome: any;
const ext: any = (globalThis as any).browser ?? chrome;
const $ = (id: string) => document.getElementById(id)!;

async function ask(msg: object): Promise<any> {
  const r = await ext.runtime.sendMessage(msg);
  if (r && r.error) throw new Error(r.error);
  return r;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

let host = '';

async function refresh() {
  let st: any;
  try { st = await ask({ type: 'state' }); } catch (e) { $('conn').textContent = String(e); return; }
  const conn = $('conn');
  if (!st.connected) { conn.textContent = 'Not connected to the daemon: run "sutradhar install"'; conn.className = 'bad'; }
  else { conn.textContent = `Connected · ${st.hello?.name ?? ''}`; conn.className = 'ok'; }

  const gates = $('gates');
  gates.innerHTML = '';
  for (const g of st.gates ?? []) {
    const card = el('div', { class: 'card' });
    card.append(el('h3', {}, g.kind === 'handoff' ? 'Your turn: sutradhar is waiting' : 'sutradhar asks to go ahead'));
    card.append(el('p', {}, g.title));
    if (g.what) card.append(el('p', { class: 'what' }, g.what));
    if (g.why) card.append(el('p', { class: 'muted' }, g.why));
    const row = el('div', { class: 'row' });
    const btn = (label: string, cls: string, outcome: string) => {
      const b = el('button', { class: cls }, label);
      b.addEventListener('click', async () => { await ask({ type: 'resolve', id: g.id, outcome }); refresh(); });
      return b;
    };
    if (g.kind === 'handoff') row.append(btn("I won't", 'quiet', 'declined'), btn('Done', 'go', 'done'));
    else row.append(btn('Deny', 'quiet', 'denied'), btn('Allow', 'go', 'approved'));
    card.append(row);
    gates.append(card);
  }

  const ul = $('sessions');
  ul.innerHTML = '';
  const sessions = st.sessions ?? [];
  // Never which agent: only that sutradhar is at work, and where.
  const working = sessions.filter((s: any) => !s.stopped);
  const stopped = sessions.length - working.length;
  const tabs = working.reduce((n: number, s: any) => n + s.tabs.length, 0);
  const li = el('li');
  if (!sessions.length) li.append(el('span', { class: 'muted' }, 'idle'));
  else li.append(el('span', { class: stopped && !working.length ? 'bad' : 'ok' }, stopped && !working.length ? '■ ' : '● '),
    document.createTextNode(working.length ? `sutradhar is working in ${tabs} tab(s)` : 'stopped'));
  ul.append(li);
  for (const n of st.now ?? []) {
    const row = el('li');
    row.append(el('span', { class: 'accent' }, '▸ '), document.createTextNode(`${n.label}${n.host ? ' on ' + n.host : ''}`));
    ul.append(row);
  }
  ($('watch') as HTMLButtonElement).hidden = !working.length;
  const pb = $('pause') as HTMLButtonElement;
  pb.hidden = !working.length && !st.paused;
  pb.textContent = st.paused ? 'Hand back to sutradhar' : 'Pause (take over)';
  const rb = $('record') as HTMLButtonElement;
  rb.hidden = !sessions.length && !st.recording;
  rb.textContent = st.recording ? '■ Stop recording' : '● Record a replay';
  ($('resume') as HTMLButtonElement).hidden = !sessions.some((s: any) => s.stopped);

  const log = $('log');
  log.innerHTML = '';
  for (const e of (st.log ?? []).slice(-12).reverse()) {
    const text = `${(e.time ?? '').slice(11, 19)} ${e.tool ?? e.gate ?? e.event ?? ''} ${e.url ?? e.steps ?? e.title ?? ''}${e.outcome ? ' → ' + e.outcome : ''}`;
    log.append(el('li', { class: e.ok === false ? 'fail' : '' }, e.ok === false ? `${text} — ${e.error}` : text));
  }

  const rules = st.config?.sites?.[host] ?? {};
  // Ticked = ask here (the default is go ahead; only risky steps always wait for you).
  ($('approve') as HTMLInputElement).checked = rules.approve === 'ask';
  ($('eval') as HTMLInputElement).checked = rules.eval === 'ask';
}

async function init() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  try { host = new URL(tab?.url ?? '').hostname; } catch { host = ''; }
  $('site').textContent = host || 'no site';
  for (const id of ['approve', 'eval']) {
    const box = $(id) as HTMLInputElement;
    box.disabled = !host;
    box.addEventListener('change', async () => {
      await ask({ type: 'policy-set', patch: { site: host, rule: { [id]: box.checked ? 'ask' : 'allow' } } });
      refresh();
    });
  }
  $('stop').addEventListener('click', async () => { await ask({ type: 'stop' }).catch(() => {}); refresh(); });
  $('watch').addEventListener('click', async () => { await ask({ type: 'watch' }); });
  $('record').addEventListener('click', async () => { await ask({ type: 'record' }).catch(() => {}); refresh(); });
  $('pause').addEventListener('click', async () => { const st = await ask({ type: 'state' }); await ask({ type: st.paused ? 'handback' : 'pause' }); refresh(); });
  $('resume').addEventListener('click', async () => { await ask({ type: 'resume' }); refresh(); });
  await refresh();
  setInterval(refresh, 1500);
}

init();
