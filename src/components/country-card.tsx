import Link from 'next/link';
import { countries } from '@/lib/data/countries';
import type { CountryCode } from '@/lib/data/types';
import { getArticlesByCountry } from '@/lib/data/articles';

const countryDescriptions: Record<CountryCode, string> = {
  kz: '中亚最大经济体，油气资源丰富',
  uz: '人口最多，改革开放力度最大',
  kg: '矿产资源丰富，投资门槛较低',
  tm: '天然气储量世界第四',
  tj: '水电潜力巨大，劳动力成本低',
};

export function CountryCard({ code }: { code: CountryCode }) {
  const country = countries[code];
  let articleCount = 0;
  try {
    articleCount = getArticlesByCountry(code).length;
  } catch {
    // mock data fallback
  }

  return (
    <Link
      href={`/countries/${code}`}
      className="group relative overflow-hidden rounded-lg border border-border bg-card p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
      style={{ borderTopColor: country.color, borderTopWidth: '3px' }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-2xl">{country.flag}</span>
        <span
          className="rounded-full px-2 py-0.5 text-xs font-medium"
          style={{
            backgroundColor: `${country.color}12`,
            color: country.color,
          }}
        >
          {articleCount > 0 ? `${articleCount} 篇` : '—'}
        </span>
      </div>
      <h3 className="mb-1 text-sm font-semibold text-foreground">
        {country.name}
      </h3>
      <p className="text-xs text-muted-foreground">
        {countryDescriptions[code]}
      </p>
      <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground/60">
        <span>首都：{country.capital}</span>
      </div>
    </Link>
  );
}
