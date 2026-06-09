// Minimal Chrome DevTools Protocol client over the Node built-in WebSocket
// (Node 22+). No npm deps. Used by dpad-test.mjs to drive a headless
// Chrome-for-Testing instance launched by bootstrap-chromium.sh.
//
// JEL-33: browser-side verification of D-pad navigation + the shell's
// body-focus rescue mechanism.

const CDP_BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';

export async function connectPage() {
  const list = await (await fetch(CDP_BASE + '/json')).json();
  let page = list.find((t) => t.type === 'page');
  if (!page) page = await (await fetch(CDP_BASE + '/json/new?about:blank')).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error
        ? rej(new Error(m.error.message + ' :: ' + JSON.stringify(m.error.data || '')))
        : res(m.result);
    } else if (m.method) {
      for (const l of listeners) l(m);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const on = (fn) => listeners.push(fn);
  return { send, on, ws };
}

export async function evalExpr(cdp, expression, awaitPromise = true) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (r.exceptionDetails)
    throw new Error(
      'eval exc: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text),
    );
  return r.result.value;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
