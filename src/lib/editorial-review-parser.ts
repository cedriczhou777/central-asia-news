export interface EditorialIdentity {
  articleId?: string | number;
  sourceUrl?: string;
}
export interface EditorialReplace extends EditorialIdentity {
  no: number;
  matchTitle: string;
  title: string;
  summary: string;
  content: string;
  source: string;
  evidenceUrls: string[];
}
export interface EditorialDrop extends EditorialIdentity { no: number; matchTitle: string }
export interface EditorialCountry { replace: EditorialReplace[]; drop: EditorialDrop[] }
export interface EditorialReviewSet {
  schemaVersion: 2;
  reviewDate: string;
  generatedAt: string;
  source: string;
  countries: Record<string, EditorialCountry>;
  unparsed: Array<{ country: string; no: number; title: string }>;
}
const COUNTRIES: Record<string, string> = { 哈萨克斯坦: 'kz', 乌兹别克斯坦: 'uz', 吉尔吉斯斯坦: 'kg', 塔吉克斯坦: 'tj', 阿塞拜疆: 'az' };

/** Convert review instructions without executing them or guessing a missing batch date. */
export function parseEditorialReview(raw: string, source: string, generatedAt: string): EditorialReviewSet {
  const heading = raw.match(/^#\s+(.+)$/m)?.[1] || '';
  const date = heading.match(/202\d年\s*\d{1,2}月\s*\d{1,2}日|202\d-\d{2}-\d{2}/);
  if (!date) throw new Error('审稿文件缺少明确日期，不能生成无批次的覆盖清单');
  const [year, month, day] = date[0].match(/\d+/g)!;
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsedDate = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== iso) throw new Error('审稿日期不是有效日历日期');
  const result: EditorialReviewSet = { schemaVersion: 2, reviewDate: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`, generatedAt, source, countries: {}, unparsed: [] };
  let country = '';
  let category = '';
  let current: { no: number; title: string; lines: string[] } | null = null;
  const flush = () => {
    if (!current || !country) { current = null; return; }
    const bucket = result.countries[country] ??= { replace: [], drop: [] };
    const lines = current.lines;
    const quoted = lines.filter((line) => line.startsWith('>')).map((line) => line.replace(/^>\s?/, '').trim());
    while (quoted.length && !quoted[quoted.length - 1]) quoted.pop();
    while (quoted.length && !quoted[0]) quoted.shift();
    const opinion = lines.filter((line) => !line.startsWith('>')).join('\n');
    const positive = opinion.replace(/不(?:建议|应|要|得)?删除[^。；\n]*/g, '');
    if (quoted.filter(Boolean).length >= 2) {
      const title = quoted.shift()!;
      let attribution = '';
      if (/^来源[:：]/.test(quoted[quoted.length - 1] || '')) attribution = quoted.pop()!.replace(/^来源[:：]\s*/, '').trim();
      const content = quoted.join('\n').trim();
      bucket.replace.push({ no: current.no, matchTitle: current.title, title, summary: content, content, source: attribution, evidenceUrls: [...opinion.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]) });
    } else if (/(?:建议删除|删除(?:本条|该条|此条|，|。|并入)|本条(?:建议)?删除)/.test(positive)) {
      bucket.drop.push({ no: current.no, matchTitle: current.title });
    } else if (category !== '可以不改') result.unparsed.push({ country, no: current.no, title: current.title });
    current = null;
  };
  for (const line of raw.split('\n')) {
    const h2 = line.match(/^##\s+(.+?)｜/);
    const h3 = line.match(/^###\s+(.+)/);
    const h4 = line.match(/^####\s+原文第\s*(\d+)\s*条[｜|]\s*(.+)$/);
    if (h2 || h3 || h4) flush();
    if (h2) country = COUNTRIES[h2[1]] || '';
    if (h3) category = h3[1].trim();
    if (h4) current = { no: Number(h4[1]), title: h4[2].trim(), lines: [] };
    else if (current) current.lines.push(line);
  }
  flush();
  return result;
}
