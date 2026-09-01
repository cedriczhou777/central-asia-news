import type { Category, CategoryInfo } from './types';

export const categories: Record<Category, CategoryInfo> = {
  politics: {
    id: 'politics',
    label: '政治',
    color: '#6366F1',
  },
  economy: {
    id: 'economy',
    label: '经济',
    color: '#059669',
  },
  policy: {
    id: 'policy',
    label: '政策',
    color: '#D97706',
  },
  business_law: {
    id: 'business_law',
    label: '工商税法',
    color: '#7C3AED',
  },
  energy: {
    id: 'energy',
    label: '能源',
    color: '#DC2626',
  },
  chemicals: {
    id: 'chemicals',
    label: '化工',
    color: '#2563EB',
  },
  minerals: {
    id: 'minerals',
    label: '矿产',
    color: '#92400E',
  },
  infrastructure: {
    id: 'infrastructure',
    label: '基建',
    color: '#0891B2',
  },
  real_estate: {
    id: 'real_estate',
    label: '房地产',
    color: '#BE185D',
  },
  manufacturing: {
    id: 'manufacturing',
    label: '制造业',
    color: '#4F46E5',
  },
};

export const categoryList = Object.values(categories);
