// Runs an agent's list of steps in one tab: find each element, check the
// step's risk (and stop for the user when it's theirs to do), then act with
// the best input the browser offers.

import type { Step, StepResult } from '../../../packages/protocol/src/schemas.ts';
import * as cdp from './cdp.ts';
import { content, ext, frames, hub, isGecko, S, sleep, splitRef, waitLoad } from './state.ts';

type Prepared = {
  ref: string; x: number; y: number; what: string; risk: { level: string; reason?: string; what?: string };
  editable: boolean; secret: boolean; tag: string; inputType?: string; checked?: boolean; draggable: boolean;
  disabled: boolean; covered?: string; rect: { x: number; y: number; width: number; height: number };
  href?: string; newTab?: boolean;
};

interface Located { frameId: number; target: any; p: Prepared; gx: number; gy: number }

export interface ActContext { tabId: number; session: string; why?: string; signal?: AbortSignal }

/** Where frame `frameId`'s viewport starts, in the tab's top viewport. */
async function frameOrigin(tabId: number, frameId: number): Promise<{ x: number; y: number } | null> {
  if (frameId === 0) return { x: 0, y: 0 };
  const all = await frames(tabId);
  const me = all.find((f) => f.frameId === frameId);
  if (!me) return null;
  const siblings = all.filter((f) => f.parentFrameId === me.parentFrameId).sort((a, b) => a.frameId - b.frameId);
  const parent = await frameOrigin(tabId, me.parentFrameId);
  if (!parent) return null;
  const off = await content<{ x: number; y: number } | null>(tabId, me.parentFrameId, 'frameOffset', { src: me.url, index: siblings.indexOf(me) }).catch(() => null);
  if (!off) return null;
  return { x: parent.x + off.x, y: parent.y + off.y };
}

