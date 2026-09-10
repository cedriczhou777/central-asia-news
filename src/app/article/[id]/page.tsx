import { notFound } from 'next/navigation';
import Link from 'next/link';
import { fetchDisplayArticleById, fetchDisplayArticles } from '@/lib/article-service';
import { countries } from '@/lib/data/countries';
import { categories } from '@/lib/data/categories';
import { CountryBadge, CategoryBadge, formatDate } from '@/components/news-badges';
import { NewsCard } from '@/components/news-card';

interface ArticlePageProps {
  params: Promise<{ id: string }>;
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { id } = await params;
  const article = await fetchDisplayArticleById(id);

  if (!article) {
    notFound();
  }

  const country = countries[article.country as keyof typeof countries];
  const category = categories[article.category as keyof typeof categories];

  const relatedArticles = (await fetchDisplayArticles({
    country: article.country,
    limit: 4,
  }))
    .filter((a) => a.id !== article.id)
    .slice(0, 3);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Breadcrumb */}
      <div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/" className="hover:text-lapis transition-colors">
          首页
        </Link>
        <span>/</span>
        <Link
          href={`/countries/${article.country}`}
          className="hover:text-lapis transition-colors"
        >
          {country?.name || article.country}
        </Link>
        <span>/</span>
        <span className="text-foreground/70 truncate max-w-[200px]">
          {article.title}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
        {/* Article Content */}
        <article className="lg:col-span-2">
          {/* Category & Country */}
          <div className="mb-4 flex items-center gap-2">
            <CountryBadge code={article.country as 'kz' | 'uz' | 'kg' | 'tm' | 'tj'} />
            <CategoryBadge category={article.category} />
          </div>

          {/* Title */}
          <h1 className="font-serif text-3xl font-bold text-foreground leading-tight mb-4">
            {article.title}
          </h1>

          {/* Meta */}
          <div className="mb-6 flex items-center gap-4 text-sm text-muted-foreground border-b border-border/40 pb-6">
            <span className="flex items-center gap-1.5">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
              </svg>
              {formatDate(article.publishedAt)}
            </span>
            <span className="flex items-center gap-1.5">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 01-2.25 2.25M16.5 7.5V18a2.25 2.25 0 002.25 2.25M16.5 7.5V4.875c0-.621-.504-1.125-1.125-1.125H4.125C3.504 3.75 3 4.254 3 4.875V18a2.25 2.25 0 002.25 2.25h13.5" />
              </svg>
              {article.source}
            </span>
          </div>

          {/* Cover Image */}
          {article.coverImage ? (
            <div className="mb-6 overflow-hidden rounded-lg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={article.coverImage}
                referrerPolicy="no-referrer"
                alt=""
                className="w-full max-h-96 object-cover"
              />
            </div>
          ) : null}

          {/* Summary */}
          <div className="mb-6 rounded-lg border border-gold/20 bg-gold/5 p-4">
            <p className="text-sm text-foreground/80 leading-relaxed">
              <span className="font-semibold text-gold-dark">摘要：</span>
              {article.summary}
            </p>
          </div>

          {/* Content */}
          <div className="prose prose-lg max-w-none">
            <p className="text-foreground/90 leading-relaxed whitespace-pre-line">
              {article.content}
            </p>
          </div>

          {/* Source Link */}
          {article.sourceUrl && (
            <div className="mt-8 pt-6 border-t border-border/40">
              <a
                href={article.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm text-lapis hover:text-gold transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
                查看原文
              </a>
            </div>
          )}
        </article>

        {/* Sidebar */}
        <aside className="space-y-6">
          {/* Source Info */}
          <div className="rounded-lg border border-border/60 bg-card p-4">
            <h3 className="font-serif text-sm font-semibold text-foreground mb-3 pb-2 border-b border-border/40">
              来源信息
            </h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">媒体：</span>
                <span className="text-foreground">{article.source}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">国家：</span>
                <span className="text-foreground">{country?.name || article.country}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">分类：</span>
                <span className="text-foreground">{category?.label || article.category}</span>
              </div>
            </div>
          </div>

          {/* Related Articles */}
          {relatedArticles.length > 0 && (
            <div className="rounded-lg border border-border/60 bg-card p-4">
              <h3 className="font-serif text-sm font-semibold text-foreground mb-3 pb-2 border-b border-border/40">
                相关新闻
              </h3>
              <div className="space-y-3">
                {relatedArticles.map((related) => (
                  <NewsCard key={related.id} article={related} />
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
