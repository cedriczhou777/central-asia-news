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
  // 哈萨克斯坦
  | 'kazinform'
  | 'tengrinews'
  | 'zakon_kz'
  | 'nur_kz'
  | 'inbusiness_kz'
  | 'astana_times'
  | 'forbes_kz'
  | 'egemen_qazaqstan'
  | 'kazpravda_kz'
  | 'dknews_kz'
  | 'newtimes_kz'
  | 'channel_24_kz'
  | 'khabar_kz'
  // 乌兹别克斯坦
  | 'uza_uz'
  | 'kun_uz'
  | 'daryo_uz'
  | 'gazeta_uz'
  | 'spot_uz'
  | 'repost_uz'
  | 'anhor_uz'
  | 'uznews_uz'
  // 吉尔吉斯斯坦
  | 'kabar_kg'
  | 'akipress'
  | 'channel_24_kg'
  | 'kaktus_media'
  | 'super_kg'
  | 'azattyk_kg'
  // 塔吉克斯坦
  | 'khovar_tj'
  | 'asia_plus_tj'
  | 'avesta_tj'
  // 土库曼斯坦
  | 'tdh_tm'
  | 'turkmenportal'
  // 区域综合媒体
  | 'times_central_asia'
  | 'eurasianet'
  | 'rferl_central_asia'
  // 国际媒体
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
