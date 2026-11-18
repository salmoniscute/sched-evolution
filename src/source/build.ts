// manifest → snippets.json 的內容。讀檔方式由呼叫者提供（腳本與測試共用）。
import { extractSnippet, type Snippet } from './extract.ts';
import { manifest } from './manifest.ts';

export interface SnippetFile {
  /** 提醒：這個檔案是產生出來的 */
  generated: string;
  snippets: Record<string, Snippet>;
}

export function buildSnippets(read: (tag: string, file: string) => string): SnippetFile {
  const snippets: Record<string, Snippet> = {};
  for (const spec of manifest) {
    if (snippets[spec.id]) throw new Error(`重複的 id：${spec.id}`);
    snippets[spec.id] = extractSnippet(spec, read(spec.tag, spec.file));
  }
  return { generated: 'scripts/extract-snippets.ts — 不要手動修改', snippets };
}
