// sutradhar: one binary for the daemon, the native host, the MCP server and
// the command line.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPeer } from '../../protocol/src/rpc.ts';
import { createLineReader } from '../../protocol/src/framing.ts';
import { agentClient, connectRaw } from './client.ts';
import type { AdminRouter } from './daemon.ts';
import { CHROMIUM_DIRS, extensionHelp, GECKO_DIRS, HOST_NAME, install, root, uninstall } from './install.ts';
import { paths } from './paths.ts';
import { readLog } from './state.ts';

const VERSION = process.env.SUTRADHAR_VERSION ?? '0.1.0';

const HELP = `sutradhar ${VERSION}: lets AI agents use your real browser (Chrome, Firefox, Zen).

  sutradhar status              what's connected: browsers, agent sessions, waiting steps
  sutradhar stop                stop every agent now (they ask before carrying on)
  sutradhar resume              let stopped agents carry on (from a terminal)
  sutradhar watch               bring the tab sutradhar is working in to the front
  sutradhar pause | handback    take over (agents wait between steps) / give control back
  sutradhar record start|stop [--webm]
                                film sutradhar's tab (pointer and captions included)
  sutradhar log [-n N]          recent actions, newest last
  sutradhar call TOOL [JSON]    call a tool as an agent would ("sutradhar tools" lists them)
  sutradhar tools               the tools agents get
  sutradhar install [--no-service]
                                native-messaging hosts for every browser + the user service
  sutradhar uninstall
  sutradhar doctor              check the install
  sutradhar mcp [--name NAME]   MCP server on stdio (for agents; pranali when installed)
  sutradhar daemon              run the daemon in the foreground
  sutradhar host                native-messaging host (browsers start it)
  sutradhar version`;

