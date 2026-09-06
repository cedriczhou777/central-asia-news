import type { NewsSource, SourceInfo } from './types';

export const sources: Record<NewsSource, SourceInfo> = {
  // ========== 哈萨克斯坦 ==========
  kazinform: {
    id: 'kazinform',
    name: 'Kazinform',
    country: 'kz',
    type: 'official',
  },
  tengrinews: {
    id: 'tengrinews',
    name: 'Tengrinews',
    country: 'kz',
    type: 'media',
  },
  zakon_kz: {
    id: 'zakon_kz',
    name: 'Zakon.kz',
    country: 'kz',
    type: 'media',
  },
  nur_kz: {
    id: 'nur_kz',
    name: 'Nur.kz',
    country: 'kz',
    type: 'media',
  },
  inbusiness_kz: {
    id: 'inbusiness_kz',
    name: 'Inbusiness.kz',
    country: 'kz',
    type: 'media',
  },
  astana_times: {
    id: 'astana_times',
    name: 'The Astana Times',
    country: 'kz',
    type: 'media',
  },
  forbes_kz: {
    id: 'forbes_kz',
    name: 'Forbes.kz',
    country: 'kz',
    type: 'media',
  },
  egemen_qazaqstan: {
    id: 'egemen_qazaqstan',
    name: 'Egemen Qazaqstan',
    country: 'kz',
    type: 'official',
  },
  kazpravda_kz: {
    id: 'kazpravda_kz',
    name: 'Kazakhstanskaya Pravda',
    country: 'kz',
    type: 'official',
  },
  dknews_kz: {
    id: 'dknews_kz',
    name: 'DKNews.kz',
    country: 'kz',
    type: 'media',
  },
  newtimes_kz: {
    id: 'newtimes_kz',
    name: 'Newtimes.kz',
    country: 'kz',
    type: 'media',
  },
  channel_24_kz: {
    id: 'channel_24_kz',
    name: '24.kz',
    country: 'kz',
    type: 'media',
  },
  khabar_kz: {
    id: 'khabar_kz',
    name: 'Khabar',
    country: 'kz',
    type: 'media',
  },

  // ========== 乌兹别克斯坦 ==========
  uza_uz: {
    id: 'uza_uz',
    name: 'UzA',
    country: 'uz',
    type: 'official',
  },
  kun_uz: {
    id: 'kun_uz',
    name: 'Kun.uz',
    country: 'uz',
    type: 'media',
  },
  daryo_uz: {
    id: 'daryo_uz',
    name: 'Daryo.uz',
    country: 'uz',
    type: 'media',
  },
  gazeta_uz: {
    id: 'gazeta_uz',
    name: 'Gazeta.uz',
    country: 'uz',
    type: 'media',
  },
  spot_uz: {
    id: 'spot_uz',
    name: 'Spot.uz',
    country: 'uz',
    type: 'media',
  },
  repost_uz: {
    id: 'repost_uz',
    name: 'Repost.uz',
    country: 'uz',
    type: 'media',
  },
  anhor_uz: {
    id: 'anhor_uz',
    name: 'Anhor.uz',
    country: 'uz',
    type: 'media',
  },
  uznews_uz: {
    id: 'uznews_uz',
    name: 'Uznews.uz',
    country: 'uz',
    type: 'media',
  },

  // ========== 吉尔吉斯斯坦 ==========
  kabar_kg: {
    id: 'kabar_kg',
    name: 'Kabar',
    country: 'kg',
    type: 'official',
  },
  akipress: {
    id: 'akipress',
    name: 'AKIpress',
    country: 'kg',
    type: 'media',
  },
  channel_24_kg: {
    id: 'channel_24_kg',
    name: '24.kg',
    country: 'kg',
    type: 'media',
  },
  kaktus_media: {
    id: 'kaktus_media',
    name: 'Kaktus.media',
    country: 'kg',
    type: 'media',
  },
  super_kg: {
    id: 'super_kg',
    name: 'Super.kg',
    country: 'kg',
    type: 'media',
  },
  azattyk_kg: {
    id: 'azattyk_kg',
    name: 'Azattyk',
    country: 'kg',
    type: 'media',
  },

  // ========== 塔吉克斯坦 ==========
  khovar_tj: {
    id: 'khovar_tj',
    name: 'Khovar',
    country: 'tj',
    type: 'official',
  },
  asia_plus_tj: {
    id: 'asia_plus_tj',
    name: 'Asia-Plus',
    country: 'tj',
    type: 'media',
  },
  avesta_tj: {
    id: 'avesta_tj',
    name: 'Avesta',
    country: 'tj',
    type: 'media',
  },

  // ========== 土库曼斯坦 ==========
  tdh_tm: {
    id: 'tdh_tm',
    name: 'TDH',
    country: 'tm',
    type: 'official',
  },
  turkmenportal: {
    id: 'turkmenportal',
    name: 'Turkmenportal',
    country: 'tm',
    type: 'media',
  },

  // ========== 区域综合媒体 ==========
  times_central_asia: {
    id: 'times_central_asia',
    name: 'The Times of Central Asia',
    country: 'intl',
    type: 'media',
  },
  eurasianet: {
    id: 'eurasianet',
    name: 'Eurasianet',
    country: 'intl',
    type: 'media',
  },
  rferl_central_asia: {
    id: 'rferl_central_asia',
    name: 'RFE/RL Central Asia',
    country: 'intl',
    type: 'media',
  },

  // ========== 国际媒体 ==========
  reuters: {
    id: 'reuters',
    name: 'Reuters',
    country: 'intl',
    type: 'media',
  },
};

export const sourceList = Object.values(sources);
