// Modular-monolith boundary rules, checked from the source tree:
//  1. A feature module never imports another feature module.
//  2. Code outside a module uses only its public index (no deep imports).
//  3. shared never imports a feature module.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

const SRC = resolve(__dirname, '../../src');
const MODULES = readdirSync(join(SRC, 'modules'));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const imports = (file: string) => [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map(m => m[1]).filter(s => s.startsWith('.'));
const owner = (abs: string) => { const rel = relative(SRC, abs).split(/[\\/]/); return rel[0] === 'modules' ? `modules/${rel[1]}` : rel[0]; };

test('feature modules do not import each other, and shared imports no module', () => {
  const violations: string[] = [];
  for (const file of files(SRC)) {
    const from = owner(file);
    for (const spec of imports(file)) {
      const target = resolve(dirname(file), spec);
      const to = owner(target);
      if (from.startsWith('modules/') && to.startsWith('modules/') && from !== to) violations.push(`${relative(SRC, file)} -> ${spec}`);
      if (from === 'shared' && to.startsWith('modules/')) violations.push(`${relative(SRC, file)} -> ${spec}`);
      if (!from.startsWith('modules/') && to.startsWith('modules/') && relative(SRC, target).split(/[\\/]/).length > 2) violations.push(`deep import ${relative(SRC, file)} -> ${spec}`);
    }
  }
  expect(violations).toEqual([]);
});

test('every feature module exposes a public index', () => {
  for (const m of MODULES) expect(statSync(join(SRC, 'modules', m, 'index.ts')).isFile()).toBe(true);
});