async function admin() {
  const sock = await connectRaw().catch(() => null);
  if (!sock) return null;
  const peer = createPeer<AdminRouter>({ send: (f) => sock.write(JSON.stringify(f) + '\n'), pathPrefix: 'admin.' });
  sock.setEncoding('utf8');
  sock.on('data', createLineReader((l) => peer.handle(JSON.parse(l))));
  return { client: peer.client, done: () => sock.destroy() };
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'daemon': { const { runDaemon } = await import('./daemon.ts'); await runDaemon(); return; }
    case 'host': { const { runHost } = await import('./host.ts'); await runHost(); return; }
    case 'mcp': {
      // Normally bin/sutradhar runs pranali for `sutradhar mcp`; this is the in-process server
      // (pranali's --fallback, or agents without pranali). `--in-process` is accepted and implied.
      const { agentName, runMcp } = await import('./mcp.ts'); await runMcp(agentName(rest)); return;
    }
    case 'call': {
      const [tool, json] = rest;
      if (!tool) throw new Error('usage: sutradhar call TOOL [JSON]');
      const { toolList } = await import('./mcp.ts');
      const { agentRouter } = await import('./agent-router.ts');
      if (!toolList().some((x) => x.name === tool)) throw new Error(`no tool "${tool}"; see sutradhar tools`);
      // One session per terminal (or per SUTRADHAR_SESSION), kept between calls, so tabs stay yours.
      const key = process.env.SUTRADHAR_SESSION || `cli-${process.ppid}`;
      const { client, socket } = await agentClient(process.env.SUTRADHAR_AGENT || 'cli', key, process.cwd());
      const args = json ? JSON.parse(json) : {};
      const type = ((agentRouter as any)._def.procedures[tool])._def.type;
      const r = type === 'query' ? await (client as any)[tool].query(args) : await (client as any)[tool].mutate(args);
      if (r && typeof r === 'object' && 'image' in r) {
        const p = join(process.env.TMPDIR || '/tmp', `sutradhar-shot-${Date.now()}.${r.image.mime.split('/')[1]}`);
        (await import('node:fs')).writeFileSync(p, Buffer.from(r.image.data, 'base64'));
        console.log(p);
      } else console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
      socket.destroy();
      return;
    }
    case 'tools': {
      const { toolList } = await import('./mcp.ts');
      for (const x of toolList()) console.log(`${x.name.padEnd(14)} ${x.description.split('\n')[0]}`);
      return;
    }
    case 'status': {
      const a = await admin();
      if (!a) { console.log(`daemon: not running (${paths.socket})`); process.exitCode = 1; return; }
      const s = await a.client.status.query();
      console.log(`daemon: running (pid ${s.pid}) on ${s.socket}`);
      console.log(`browsers: ${s.browsers.length ? '' : 'none connected'}`);
      for (const b of s.browsers) console.log(`  ${b.id}: ${b.name} ${b.version}, extension ${b.extension}`);
      console.log(`agents: ${s.sessions.length ? '' : 'none'}`);
      for (const x of s.sessions) console.log(`  ${x.id}${x.client ? ` (${x.client})` : ''}${x.stopped ? ' (stopped)' : ''}: ${x.browser ?? '-'} tabs ${x.tabs.join(', ') || '-'}`);
      if (s.paused) console.log('paused: you have control (sutradhar handback)');
      if (s.gates.length) console.log('waiting on you:');
      for (const g of s.gates) console.log(`  ${g.kind} for ${g.session}: ${g.title} (${g.url})`);
      a.done(); return;
    }
    case 'stop': {
      const a = await admin();
      if (!a) { console.log('daemon not running: nothing to stop'); return; }
      const r = await a.client.stop.mutate();
      console.log(`stopped ${r.stoppedSessions} session(s), cancelled ${r.cancelledCalls} call(s)`);
      a.done(); return;
    }
    case 'resume': {
      // Only from a person at a terminal: an agent's shell has no TTY.
      if (!process.stdin.isTTY) throw new Error('resume from a terminal, or from the extension panel');
      const a = await admin();
      if (!a) { console.log('daemon not running'); return; }
      await a.client.resume.mutate(); console.log('agents may carry on'); a.done(); return;
    }
    case 'pause': case 'handback': {
      const a = await admin();
      if (!a) { console.log('daemon not running'); return; }
      await (a.client as any)[cmd].mutate();
      console.log(cmd === 'pause' ? 'paused: you have control (sutradhar handback gives it back)' : 'handed back: sutradhar carries on'); a.done(); return;
    }
    case 'record': {
      const a = await admin();
      if (!a) { console.log('daemon not running'); return; }
      const action = (rest[0] ?? 'status') as 'start' | 'stop' | 'status';
      console.log(await a.client.record.mutate({ action, format: rest.includes('--webm') ? 'webm' : 'gif' })); a.done(); return;
    }
    case 'watch': {
      const a = await admin();
      if (!a) { console.log('daemon not running'); return; }
      console.log(await a.client.watch.mutate()); a.done(); return;
    }
    case 'log': {
      const n = rest[0] === '-n' ? +rest[1] : 40;
      for (const e of readLog(n)) {
        const { time, session, tool, ok, error, ...r } = e;
        console.log(`${time.slice(11, 19)} ${session ?? r.browser ?? '-'} ${tool ?? r.event ?? r.gate ?? ''} ${ok === false ? 'FAILED ' + error : ''} ${JSON.stringify(r)}`);
      }
      return;
    }
    case 'install': {
      for (const l of install({ service: !rest.includes('--no-service') })) console.log(l);
      console.log('\n' + extensionHelp());
      return;
    }
    case 'uninstall': uninstall(); console.log('removed the native hosts and the service'); return;
    case 'doctor': {
      const r = root();
      const check = (ok: boolean, what: string, fix = '') => console.log(`${ok ? '✓' : '✗'} ${what}${ok || !fix ? '' : `\n    → ${fix}`}`);
      check(existsSync(join(r, 'dist', 'sutradhar.mjs')), 'built', 'pnpm build');
      check(existsSync(join(r, 'dist', 'chrome', 'manifest.json')), 'Chrome extension built (dist/chrome)', 'pnpm build');
      check(existsSync(join(r, 'dist', 'sutradhar-firefox.xpi')), 'Firefox/Zen extension built (dist/sutradhar-firefox.xpi)', 'pnpm build');
      check(existsSync(join(r, 'dist', 'sutradhar-host')), 'native host built (dist/sutradhar-host)', 'install Rust (cargo), then pnpm build; until then each browser\'s host is a Node process');
      {
        const { execFileSync } = await import('node:child_process');
        let ok = true; try { execFileSync('sh', ['-c', 'command -v pranali'], { stdio: 'ignore' }); } catch { ok = false; }
        check(ok, 'pranali on PATH (sutradhar mcp is a small pipe)', 'install pranali; until then each agent\'s sutradhar mcp is a Node process');
        for (const unit of ['sutradhar.socket', 'sutradhar-mcp.socket']) {
          let on = true; try { execFileSync('systemctl', ['--user', 'is-active', '--quiet', unit], { stdio: 'ignore' }); } catch { on = false; }
          check(on, `${unit} listening`, 'sutradhar install');
        }
      }
      let any = false;
      for (const [n, d] of Object.entries({ ...CHROMIUM_DIRS, ...GECKO_DIRS })) {
        const f = join(d, `${HOST_NAME}.json`);
        if (existsSync(f)) { any = true; const m = JSON.parse(readFileSync(f, 'utf8')); check(existsSync(m.path), `native host for ${n}`, 'sutradhar install'); }
      }
      check(any, 'native hosts installed', 'sutradhar install');
      const a = await admin();
      check(!!a, `daemon running (${paths.socket})`, 'systemctl --user start sutradhar (or connect: sutradhar.socket starts it)');
      if (a) {
        const s = await a.client.status.query();
        check(s.browsers.length > 0, `browsers connected: ${s.browsers.map((b) => b.id).join(', ') || 'none'}`, 'add the extension (sutradhar install prints how) and open the browser');
        a.done();
      }
      for (const tool of ['notify-send', 'swaymsg', 'wtype', 'wl-copy', 'ffmpeg']) {
        const { execFileSync } = await import('node:child_process');
        let ok = true; try { execFileSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }); } catch { ok = false; }
        check(ok, `${tool} found`, tool === 'wtype' || tool === 'swaymsg' ? 'needed for real mouse/keyboard (sway)' : tool === 'ffmpeg' ? 'needed for record' : '');
      }
      return;
    }
    case 'version': case '--version': case '-v': console.log(VERSION); return;
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); return;
    default: throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((e) => { console.error(`sutradhar: ${e.message ?? e}`); process.exit(1); });
