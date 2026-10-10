import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { currentTheme, applyTheme, THEME_STORAGE_KEY } from '../src/renderer/theme.ts';

const boot = readFileSync(new URL('../src/renderer/public/theme-init.js', import.meta.url), 'utf8');
function environment(stored, blocked = false) {
  const classes = new Set(['unrelated-class']);
  let scheme;
  const storage = new Map(stored === undefined ? [] : [[THEME_STORAGE_KEY, stored]]);
  return {
    classes, storage, get scheme() { return scheme; },
    document: {
      documentElement: { classList: {
        contains: name => classes.has(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      } },
      querySelector: selector => {
        assert.equal(selector, 'meta[name="color-scheme"]');
        return { setAttribute: (key, value) => { assert.equal(key, 'content'); scheme = value; } };
      },
    },
    localStorage: {
      getItem: key => { if (blocked) throw new Error('SecurityError'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (blocked) throw new Error('QuotaExceededError'); storage.set(key, value); },
    },
  };
}

for (const stored of [undefined, 'light', 'dark', 'invalid', 'system']) {
  test(`pre-paint bootstrap restores ${stored ?? 'fresh profile'} safely`, () => {
    const env = environment(stored);
    runInNewContext(boot, env);
    assert.equal(env.classes.has('dark'), stored === 'dark');
    assert.equal(env.scheme, stored === 'dark' ? 'dark' : 'light');
    assert.ok(env.classes.has('unrelated-class'));
  });
}
test('bootstrap handles a blocked localStorage getter, without weakening CSP', () => {
  const env = environment();
  Object.defineProperty(env, 'localStorage', { get() { throw new Error('SecurityError'); } });
  runInNewContext(boot, env);
  assert.equal(env.scheme, 'light');
  const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('/theme-init.js') < html.indexOf('/main.tsx'));
  assert.match(html, /script-src 'self';/);
});
for (const blocked of [false, true]) {
  test(`toggle updates class and native color scheme when storage is ${blocked ? 'blocked' : 'available'}`, t => {
    const env = environment(undefined, blocked);
    const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'document', { value: env.document, configurable: true });
    Object.defineProperty(globalThis, 'localStorage', { value: env.localStorage, configurable: true });
    t.after(() => {
      if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument); else delete globalThis.document;
      if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage); else delete globalThis.localStorage;
    });
    assert.equal(currentTheme(), 'light');
    applyTheme('dark');
    assert.equal(currentTheme(), 'dark');
    assert.equal(env.scheme, 'dark');
    if (!blocked) assert.equal(env.storage.get(THEME_STORAGE_KEY), 'dark');
    applyTheme('light');
    assert.equal(currentTheme(), 'light');
    assert.equal(env.scheme, 'light');
    assert.ok(env.classes.has('unrelated-class'));
    if (!blocked) assert.equal(env.storage.get(THEME_STORAGE_KEY), 'light');
  });
}
test('all component and chart colors use defined theme tokens', () => {
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  const chart = readFileSync(new URL('../src/renderer/Analytics.tsx', import.meta.url), 'utf8');
  const studio = readFileSync(new URL('../src/renderer/StudioPanel.tsx', import.meta.url), 'utf8');
  const defined = new Set([...(css + studio).matchAll(/--([\w-]+)['"]?:/g)].map(m => m[1]));
  for (const [, name] of (css + chart).matchAll(/var\(--([\w-]+)\)/g)) assert.ok(defined.has(name), name);
  assert.doesNotMatch(css.slice(css.indexOf('* { box-sizing')), /#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(chart, /#[\da-f]{3,8}\b/i);
  assert.match(css, /--bg-app: #FAF9F5/);
  assert.match(css, /--bg-app: #121214/);
});
