// 依 src/source/manifest.ts 從 kernel-src/ 抽出片段，寫到 src/source/snippets.json。
// 用法：npm run extract-snippets（要先 npm run fetch-kernel-src）
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnippets } from '../src/source/build.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src/source/snippets.json');
const data = buildSnippets((tag, file) => readFileSync(join(root, 'kernel-src', tag, file), 'utf8'));
writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
console.log(`${Object.keys(data.snippets).length} snippets -> ${out}`);
