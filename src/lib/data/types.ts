export type CountryCode = 'kz' | 'uz' | 'kg' | 'tm' | 'tj';

export interface Country {
  code: CountryCode;
  name: string;
  nameEn: string;
  capital: string;
  color: string;
  flag: string;
}

export type Category =
  | 'politics'
  | 'economy'
  | 'policy'
  | 'business_law'
  | 'energy'
  | 'chemicals'
  | 'minerals'
  | 'infrastructure'
  | 'real_estate'
  | 'manufacturing';

export interface CategoryInfo {
  id: Category;
  label: string;
  color: string;
}

export type NewsSource =
  | 'kazinform'
  | 'dawn_kz'
  | 'uzdaily'
  | 'kun_uz'
  | 'akipress'
  | 'turkmenistan_golden_age'
  | 'khovar_tj'
  | 'reuters'
  | 'instagram';

export interface SourceInfo {
  id: NewsSource;
  name: string;
  country: CountryCode | 'intl';
  type: 'official' | 'media' | 'social';
}

export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  content: string;
  country: CountryCode;
  category: Category;
  source: NewsSource;
  sourceUrl: string;
  publishedAt: string;
  tags: string[];
  isFeatured?: boolean;
}
