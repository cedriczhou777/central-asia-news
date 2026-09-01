import { countries } from '@/lib/data/countries';
import { categories } from '@/lib/data/categories';
import { sources } from '@/lib/data/sources';
import type { CountryCode, Category, NewsSource } from '@/lib/data/types';

export function CountryBadge({ code }: { code: CountryCode }) {
  const country = countries[code];
  if (!country) return <span className="text-xs text-muted-foreground">{code}</span>;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs font-medium"
      style={{
        backgroundColor: `${country.color}15`,
        color: country.color,
        borderLeft: `2px solid ${country.color}`,
      }}
    >
      {country.flag} {country.name}
    </span>
  );
}

export function CategoryBadge({ category }: { category: Category }) {
  const cat = categories[category as Category];
  if (!cat) return <span className="text-xs text-muted-foreground">{category}</span>;
  return (
    <span
      className="inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-medium"
      style={{
        backgroundColor: `${cat.color}12`,
        color: cat.color,
      }}
    >
      {cat.label}
    </span>
  );
}

export function SourceLabel({ source }: { source: string }) {
  const knownSource = sources[source as NewsSource];
  if (knownSource) {
    const typeLabel =
      knownSource.type === 'official'
        ? '官方媒体'
        : knownSource.type === 'social'
          ? '社交媒体'
          : '新闻媒体';
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-gold/60" />
        {knownSource.name}
        <span className="text-muted-foreground/50">· {typeLabel}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-gold/60" />
      {source}
    </span>
  );
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 1) return '刚刚';
  if (diffHours < 24) return `${diffHours}小时前`;
  if (diffDays < 7) return `${diffDays}天前`;
  return date.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
  });
}
