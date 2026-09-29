import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installTrace, summarize } from './instant-home-scroll-trace.mjs';

const ctx = { window: { pageYOffset: 0 }, Date, Error, Object };
ctx.window.HTMLElement = function () {};
ctx.window.Element = function () {};
Object.defineProperty(ctx.window.Element.prototype, 'scrollTop', {
  configurable: true,
  get() { return ctx.window.pageYOffset; },
  set(y) { ctx.window.pageYOffset = y; },
});
ctx.window.Element.prototype.scrollIntoView = function () { ctx.window.pageYOffset = 300; };
ctx.window.HTMLElement.prototype.focus = function () { ctx.window.pageYOffset = 447; return 42; };
ctx.window.scrollTo = function (x, y) { this.pageYOffset = y; };
vm.runInNewContext('(' + installTrace.toString() + ')()', ctx);
assert.equal(ctx.window.HTMLElement.prototype.focus(), 42);
assert.equal(ctx.window.__ihScrollTrace.events[0].before, 0);
assert.equal(ctx.window.__ihScrollTrace.events[0].after, 447);
assert.equal(ctx.window.__ihScrollTrace.events[0].op, 'focus');
ctx.window.scrollTo(0, 0);
assert.equal(ctx.window.pageYOffset, 0);
assert.equal(ctx.window.__ihScrollTrace.events[1].op, 'scrollTo');
const element = new ctx.window.Element();
element.scrollTop = 100;
assert.equal(element.scrollTop, 100, 'native getter/setter semantics preserved');
assert.equal(ctx.window.__ihScrollTrace.events[2].op, 'scrollTop');
element.scrollIntoView();
assert.equal(ctx.window.__ihScrollTrace.events[3].after, 300);
const installed = ctx.window.HTMLElement.prototype.focus;
vm.runInNewContext('(' + installTrace.toString() + ')()', ctx);
assert.equal(ctx.window.HTMLElement.prototype.focus, installed, 'repeated sample must not stack wrappers');
for (let i = 0; i < 200; i++) ctx.window.scrollTo(0, i);
assert.equal(ctx.window.__ihScrollTrace.events.length, 160, 'bounded trace on animation-heavy home');
assert.equal(ctx.window.pageYOffset, 199, 'native scrolling continues after trace cap');
const current = { navigationStart: 1000, shellT0: 2000, y: 0,
  meta: { age: 200 }, ih: { painted: 1, skeleton: 1, snapAgeMs: -1, paintMs: 100 } };
assert.equal(summarize([current]).realContentWithin4s, false);
assert.equal(summarize([current]).realSnapshotPaint, false);
current.ih.skeleton = 0; current.ih.snapAgeMs = 200;
assert.equal(summarize([current]).realContentWithin4s, true);
current.ih.paintMs = 3500;
assert.equal(summarize([current]).realContentWithin4s, false);
assert.equal(summarize([current]).refreshedDuringRun, false);
console.log('PASS: scroll trace preserves calls; skeleton excluded; navigation clock used');
