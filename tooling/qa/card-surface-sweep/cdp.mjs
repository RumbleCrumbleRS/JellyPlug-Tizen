// Minimal CDP client (node >=22 global WebSocket, no deps).
export async function attach(port = 9333, urlHint = null) {
  let list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  let t = list.find(x => x.type === 'page' && (!urlHint || x.url.includes(urlHint))) || list.find(x => x.type === 'page');
  if (!t) {
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`);
    list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    t = list.find(x => x.type === 'page');
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method) listeners.forEach(l => l(m));
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const on = fn => listeners.push(fn);
  const evaluate = async (expression, timeout = 120000) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { ws, send, on, evaluate, target: t, close: () => ws.close() };
}
