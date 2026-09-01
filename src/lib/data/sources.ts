import type { NewsSource, SourceInfo } from './types';

export const sources: Record<NewsSource, SourceInfo> = {
  kazinform: {
    id: 'kazinform',
    name: 'Kazinform',
    country: 'kz',
    type: 'official',
  },
  dawn_kz: {
    id: 'dawn_kz',
    name: 'Dawn Kazakhstan',
    country: 'kz',
    type: 'media',
  },
  uzdaily: {
    id: 'uzdaily',
    name: 'UzDaily',
    country: 'uz',
    type: 'media',
  },
  kun_uz: {
    id: 'kun_uz',
    name: 'Kun.uz',
    country: 'uz',
    type: 'media',
  },
  akipress: {
    id: 'akipress',
    name: 'AKIpress',
    country: 'kg',
    type: 'media',
  },
  turkmenistan_golden_age: {
    id: 'turkmenistan_golden_age',
    name: 'Turkmenistan Golden Age',
    country: 'tm',
    type: 'official',
  },
  khovar_tj: {
    id: 'khovar_tj',
    name: 'Khovar',
    country: 'tj',
    type: 'official',
  },
  reuters: {
    id: 'reuters',
    name: 'Reuters',
    country: 'intl',
    type: 'media',
  },
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    country: 'intl',
    type: 'social',
  },
};

export const sourceList = Object.values(sources);
