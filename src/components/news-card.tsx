import Link from 'next/link';
import type { DisplayArticle } from '@/lib/article-service';
import { CountryBadge, CategoryBadge, SourceLabel, formatDate } from './news-badges';

export function NewsCard({ article }: { article: DisplayArticle }) {
  return (
    <Link
      href={`/article/${article.id}`}
      className="group block rounded-lg border border-border bg-card p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-gold/30"
    >
      {article.coverImage ? (
        <div className="mb-3 -mx-5 -mt-5 overflow-hidden rounded-t-lg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={article.coverImage}
            referrerPolicy="no-referrer"
            alt=""
            className="h-36 w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        </div>
      ) : null}
      <div className="mb-3 flex items-center gap-2">
        <CountryBadge code={article.country} />
        <CategoryBadge category={article.category} />
      </div>
      <h3 className="mb-2 text-base font-semibold leading-snug text-foreground group-hover:text-lapis transition-colors line-clamp-2">
        {article.title}
      </h3>
      <p className="mb-3 text-sm leading-relaxed text-muted-foreground line-clamp-2">
        {article.summary}
      </p>
      <div className="flex items-center justify-between">
        <SourceLabel source={article.source} />
        <time className="text-xs text-muted-foreground/60">
          {formatDate(article.publishedAt)}
        </time>
      </div>
    </Link>
  );
}

export function FeaturedCard({ article }: { article: DisplayArticle }) {
  return (
    <Link
      href={`/article/${article.id}`}
      className="group block rounded-lg border border-gold/20 bg-card p-6 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-gold/40"
    >
      {article.coverImage ? (
        <div className="mb-4 -mx-6 -mt-6 overflow-hidden rounded-t-lg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={article.coverImage}
            referrerPolicy="no-referrer"
            alt=""
            className="h-44 w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        </div>
      ) : null}
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-flex items-center rounded-sm bg-gold/10 px-1.5 py-0.5 text-xs font-medium text-gold">
          重点
        </span>
        <CountryBadge code={article.country} />
        <CategoryBadge category={article.category} />
      </div>
      <h3 className="mb-3 text-lg font-serif font-semibold leading-snug text-foreground group-hover:text-lapis transition-colors line-clamp-2">
        {article.title}
      </h3>
      <p className="mb-4 text-sm leading-relaxed text-muted-foreground line-clamp-3">
        {article.summary}
      </p>
      <div className="flex items-center justify-between border-t border-border pt-3">
        <SourceLabel source={article.source} />
        <time className="text-xs text-muted-foreground/60">
          {formatDate(article.publishedAt)}
        </time>
      </div>
    </Link>
  );
}
