// Network rules for testing a site in sutradhar's tabs: block a request,
// send it somewhere else, or answer it with a made-up response. Only tabs an
// agent works in; never the user's. Chrome does it through the debugger's
// Fetch domain, Firefox and Zen through blocking webRequest.

import * as cdp from './cdp.ts';
import { ext, isGecko, S } from './state.ts';

declare const chrome: any;

export interface NetRule { id: number; match: string; type: 'block' | 'redirect' | 'mock'; to?: string; body?: string; status?: number; contentType?: string; hits: number }

export const rules = new Map<number, NetRule[]>();
let nextId = 1;

function matches(rule: NetRule, url: string) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(rule.match);
  if (m) { try { return new RegExp(m[1], m[2]).test(url); } catch { return false; } }
  return url.includes(rule.match);
}

function ruleFor(tabId: number, url: string) {
  const list = rules.get(tabId);
  if (!list?.length || !S.agentTabs.has(tabId)) return undefined;
  const r = list.find((x) => matches(x, url));
  if (r) r.hits++;
  return r;
}

export async function setRules(tabId: number, add: Omit<NetRule, 'id' | 'hits'>[] | null) {
  if (add === null) rules.delete(tabId);
  else rules.set(tabId, [...(rules.get(tabId) ?? []), ...add.map((r) => ({ ...r, id: nextId++, hits: 0 }))]);
  if (!isGecko) {
    if (rules.get(tabId)?.length) { cdp.keep(tabId, true); await cdp.send(tabId, 'Fetch.enable', { patterns: [{ urlPattern: '*' }] }); }
    else { await cdp.send(tabId, 'Fetch.disable').catch(() => {}); cdp.keep(tabId, false); }
  }
  return rules.get(tabId) ?? [];
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

if (isGecko) {
  ext.webRequest.onBeforeRequest.addListener((d: any) => {
    const r = ruleFor(d.tabId, d.url);
    if (!r) return {};
    if (r.type === 'block') return { cancel: true };
    if (r.type === 'redirect' && r.to) return { redirectUrl: r.to };
    if (r.type === 'mock') {
      const f = ext.webRequest.filterResponseData(d.requestId);
      f.onstart = () => { f.write(new TextEncoder().encode(r.body ?? '')); f.close(); };
    }
    return {};
  }, { urls: ['<all_urls>'] }, ['blocking']);
  ext.webRequest.onHeadersReceived.addListener((d: any) => {
    const list = rules.get(d.tabId);
    const r = list?.find((x) => x.type === 'mock' && matches(x, d.url));
    if (!r || !S.agentTabs.has(d.tabId)) return {};
    const headers = (d.responseHeaders ?? []).filter((h: any) => !/^(content-type|content-length|content-encoding)$/i.test(h.name));
    headers.push({ name: 'Content-Type', value: r.contentType ?? 'application/json' });
    return { responseHeaders: headers };
  }, { urls: ['<all_urls>'] }, ['blocking', 'responseHeaders']);
} else if (typeof chrome !== 'undefined' && chrome.debugger) {
  chrome.debugger.onEvent.addListener((src: { tabId?: number }, method: string, p: any) => {
    if (method !== 'Fetch.requestPaused' || !src.tabId) return;
    const tabId = src.tabId;
    const r = ruleFor(tabId, p.request.url);
    const go = (m: string, params: object) => chrome.debugger.sendCommand({ tabId }, m, { requestId: p.requestId, ...params }).catch(() => {});
    if (!r) return go('Fetch.continueRequest', {});
    if (r.type === 'block') return go('Fetch.failRequest', { errorReason: 'BlockedByClient' });
    if (r.type === 'redirect' && r.to) return go('Fetch.continueRequest', { url: r.to });
    if (r.type === 'mock') return go('Fetch.fulfillRequest', { responseCode: r.status ?? 200, responseHeaders: [{ name: 'Content-Type', value: r.contentType ?? 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: b64(r.body ?? '') });
    return go('Fetch.continueRequest', {});
  });
}
