import { initTRPC, TRPCError } from '@trpc/server';
import type { Conn } from './state.ts';

export interface Ctx { conn: Conn }

export interface Meta {
  /** Shown to agents as the MCP tool's description. */
  description?: string;
  /** The result holds page content: wrap it in <untrusted>. */
  untrusted?: boolean;
}

export const t = initTRPC.context<Ctx>().meta<Meta>().create({ isServer: true });

/** Only a browser connection (after hello) may call the hub. */
export const browserProc = t.procedure.use(({ ctx, next, path }) => {
  if (path === 'hub.hello') return next();
  if (ctx.conn.role !== 'browser') throw new TRPCError({ code: 'FORBIDDEN', message: 'only a browser may call this' });
  return next();
});

/** Only an agent connection may call the agent API. */
export const agentProc = t.procedure.use(({ ctx, next }) => {
  if (ctx.conn.role === 'browser') throw new TRPCError({ code: 'FORBIDDEN', message: 'browsers may not call agent tools' });
  ctx.conn.role = 'agent';
  return next();
});
