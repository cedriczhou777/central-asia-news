import { notFound } from 'next/navigation';
import Link from 'next/link';
import { countries, countryList } from '@/lib/data/countries';
import { categoryList } from '@/lib/data/categories';
import { getArticlesByCountry } from '@/lib/data/articles';
import type { CountryCode } from '@/lib/data/types';
import { NewsCard } from '@/components/news-card';
import { CountryBadge, CategoryBadge } from '@/components/news-badges';

interface CountryPageProps {
  params: Promise<{ code: string }>;
}

export function generateStaticParams() {
  return countryList.map((c) => ({ code: c.code }));
}

export default async function CountryPage({ params }: CountryPageProps) {
  const { code } = await params;
  const country = countries[code as CountryCode];

  if (!country) {
    notFound();
  }

  const articles = getArticlesByCountry(code);
  const categoryCounts = categoryList
    .map((cat) => ({
      ...cat,
      count: articles.filter((a) => a.category === cat.id).length,
    }))
    .filter((c) => c.count > 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Country Header */}
      <section className="mb-8">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
          <Link href="/" className="hover:text-lapis transition-colors">
            首页
          </Link>
          <span>/</span>
          <span>{country.name}</span>
        </div>
        <div
          className="rounded-lg border bg-card p-6 sm:p-8"
          style={{ borderTopColor: country.color, borderTopWidth: '3px' }}
        >
          <div className="flex items-start justify-between">
            <div>
              <div className="mb-2 flex items-center gap-3">
                <span className="text-4xl">{country.flag}</span>
                <div>
                  <h1 className="text-2xl font-serif font-semibold text-foreground">
                    {country.name}
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    {country.nameEn} · 首都：{country.capital}
                  </p>
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-semibold text-foreground">
                {articles.length}
              </div>
              <div className="text-xs text-muted-foreground">篇资讯</div>
            </div>
          </div>
        </div>
      </section>

      {/* Category Distribution */}
      {categoryCounts.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold text-foreground">
            资讯分布
          </h2>
          <div className="flex flex-wrap gap-2">
            {categoryCounts.map((cat) => (
              <span
                key={cat.id}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs"
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: cat.color }}
                />
                <span className="font-medium text-foreground">{cat.label}</span>
                <span className="text-muted-foreground">{cat.count}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Articles */}
      <section>
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
          <span
            className="inline-block h-4 w-1 rounded-full"
            style={{ backgroundColor: country.color }}
          />
          最新资讯
        </h2>
        {articles.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-12 text-center">
            <p className="text-sm text-muted-foreground">
              暂无该国家的资讯
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {articles.map((article) => (
              <NewsCard key={article.id} article={article} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
