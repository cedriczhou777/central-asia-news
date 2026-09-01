import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getArticleById, getArticles } from '@/lib/data/articles';
import { countries } from '@/lib/data/countries';
import { categories } from '@/lib/data/categories';
import { sources } from '@/lib/data/sources';
import { CountryBadge, CategoryBadge, SourceLabel, formatDate } from '@/components/news-badges';
import { NewsCard } from '@/components/news-card';

interface ArticlePageProps {
  params: Promise<{ id: string }>;
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { id } = await params;
  const article = getArticleById(id);

  if (!article) {
    notFound();
  }

  const country = countries[article.country];
  const category = categories[article.category];
  const source = sources[article.source];

  const relatedArticles = getArticles({
    country: article.country,
  })
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
          {country.name}
        </Link>
        <span>/</span>
        <span className="text-foreground">文章详情</span>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Main Content */}
        <article className="lg:col-span-2">
          {/* Article Header */}
          <div className="mb-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <CountryBadge code={article.country} />
              <CategoryBadge category={article.category} />
              {article.isFeatured && (
                <span className="inline-flex items-center rounded-sm bg-gold/10 px-1.5 py-0.5 text-xs font-medium text-gold">
                  重点
                </span>
              )}
            </div>
            <h1 className="mb-4 text-2xl font-serif font-semibold leading-tight text-foreground sm:text-3xl">
              {article.title}
            </h1>
            <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <SourceLabel source={article.source} />
              <time>{formatDate(article.publishedAt)}</time>
            </div>
          </div>

          {/* Article Summary */}
          <div className="mb-6 rounded-lg border-l-3 border-gold bg-gold/5 p-4">
            <p className="text-sm font-medium leading-relaxed text-foreground">
              {article.summary}
            </p>
          </div>

          {/* Article Content */}
          <div className="prose prose-sm max-w-none">
            {article.content.split('\n\n').map((paragraph, i) => (
              <p
                key={i}
                className="mb-4 text-sm leading-relaxed text-foreground/90"
              >
                {paragraph}
              </p>
            ))}
          </div>

          {/* Tags */}
          {article.tags.length > 0 && (
            <div className="mt-8 border-t border-border pt-6">
              <h3 className="mb-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                相关标签
              </h3>
              <div className="flex flex-wrap gap-2">
                {article.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-md bg-secondary px-2.5 py-1 text-xs text-secondary-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </article>

        {/* Sidebar */}
        <aside className="lg:col-span-1">
          {/* Source Info */}
          <div className="mb-6 rounded-lg border border-border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              信息来源
            </h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">
                  {source.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {source.type === 'official'
                    ? '官方媒体'
                    : source.type === 'social'
                      ? '社交媒体'
                      : '新闻媒体'}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                发布时间：
                {new Date(article.publishedAt).toLocaleDateString('zh-CN', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            </div>
          </div>

          {/* Country Info */}
          <div className="mb-6 rounded-lg border border-border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              所在国家
            </h3>
            <div className="flex items-center gap-3">
              <span className="text-3xl">{country.flag}</span>
              <div>
                <div className="text-sm font-semibold text-foreground">
                  {country.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {country.nameEn}
                </div>
              </div>
            </div>
            <Link
              href={`/countries/${country.code}`}
              className="mt-3 block text-center rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80"
            >
              查看更多 {country.name} 资讯
            </Link>
          </div>

          {/* Related Articles */}
          {relatedArticles.length > 0 && (
            <div>
              <h3 className="mb-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                相关资讯
              </h3>
              <div className="space-y-3">
                {relatedArticles.map((a) => (
                  <Link
                    key={a.id}
                    href={`/article/${a.id}`}
                    className="block rounded-lg border border-border bg-card p-3 transition-colors hover:border-gold/30"
                  >
                    <h4 className="mb-1 text-xs font-medium text-foreground line-clamp-2">
                      {a.title}
                    </h4>
                    <time className="text-xs text-muted-foreground/60">
                      {formatDate(a.publishedAt)}
                    </time>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
