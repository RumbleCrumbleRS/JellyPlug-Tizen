// JELA-971: attach immediately after SDB debug launch/forward, before home loads.
// Does not launch, reload, send keys, clear storage, or change the viewport.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function installTrace() {
  var W = window;
  if (W.__ihScrollTrace) return;
  var G = W.__ihScrollTrace = { events: [], started: Date.now() };
  function record(op, before, node, stack) {
    if (G.events.length >= 160) return;
    G.events.push({ op: op, ms: Date.now() - G.started, before: before,
      after: W.pageYOffset || 0, tag: node && node.tagName || '',
      stack: String(stack || '').replace(/(?:https?|file):[^\s)]+/g, '[source]') });
  }
  function wrap(obj, key) {
    var fn = obj && obj[key];
    if (typeof fn !== 'function') return;
    obj[key] = function () {
      var before = W.pageYOffset || 0, stack = new Error().stack;
      var result = fn.apply(this, arguments);
      record(key, before, this, stack);
      return result;
    };
  }
  wrap(W.HTMLElement && W.HTMLElement.prototype, 'focus');
  wrap(W.Element && W.Element.prototype, 'scrollIntoView');
  wrap(W, 'scrollTo');
  wrap(W, 'scrollBy');
  // Explicit scrollTop setters are separate from focus-induced native scrolling.
  var proto = W.Element && W.Element.prototype;
  while (proto) {
    var d = Object.getOwnPropertyDescriptor(proto, 'scrollTop');
    if (d) {
      if (d.configurable && d.set) {
        var setter = d.set;
        d.set = function (value) {
          var before = W.pageYOffset || 0, stack = new Error().stack;
          setter.call(this, value);
          record('scrollTop', before, this, stack);
        };
        Object.defineProperty(proto, 'scrollTop', d);
      }
      break;
    }
    proto = Object.getPrototypeOf(proto);
  }
}

export function sample() {
  var W = window, ih = W.__shellIH, meta = null;
  try { meta = JSON.parse(localStorage.getItem('jellyfin.shell.instantHome') || 'null'); } catch (_) {}
  var a = document.activeElement;
  return { now: Date.now(), y: W.pageYOffset || 0, home: /home/.test(location.hash),
    focusTag: a && a.tagName, cards: document.querySelectorAll('.card').length,
    ih: ih ? { painted: ih.painted, skeleton: ih.skeleton, paintMs: ih.paintMs,
      captured: ih.captured, capMs: ih.capMs, capSource: ih.capSource,
      pristineStart: ih.pristineStart, captureInput: ih.captureInput,
      snapAgeMs: ih.snapAgeMs, err: ih.err } : null,
    navigationStart: W.performance && W.performance.timing.navigationStart,
    shellT0: W.__shellT0,
    meta: meta ? { ts: meta.ts, n: meta.n, v: meta.v, age: Date.now() - meta.ts } : null,
    trace: W.__ihScrollTrace || null };
}

export function summarize(samples) {
  const real = samples.find(s => s.ih?.painted && s.ih.skeleton === 0 && s.ih.snapAgeMs >= 0);
  const paintFromNavigationMs = real && real.navigationStart && real.shellT0
    ? real.shellT0 - real.navigationStart + real.ih.paintMs : null;
  const last = samples.at(-1);
  return {
    realSnapshotPaint: !!real,
    paintFromNavigationMs,
    realContentWithin4s: paintFromNavigationMs !== null && paintFromNavigationMs >= 0 && paintFromNavigationMs <= 4000,
    freshMetadata: !!(last?.meta && last.meta.age >= 0 && last.meta.age <= 172800000),
    refreshedDuringRun: samples.some(s => s.ih?.captured === 1),
    finalScrollY: last?.y,
    // Timing instrumentation adds overhead. Confirm timing again without wrappers.
    instrumented: true,
  };
}

async function main() {
  const endpoint = process.env.CDP_HTTP || 'http://127.0.0.1:9371';
  const output = process.env.QA_OUTPUT;
  if (!output) throw Error('QA_OUTPUT must name the output JSON file');
  const pages = await (await fetch(endpoint + '/json', { signal: AbortSignal.timeout(5000) })).json();
  const page = pages.find(p => p.type === 'page');
  if (!page) throw Error('No TV page; launch with SDB and forward its debug port first');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map(), samples = [];
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout')); }, 10000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = e => {
    const m = JSON.parse(e.data), p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(m.id);
    m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
  };
  try {
    for (let i = 0; i < 100; i++) {
      const r = await send('Runtime.evaluate', {
        expression: '(' + installTrace.toString() + ')();(' + sample.toString() + ')()',
        returnByValue: true,
      });
      if (r.exceptionDetails) throw Error('TV evaluation failed: ' + r.exceptionDetails.text);
      if (r.result?.value) samples.push(r.result.value);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally {
    ws.close();
    fs.writeFileSync(output, JSON.stringify({ samples, summary: summarize(samples) }, null, 2));
  }
  console.log(JSON.stringify(summarize(samples)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
