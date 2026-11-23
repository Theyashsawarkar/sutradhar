import { describe, expect, it } from 'vitest';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { createPeer, errorCode, type Frame } from '../../packages/protocol/src/rpc.ts';
import { createJoiner, createLineReader, splitFrame } from '../../packages/protocol/src/framing.ts';

const t = initTRPC.context<{ who: string }>().create({ isServer: true });
const aRouter = t.router({
  hi: t.procedure.input(z.object({ name: z.string() })).query(({ input, ctx }) => `hi ${input.name} from ${ctx.who}`),
  boom: t.procedure.mutation(() => { throw new Error('nope'); }),
  slow: t.procedure.mutation(async ({ signal }) => { await new Promise((r, j) => { const x = setTimeout(r, 2000); signal?.addEventListener('abort', () => { clearTimeout(x); j(new Error('aborted')); }); }); return 'done'; }),
});
const bRouter = t.router({ ping: t.procedure.query(() => 'pong') });

function pair() {
  let a!: ReturnType<typeof createPeer<typeof bRouter>>;
  let b!: ReturnType<typeof createPeer<typeof aRouter>>;
  const toB = (f: Frame) => queueMicrotask(() => b.handle(JSON.parse(JSON.stringify(f))));
  const toA = (f: Frame) => queueMicrotask(() => a.handle(JSON.parse(JSON.stringify(f))));
  a = createPeer<typeof bRouter>({ router: aRouter, ctx: () => ({ who: 'A' }), send: toB });
  b = createPeer<typeof aRouter>({ router: bRouter, ctx: () => ({ who: 'B' }), send: toA });
  return { a, b };
}

describe('two-way tRPC peer', () => {
  it('calls both ways over one pipe', async () => {
    const { a, b } = pair();
    expect(await b.client.hi.query({ name: 'x' })).toBe('hi x from A');
    expect(await a.client.ping.query()).toBe('pong');
  });
  it('passes errors with their code', async () => {
    const { b } = pair();
    await expect(b.client.boom.mutate()).rejects.toThrow('nope');
    try { await b.client.hi.query({ name: 1 as never }); } catch (e) { expect(errorCode(e)).toBe('BAD_REQUEST'); }
  });
  it('cancels the remote call when aborted', async () => {
    const { b } = pair();
    const ac = new AbortController();
    const p = b.client.slow.mutate(undefined, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow();
  });
  it('fails waiting calls when closed', async () => {
    const sent: Frame[] = [];
    const p = createPeer<typeof aRouter>({ send: (f) => sent.push(f) });
    const call = p.client.hi.query({ name: 'y' });
    p.close('gone');
    await expect(call).rejects.toThrow('gone');
    expect(sent[0]).toMatchObject({ t: 'req', path: 'hi' });
  });
  it('prefixes paths', () => {
    const sent: Frame[] = [];
    const p = createPeer<typeof aRouter>({ send: (f) => sent.push(f), pathPrefix: 'agent.' });
    void p.client.hi.query({ name: 'z' }).catch(() => {});
    expect((sent[0] as any).path).toBe('agent.hi');
    p.close();
  });
});

describe('framing', () => {
  it('splits big frames and joins them back', () => {
    const big = JSON.stringify({ t: 'res', id: '1', data: 'x'.repeat(2_000_000) });
    const parts = splitFrame(big, 100_000);
    expect(parts.length).toBe(21);
    const join = createJoiner();
    let out: unknown;
    for (const p of parts.reverse()) out = join(JSON.parse(p)) ?? out;
    expect((out as any).data.length).toBe(2_000_000);
  });
  it('reads lines across chunks', () => {
    const lines: string[] = [];
    const r = createLineReader((l) => lines.push(l));
    r('{"a":1}\n{"b"'); r(':2}\n\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});
