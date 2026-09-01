'use client';

import { useState } from 'react';
import { countryList } from '@/lib/data/countries';
import { categoryList } from '@/lib/data/categories';
import { getArticles, getFeaturedArticles } from '@/lib/data/articles';
import type { Category, CountryCode } from '@/lib/data/types';
import { CountryCard } from '@/components/country-card';
import { NewsCard, FeaturedCard } from '@/components/news-card';

export default function HomePage() {
  const [selectedCountry, setSelectedCountry] = useState<CountryCode | ''>('');
  const [selectedCategory, setSelectedCategory] = useState<Category | ''>('');

  const featured = getFeaturedArticles().slice(0, 5);
  const articles = getArticles({
    country: selectedCountry || undefined,
    category: selectedCategory || undefined,
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Hero Section */}
      <section className="mb-8">
        <div className="rounded-lg bg-navy p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-xl font-serif font-semibold text-parchment sm:text-2xl">
                中亚五国投资资讯日报
              </h1>
              <p className="mt-1 text-sm text-parchment/60">
                覆盖哈萨克斯坦、乌兹别克斯坦、吉尔吉斯斯坦、土库曼斯坦、塔吉克斯坦
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-md bg-gold/20 px-3 py-1.5 text-xs font-medium text-gold">
                今日更新 {articles.length} 篇
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Country Overview */}
      <section className="mb-8">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="inline-block h-4 w-1 rounded-full bg-gold" />
          国家概览
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {countryList.map((c) => (
            <CountryCard key={c.code} code={c.code} />
          ))}
        </div>
      </section>

      {/* Featured News */}
      <section className="mb-8">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="inline-block h-4 w-1 rounded-full bg-gold" />
          重点关注
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {featured.slice(0, 3).map((article) => (
            <FeaturedCard key={article.id} article={article} />
          ))}
        </div>
      </section>

      {/* Filters */}
      <section className="mb-6">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="inline-block h-4 w-1 rounded-full bg-gold" />
          全部资讯
        </h2>
        <div className="flex flex-wrap gap-4">
          {/* Country filter */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">国家：</span>
            <button
              onClick={() => setSelectedCountry('')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                selectedCountry === ''
                  ? 'bg-navy text-parchment'
                  : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
              }`}
            >
              全部
            </button>
            {countryList.map((c) => (
              <button
                key={c.code}
                onClick={() =>
                  setSelectedCountry(selectedCountry === c.code ? '' : c.code)
                }
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  selectedCountry === c.code
                    ? 'text-parchment'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                }`}
                style={
                  selectedCountry === c.code
                    ? { backgroundColor: c.color }
                    : undefined
                }
              >
                {c.flag} {c.name}
              </button>
            ))}
          </div>
          {/* Category filter */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">领域：</span>
            <button
              onClick={() => setSelectedCategory('')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                selectedCategory === ''
                  ? 'bg-navy text-parchment'
                  : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
              }`}
            >
              全部
            </button>
            {categoryList.map((cat) => (
              <button
                key={cat.id}
                onClick={() =>
                  setSelectedCategory(
                    selectedCategory === cat.id ? '' : cat.id
                  )
                }
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  selectedCategory === cat.id
                    ? 'text-white'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                }`}
                style={
                  selectedCategory === cat.id
                    ? { backgroundColor: cat.color }
                    : undefined
                }
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* News Grid */}
      <section>
        {articles.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-12 text-center">
            <p className="text-sm text-muted-foreground">
              暂无符合条件的资讯
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
