import fs from 'node:fs';

const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const fail = (message) => { throw new Error(message); };

// Desktop stack: home, mute, book. Each starts at least 44px apart.
for (const value of [
  'top: max(10px, env(safe-area-inset-top));',
  'top: calc(max(10px, env(safe-area-inset-top)) + 48px);',
  'top: calc(max(10px, env(safe-area-inset-top)) + 104px);',
]) if (!css.includes(value)) fail(`missing desktop control offset ${value}`);

const landscapeStart = css.indexOf('@media (pointer: coarse) and (orientation: landscape)');
const landscapeEnd = css.indexOf('/* =========================================================', landscapeStart + 1);
const landscape = css.slice(landscapeStart, landscapeEnd);
if (!landscape.includes('top: max(10px, env(safe-area-inset-top));')) fail('landscape book is not top anchored');
if (!landscape.includes('top: calc(max(10px, env(safe-area-inset-top)) + 48px);')) fail('landscape mute is not stacked');
if (!landscape.includes('.game-home-menu { top: calc(max(10px, env(safe-area-inset-top)) + 96px); }')) fail('landscape site control is not stacked');
if (!/\.daemon-key\s*\{[\s\S]*?min-height:\s*44px/.test(landscape)) fail('landscape touch target regressed');
console.log('controls geometry: desktop + coarse landscape stack, 44px touch target');
