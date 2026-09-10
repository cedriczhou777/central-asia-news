import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '中亚投资资讯',
  description: '面向中国投资者的中亚五国商业新闻聚合平台，通过微信公众号推送每日投资资讯。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}