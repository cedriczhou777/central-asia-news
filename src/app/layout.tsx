import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: '中亚投资资讯 - 中亚五国商业新闻聚合平台',
  description:
    '面向中国投资者的中亚五国新闻聚合平台，覆盖哈萨克斯坦、乌兹别克斯坦、吉尔吉斯斯坦、土库曼斯坦、塔吉克斯坦的政治、经济、政策、工商税法等投资相关信息。',
  keywords: [
    '中亚投资',
    '哈萨克斯坦',
    '乌兹别克斯坦',
    '吉尔吉斯斯坦',
    '土库曼斯坦',
    '塔吉克斯坦',
    '中亚新闻',
    '海外投资',
    '能源投资',
    '矿业投资',
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">
        <div className="flex min-h-screen flex-col">
          <header className="sticky top-0 z-50 border-b border-border bg-navy text-parchment shadow-sm">
            <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
              <Link href="/" className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-gold text-navy font-bold text-lg">
                  亚
                </div>
                <div className="flex flex-col">
                  <span className="text-base font-semibold tracking-tight leading-tight">
                    中亚投资资讯
                  </span>
                  <span className="text-xs text-gold/80 leading-tight">
                    Central Asia Investment Daily
                  </span>
                </div>
              </Link>
              <nav className="hidden items-center gap-6 md:flex">
                <Link
                  href="/"
                  className="text-sm text-parchment/80 transition-colors hover:text-gold"
                >
                  首页
                </Link>
                <Link
                  href="/countries/kz"
                  className="text-sm text-parchment/80 transition-colors hover:text-gold"
                >
                  哈萨克斯坦
                </Link>
                <Link
                  href="/countries/uz"
                  className="text-sm text-parchment/80 transition-colors hover:text-gold"
                >
                  乌兹别克斯坦
                </Link>
                <Link
                  href="/countries/kg"
                  className="text-sm text-parchment/80 transition-colors hover:text-gold"
                >
                  吉尔吉斯斯坦
                </Link>
                <Link
                  href="/countries/tm"
                  className="text-sm text-parchment/80 transition-colors hover:text-gold"
                >
                  土库曼斯坦
                </Link>
                <Link
                  href="/countries/tj"
                  className="text-sm text-parchment/80 transition-colors hover:text-gold"
                >
                  塔吉克斯坦
                </Link>
              </nav>
              <div className="flex items-center gap-2">
                <div className="hidden rounded-md border border-gold/30 bg-navy-light px-3 py-1.5 text-xs text-parchment/60 sm:block">
                  每日更新
                </div>
              </div>
            </div>
          </header>
          <main className="flex-1">{children}</main>
          <footer className="border-t border-border bg-navy text-parchment/60">
            <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
              <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded bg-gold/20 text-gold text-xs font-bold">
                    亚
                  </div>
                  <span className="text-sm text-parchment/80">
                    中亚投资资讯
                  </span>
                </div>
                <p className="text-xs text-parchment/40">
                  面向中国投资者的中亚五国商业新闻聚合平台
                </p>
              </div>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