async function locate(ctx: ActContext, target: any, kind: string, force?: boolean): Promise<Located> {
  const t = { ...target };
  let order: number[];
  if (t.ref) { const s = splitRef(t.ref); order = [s.frameId]; t.ref = s.ref; }
  else if (t.x !== undefined && t.y !== undefined) order = [0];
  else order = (await frames(ctx.tabId)).map((f) => f.frameId).sort((a, b) => a - b);
  let lastErr: unknown;
  for (const frameId of order) {
    try {
      const p = await content<Prepared>(ctx.tabId, frameId, 'prepare', { target: t, kind, force });
      const o = (await frameOrigin(ctx.tabId, frameId)) ?? { x: NaN, y: NaN };
      return { frameId, target: t, p, gx: p.x + o.x, gy: p.y + o.y };
    } catch (e) { lastErr = e; if (t.ref) break; }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Stops for the user when the step is theirs (handoff) or needs a yes (approve). */
async function gate(ctx: ActContext, step: Step, loc: Located): Promise<StepResult | null> {
  const r = loc.p.risk;
  if (r.level === 'none') return null;
  const tab = await ext.tabs.get(ctx.tabId);
  const decision = await hub().gate.mutate({
    tab: ctx.tabId, session: ctx.session, url: tab.url ?? '', kind: r.level as 'handoff' | 'approve',
    reason: r.reason ?? '', what: r.what ?? loc.p.what, step: step.do, why: ctx.why,
  });
  if (decision === 'approved') return null;
  const notes: Record<string, string> = {
    'handoff-done': `the user did this step themselves (${r.reason}); take a new snapshot to see the result`,
    'handoff-declined': `the user declined to do this step (${r.reason}); stop this task and ask them`,
    denied: `the user denied this step (${r.reason})`,
    timeout: `the user didn't respond in time (${r.reason})`,
    stopped: 'the user pressed Stop',
  };
  return { do: step.do, ok: decision === 'handoff-done', gate: decision as StepResult['gate'], note: notes[decision] ?? decision };
}

async function osInput(ctx: ActContext, action: object) {
  return hub().osInput.mutate({ tab: ctx.tabId, ...action } as never);
}

async function clickAt(ctx: ActContext, loc: Located, step: { button?: 'left' | 'right' | 'middle'; count?: number; modifiers?: string[]; trusted?: boolean }) {
  const button = step.button ?? 'left', count = step.count ?? 1, mods = step.modifiers ?? [];
  if (!isGecko && !Number.isNaN(loc.gx)) { await cdp.click(ctx.tabId, loc.gx, loc.gy, button, count, mods); return ''; }
  // Firefox's popup blocker drops synthetic clicks on new-tab links: open it as the click would.
  if (isGecko && loc.p.href && button === 'left' && (loc.p.newTab || mods.includes('Control')) && !step.trusted) {
    await ext.tabs.create({ url: loc.p.href, openerTabId: ctx.tabId, active: !mods.includes('Control') });
    return ' (opened in a new tab)';
  }
  if (isGecko && step.trusted && S.osInput) { await osInput(ctx, { action: 'click', x: loc.gx, y: loc.gy, button, count, modifiers: mods }); return ' (real mouse)'; }
  const before = await content<number>(ctx.tabId, 0, 'changes');
  const url = (await ext.tabs.get(ctx.tabId)).url;
  await content(ctx.tabId, loc.frameId, 'click', { target: loc.target, x: loc.p.x, y: loc.p.y, button, count, modifiers: mods });
  if (isGecko && S.osInput && S.autoRetry && !Number.isNaN(loc.gx) && step.trusted !== false && button === 'left') {
    await sleep(350);
    const after = await content<number>(ctx.tabId, 0, 'changes').catch(() => before + 1);
    const tab = await ext.tabs.get(ctx.tabId);
    if (after === before && tab.url === url && tab.status === 'complete') {
      await osInput(ctx, { action: 'click', x: loc.gx, y: loc.gy, button, count, modifiers: mods });
      return ' (the page ignored a synthetic click; repeated with the real mouse)';
    }
  }
  return '';
}

async function typeInto(ctx: ActContext, loc: Located, value: string, clear?: boolean, trusted?: boolean) {
  if (!isGecko) {
    await content(ctx.tabId, loc.frameId, clear ? 'selectAll' : 'focusEnd', { target: loc.target });
    if (clear) await cdp.press(ctx.tabId, 'Backspace');
    await cdp.type(ctx.tabId, value);
    return;
  }
  if (trusted && S.osInput) {
    await content(ctx.tabId, loc.frameId, clear ? 'selectAll' : 'focusEnd', { target: loc.target });
    await osInput(ctx, { action: 'focus' });
    if (clear) await osInput(ctx, { action: 'key', keys: 'BackSpace' });
    await osInput(ctx, { action: 'type', text: value });
    return;
  }
  await content(ctx.tabId, loc.frameId, 'type', { target: loc.target, value, clear });
}

async function pressKeys(ctx: ActContext, keys: string, loc?: Located, trusted?: boolean) {
  if (loc) await content(ctx.tabId, loc.frameId, 'focus', { target: loc.target });
  if (!isGecko) { await cdp.press(ctx.tabId, keys); return; }
  if (trusted && S.osInput) { await osInput(ctx, { action: 'key', keys }); return; }
  await content(ctx.tabId, loc?.frameId ?? 0, 'key', { target: loc?.target, keys });
}

async function readFiles(paths: string[]) {
  return hub().readFiles.query({ paths });
}

async function settle(ctx: ActContext) {
  await sleep(120);
  const tab = await ext.tabs.get(ctx.tabId).catch(() => null);
  if (tab?.status === 'loading') await waitLoad(ctx.tabId, 15000);
}

const hasTarget = (s: any) => s.ref || s.selector || s.text || (s.x !== undefined && s.y !== undefined);

export async function runStep(ctx: ActContext, step: Step): Promise<StepResult> {
  const ok = (note: string): StepResult => ({ do: step.do, ok: true, note });
  switch (step.do) {
    case 'wait': {
      if (step.ms) { await sleep(Math.min(step.ms, 60000)); return ok(`waited ${step.ms} ms`); }
      if (step.url) {
        const end = Date.now() + (step.timeout ?? 15000);
        while (Date.now() < end && !ctx.signal?.aborted) {
          const tab = await ext.tabs.get(ctx.tabId);
          if (tab.url?.includes(step.url) && tab.status === 'complete') return ok(`URL is ${tab.url}`);
          await sleep(150);
        }
        return { do: 'wait', ok: false, error: `URL never contained "${step.url}"` };
      }
      const t = { ref: step.ref, selector: step.selector, text: step.text, gone: step.gone, timeout: step.timeout };
      const frameId = step.ref ? splitRef(step.ref).frameId : 0;
      if (step.ref) t.ref = splitRef(step.ref).ref;
      const hit = await content<boolean>(ctx.tabId, frameId, 'wait', t);
      return hit ? ok(step.gone ? 'gone' : 'appeared') : { do: 'wait', ok: false, error: `timed out waiting for ${JSON.stringify({ ...t, timeout: undefined })}${step.gone ? ' to go away' : ''}` };
    }
    case 'move': {
      if (!isGecko) await cdp.mouseMove(ctx.tabId, step.x, step.y);
      else if (S.osInput && step.trusted !== false) await osInput(ctx, { action: 'move', x: step.x, y: step.y });
      else await content(ctx.tabId, 0, 'hover', { target: { x: step.x, y: step.y }, x: step.x, y: step.y });
      return ok(`mouse at ${step.x},${step.y}`);
    }
    case 'scroll': {
      if (hasTarget(step)) {
        const loc = await locate(ctx, step, 'scroll', true);
        const note = await content<string>(ctx.tabId, loc.frameId, 'scroll', { target: loc.target, direction: step.direction, amount: step.amount });
        return ok(note);
      }
      return ok(await content<string>(ctx.tabId, 0, 'scroll', { direction: step.direction, amount: step.amount }));
    }
    case 'fill': {
      const notes: string[] = [];
      for (const f of step.fields) {
        const { value, ...target } = f;
        const sub: Step = typeof value === 'boolean' ? { do: 'check', ...target, checked: value, trusted: step.trusted }
          : Array.isArray(value) ? { do: 'select', ...target, value } : { do: 'type', ...target, value, clear: true, trusted: step.trusted };
        let r: StepResult;
        try {
          const loc = await locate(ctx, target, sub.do);
          // A select's value given as a string: select it rather than type.
          if (sub.do === 'type' && loc.p.tag === 'select') r = await runStep(ctx, { do: 'select', ...target, value: value as string });
          else r = await runStep(ctx, sub);
        } catch (e) { r = { do: sub.do, ok: false, error: (e as Error).message }; }
        if (!r.ok) return { ...r, do: 'fill', note: [...notes, r.note].filter(Boolean).join('; ') };
        notes.push(r.note ?? '');
      }
      return ok(notes.join('; '));
    }
  }

  if (step.do === 'drag') {
    const a = await locate(ctx, step.from, 'drag', step.force);
    const b = await locate(ctx, step.to, 'drag', true);
    const g = await gate(ctx, step, a); if (g) return g;
    if (a.p.draggable || a.frameId !== b.frameId || isGecko && !step.trusted) {
      if (a.frameId !== b.frameId) throw new Error('drag between frames is not supported');
      const note = await content<string>(ctx.tabId, a.frameId, 'drag', { from: a.target, to: b.target, fx: a.p.x, fy: a.p.y, tx: b.p.x, ty: b.p.y });
      return ok(`${note}: ${a.p.what} → ${b.p.what}`);
    }
    if (isGecko) await osInput(ctx, { action: 'drag', x: a.gx, y: a.gy, x2: b.gx, y2: b.gy });
    else await cdp.drag(ctx.tabId, a.gx, a.gy, b.gx, b.gy);
    return ok(`dragged ${a.p.what} → ${b.p.what}`);
  }

  if (!hasTarget(step) && step.do === 'press') {
    await pressKeys(ctx, step.keys, undefined, step.trusted);
    await settle(ctx);
    return ok(`pressed ${step.keys}`);
  }
  if (!hasTarget(step)) throw new Error(`${step.do} needs a target: ref, selector, text or x/y`);

  const loc = await locate(ctx, step, step.do, (step as any).force);
  const g = await gate(ctx, step, loc); if (g) return g;
  const what = loc.p.what;
  if (loc.p.covered && !(step as any).force && ['click', 'hover', 'check'].includes(step.do)) {
    throw new Error(`${what} is covered by ${loc.p.covered}; close that first, or pass force=true`);
  }
  if (loc.p.disabled && !(step as any).force && ['click', 'type', 'check', 'select'].includes(step.do)) {
    throw new Error(`${what} is disabled`);
  }
  switch (step.do) {
    case 'click': {
      const extra = await clickAt(ctx, loc, step);
      await settle(ctx);
      return ok(`${step.count === 2 ? 'double-' : ''}${step.button && step.button !== 'left' ? step.button + '-' : ''}clicked ${what}${extra}`);
    }
    case 'hover': {
      if (!isGecko) await cdp.mouseMove(ctx.tabId, loc.gx, loc.gy);
      else if (S.osInput && step.trusted !== false) await osInput(ctx, { action: 'move', x: loc.gx, y: loc.gy });
      else await content(ctx.tabId, loc.frameId, 'hover', { target: loc.target, x: loc.p.x, y: loc.p.y });
      return ok(`hovering ${what}`);
    }
    case 'type': {
      if (!loc.p.editable && loc.p.tag !== 'select') {
        // Typing into a non-field: click it first (search boxes behind a button), then type where focus lands.
        await clickAt(ctx, loc, {});
        if (!isGecko) await cdp.type(ctx.tabId, step.value);
        else await content(ctx.tabId, loc.frameId, 'type', { target: { selector: ':focus' }, value: step.value });
      } else await typeInto(ctx, loc, step.value, step.clear, step.trusted);
      if (step.submit) { await pressKeys(ctx, 'Enter', loc, step.trusted); await settle(ctx); }
      return ok(`typed ${step.value.length} characters into ${what}${step.submit ? ' and pressed Enter' : ''}`);
    }
    case 'press': {
      await pressKeys(ctx, step.keys, loc, step.trusted);
      await settle(ctx);
      return ok(`pressed ${step.keys} in ${what}`);
    }
    case 'clear': {
      if (!isGecko) { await content(ctx.tabId, loc.frameId, 'selectAll', { target: loc.target }); await cdp.press(ctx.tabId, 'Backspace'); }
      else await content(ctx.tabId, loc.frameId, 'clear', { target: loc.target });
      return ok(`cleared ${what}`);
    }
    case 'focus': {
      await content(ctx.tabId, loc.frameId, 'focus', { target: loc.target });
      return ok(`focused ${what}`);
    }
    case 'select': {
      if (loc.p.tag !== 'select') {
        // A custom dropdown: open it, then click the option by text.
        await clickAt(ctx, loc, {});
        await sleep(200);
        const values = Array.isArray(step.value) ? step.value : [step.value];
        for (const v of values) {
          const opt = await locate(ctx, { text: v }, 'click');
          await clickAt(ctx, opt, {});
        }
        return ok(`picked ${values.join(', ')} in ${what}`);
      }
      const picked = await content<string>(ctx.tabId, loc.frameId, 'select', { target: loc.target, value: step.value });
      return ok(`selected ${picked} in ${what}`);
    }
    case 'check': {
      const want = step.checked ?? true;
      if (loc.p.checked === want) return ok(`${what} was already ${want ? 'checked' : 'unchecked'}`);
      await clickAt(ctx, loc, step);
      return ok(`${want ? 'checked' : 'unchecked'} ${what}`);
    }
    case 'upload': {
      const files = await readFiles(step.paths);
      const note = await content<string>(ctx.tabId, loc.frameId, 'upload', { target: loc.target, files });
      return ok(note);
    }
  }
  throw new Error(`unknown step ${(step as any).do}`);
}

export async function act(ctx: ActContext, steps: Step[]) {
  const results: StepResult[] = [];
  const gen = S.stopGen;
  S.agentTabs.set(ctx.tabId, ctx.session);
  await content(ctx.tabId, 0, 'mode', { agent: true, risk: S.risk }).catch(() => {});
  await showActing(ctx.tabId, ctx.session, true);
  try {
    for (const step of steps) {
      if (ctx.signal?.aborted || S.stopGen !== gen) { results.push({ do: step.do, ok: false, gate: 'stopped', note: 'stopped by the user' }); break; }
      let r: StepResult;
      try { r = await runStep(ctx, step); } catch (e) { r = { do: step.do, ok: false, error: (e as Error).message }; }
      results.push(r);
      if (!r.ok) break;
    }
  } finally {
    await showActing(ctx.tabId, ctx.session, false);
  }
  const tab = await ext.tabs.get(ctx.tabId).catch(() => null);
  const dialogs = await content<any[]>(ctx.tabId, 0, 'dialogs').catch(() => []);
  return { results, url: tab?.url ?? '', title: tab?.title ?? '', status: tab?.status ?? 'gone', dialogs: dialogs.slice(-3) };
}

export async function showActing(tabId: number, session: string, on: boolean) {
  const cur = S.overlays.get(tabId);
  if (cur?.mode === 'waiting') return;
  const st = on ? { mode: 'acting' as const, session } : { mode: 'idle' as const };
  if (on) S.overlays.set(tabId, st); else S.overlays.delete(tabId);
  await content(tabId, 0, 'overlay', st).catch(() => {});
}
