// A tiny Wayland client, just enough for a virtual pointer
// (zwlr_virtual_pointer_v1, which sway and other wlroots compositors offer).
// It gives the seat a real pointer device, so clicks land even where no
// mouse is plugged in, and nothing needs to be installed.

import { createConnection, type Socket } from 'node:net';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const BTN: Record<string, number> = { left: 0x110, right: 0x111, middle: 0x112 };

class Conn {
  private sock!: Socket;
  private nextId = 2; // 1 is wl_display
  private buf = Buffer.alloc(0);
  private listeners = new Map<number, (op: number, body: Buffer) => void>();
  globals: { name: number; iface: string; version: number }[] = [];

  async open() {
    const dir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`;
    let display = process.env.WAYLAND_DISPLAY;
    if (!display) display = readdirSync(dir).filter((f) => /^wayland-\d+$/.test(f)).sort()[0];
    if (!display) throw new Error('no Wayland display');
    const path = display.startsWith('/') ? display : join(dir, display);
    this.sock = await new Promise<Socket>((ok, fail) => { const s = createConnection(path); s.once('connect', () => ok(s)); s.once('error', fail); });
    this.sock.on('data', (d) => this.read(d as Buffer));
    this.sock.on('error', () => {});
    this.listeners.set(1, (op, body) => {
      if (op === 0) { // wl_display.error
        const msg = this.str(body, 8).s;
        this.failure = new Error(`Wayland error: ${msg}`);
      }
    });
    const registry = this.newId();
    this.listeners.set(registry, (op, body) => {
      if (op !== 0) return;
      const name = body.readUInt32LE(0);
      const { s: iface, next } = this.str(body, 4);
      this.globals.push({ name, iface, version: body.readUInt32LE(next) });
    });
    this.send(1, 1, [u32(registry)]);
    await this.roundtrip();
    return registry;
  }

  failure: Error | null = null;

  private str(body: Buffer, at: number) {
    const len = body.readUInt32LE(at);
    const s = body.subarray(at + 4, at + 4 + len - 1).toString('utf8');
    return { s, next: at + 4 + Math.ceil(len / 4) * 4 };
  }

  private read(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 8) {
      const id = this.buf.readUInt32LE(0);
      const sizeOp = this.buf.readUInt32LE(4);
      const size = sizeOp >>> 16, op = sizeOp & 0xffff;
      if (this.buf.length < size) break;
      this.listeners.get(id)?.(op, this.buf.subarray(8, size));
      this.buf = this.buf.subarray(size);
    }
  }

  newId() { return this.nextId++; }

  send(id: number, op: number, args: Buffer[]) {
    const body = Buffer.concat(args);
    const head = Buffer.alloc(8);
    head.writeUInt32LE(id, 0);
    head.writeUInt32LE(((8 + body.length) << 16) | op, 4);
    this.sock.write(Buffer.concat([head, body]));
  }

  roundtrip() {
    return new Promise<void>((ok, fail) => {
      const cb = this.newId();
      const t = setTimeout(() => fail(new Error('Wayland roundtrip timed out')), 3000);
      this.listeners.set(cb, () => { clearTimeout(t); this.listeners.delete(cb); this.failure ? fail(this.failure) : ok(); });
      this.send(1, 0, [u32(cb)]);
    });
  }

  bind(registry: number, iface: string, version: number) {
    const g = this.globals.find((x) => x.iface === iface);
    if (!g) return 0;
    const id = this.newId();
    this.send(registry, 0, [u32(g.name), wlString(iface), u32(Math.min(version, g.version)), u32(id)]);
    return id;
  }

  close() { this.sock.end(); }
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n | 0, 0); return b; };
const fixed = (v: number) => i32(Math.round(v * 256));
function wlString(s: string) {
  const bytes = Buffer.from(s + '\0', 'utf8');
  const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
  bytes.copy(padded);
  return Buffer.concat([u32(bytes.length), padded]);
}

export interface Layout { x: number; y: number; width: number; height: number }

/** A short-lived virtual pointer: run `fn` with it, then remove it. */
export async function withPointer<T>(layout: Layout, fn: (p: VirtualPointer) => Promise<T>): Promise<T> {
  const c = new Conn();
  const registry = await c.open();
  const seat = c.bind(registry, 'wl_seat', 1);
  const mgr = c.bind(registry, 'zwlr_virtual_pointer_manager_v1', 1);
  if (!mgr) { c.close(); throw new Error('this compositor has no virtual pointer (zwlr_virtual_pointer_manager_v1)'); }
  const ptr = c.newId();
  c.send(mgr, 0, [u32(seat), u32(ptr)]);
  await c.roundtrip();
  const p = new VirtualPointer(c, ptr, layout);
  try {
    return await fn(p);
  } finally {
    c.send(ptr, 8, []); // destroy
    await c.roundtrip().catch(() => {});
    c.close();
  }
}

export class VirtualPointer {
  constructor(private c: Conn, private id: number, private layout: Layout) {}
  private time() { return Date.now() & 0xffffffff; }

  async move(x: number, y: number) {
    const L = this.layout;
    this.c.send(this.id, 1, [u32(this.time()), u32(Math.round(x - L.x)), u32(Math.round(y - L.y)), u32(L.width), u32(L.height)]);
    this.c.send(this.id, 4, []);
    await this.c.roundtrip();
  }

  async button(name: string, down: boolean) {
    this.c.send(this.id, 2, [u32(this.time()), u32(BTN[name] ?? BTN.left), u32(down ? 1 : 0)]);
    this.c.send(this.id, 4, []);
    await this.c.roundtrip();
  }

  async click(name = 'left', count = 1) {
    for (let i = 0; i < count; i++) {
      await this.button(name, true);
      await new Promise((r) => setTimeout(r, 30));
      await this.button(name, false);
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  async wheel(direction: 'up' | 'down', notches = 3) {
    for (let i = 0; i < notches; i++) {
      const v = direction === 'down' ? 1 : -1;
      this.c.send(this.id, 5, [u32(0)]); // axis_source: wheel
      this.c.send(this.id, 7, [u32(this.time()), u32(0), fixed(15 * v), i32(v)]); // axis_discrete (vertical)
      this.c.send(this.id, 4, []);
      await this.c.roundtrip();
    }
  }
}
