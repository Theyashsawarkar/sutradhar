// Two-way tRPC over any message pipe.
//
// tRPC is built for "client calls server over HTTP". sutradhar needs both
// ends to serve a router and call the other's over one connection (native
// messaging, a unix socket), so this file is the glue: a link that turns a
// client call into a `req` frame, and a handler that runs an incoming `req`
// frame against the local router and answers with `res` / `err`.

import { callTRPCProcedure, getTRPCErrorFromUnknown, type AnyTRPCRouter } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { createTRPCClient, TRPCClientError, type TRPCClient, type TRPCLink } from '@trpc/client';

export type Frame =
  | { t: 'req'; id: string; path: string; type: 'query' | 'mutation'; input: unknown }
  | { t: 'res'; id: string; data: unknown }
  | { t: 'err'; id: string; error: { code: string; message: string } }
  | { t: 'cancel'; id: string };

export interface PeerOptions<Ctx> {
  /** Router this end serves (optional: a pure client serves nothing). */
  router?: AnyTRPCRouter;
  /** Context handed to every procedure called by the other end. */
  ctx?: () => Ctx;
  send: (frame: Frame) => void;
  /** Distinguishes this end's request ids from the other's in logs. */
  idPrefix?: string;
  /** Prepended to every outgoing call's path ("hub." → the remote's `hub` sub-router). */
  pathPrefix?: string;
}

export interface Peer<Remote extends AnyTRPCRouter> {
  client: TRPCClient<Remote>;
  handle: (frame: Frame) => void;
  /** Fails every call still waiting (the pipe is gone). */
  close: (reason?: string) => void;
}

type Waiter = { resolve: (data: unknown) => void; reject: (err: { code: string; message: string }) => void };

export function createPeer<Remote extends AnyTRPCRouter, Ctx = unknown>(opts: PeerOptions<Ctx>): Peer<Remote> {
  const waiting = new Map<string, Waiter>();
  const running = new Map<string, AbortController>();
  let seq = 0;
  let closed = false;

  const link: TRPCLink<Remote> = () => ({ op }) =>
    observable((observer) => {
      if (closed) {
        observer.error(clientError({ code: 'CLIENT_CLOSED_REQUEST', message: 'connection closed' }));
        return () => {};
      }
      const id = `${opts.idPrefix ?? ''}${++seq}`;
      const onAbort = () => {
        if (waiting.delete(id)) {
          opts.send({ t: 'cancel', id });
          observer.error(clientError({ code: 'CLIENT_CLOSED_REQUEST', message: 'cancelled' }));
        }
      };
      waiting.set(id, {
        resolve: (data) => {
          op.signal?.removeEventListener('abort', onAbort);
          observer.next({ result: { type: 'data', data } as never });
          observer.complete();
        },
        reject: (err) => {
          op.signal?.removeEventListener('abort', onAbort);
          observer.error(clientError(err));
        },
      });
      op.signal?.addEventListener('abort', onAbort, { once: true });
      if (op.type === 'subscription') {
        waiting.get(id)!.reject({ code: 'METHOD_NOT_SUPPORTED', message: 'subscriptions are not used on this link' });
        waiting.delete(id);
        return () => {};
      }
      try {
        opts.send({ t: 'req', id, path: (opts.pathPrefix ?? '') + op.path, type: op.type, input: op.input });
      } catch (e) {
        waiting.delete(id);
        observer.error(clientError({ code: 'INTERNAL_SERVER_ERROR', message: String(e) }));
      }
      return () => {
        if (waiting.delete(id)) opts.send({ t: 'cancel', id });
      };
    });

  async function serve(frame: Extract<Frame, { t: 'req' }>) {
    if (!opts.router) {
      opts.send({ t: 'err', id: frame.id, error: { code: 'NOT_FOUND', message: 'this end serves no router' } });
      return;
    }
    const ac = new AbortController();
    running.set(frame.id, ac);
    try {
      const data = await callTRPCProcedure({
        router: opts.router,
        path: frame.path,
        type: frame.type,
        getRawInput: async () => frame.input,
        ctx: opts.ctx ? opts.ctx() : {},
        signal: ac.signal,
        batchIndex: 0,
      });
      if (!ac.signal.aborted) opts.send({ t: 'res', id: frame.id, data: data ?? null });
    } catch (e) {
      const err = getTRPCErrorFromUnknown(e);
      if (!ac.signal.aborted) opts.send({ t: 'err', id: frame.id, error: { code: err.code, message: err.message } });
    } finally {
      running.delete(frame.id);
    }
  }

  return {
    client: createTRPCClient<Remote>({ links: [link] }),
    handle(frame) {
      switch (frame.t) {
        case 'req':
          void serve(frame);
          break;
        case 'res': {
          const w = waiting.get(frame.id);
          if (w) { waiting.delete(frame.id); w.resolve(frame.data); }
          break;
        }
        case 'err': {
          const w = waiting.get(frame.id);
          if (w) { waiting.delete(frame.id); w.reject(frame.error); }
          break;
        }
        case 'cancel':
          running.get(frame.id)?.abort();
          break;
      }
    },
    close(reason = 'connection closed') {
      closed = true;
      for (const [, w] of waiting) w.reject({ code: 'CLIENT_CLOSED_REQUEST', message: reason });
      waiting.clear();
      for (const [, ac] of running) ac.abort();
      running.clear();
    },
  };
}

function clientError(err: { code: string; message: string }) {
  return TRPCClientError.from({ error: { code: -32000, message: err.message, data: { code: err.code } } } as never);
}

/** The tRPC error code of a failed call ("NOT_FOUND", "FORBIDDEN"…), if any. */
export function errorCode(e: unknown): string | undefined {
  const data = (e as { data?: { code?: string } } | undefined)?.data;
  return data?.code;
}
