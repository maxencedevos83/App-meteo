// Assemble le site publié : interface (web/), configuration et données générées (out/data/).
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const site = join(root, '_site');
await rm(site, { recursive: true, force: true });
await mkdir(site, { recursive: true });
await cp(join(root, 'web'), site, { recursive: true });
await cp(join(root, 'config.json'), join(site, 'config.json'));
if (existsSync(join(root, 'out', 'data'))) await cp(join(root, 'out', 'data'), join(site, 'data'), { recursive: true });
console.log(`Site prêt dans ${site}`);
