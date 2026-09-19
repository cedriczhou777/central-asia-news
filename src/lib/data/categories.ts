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
  law: {
    id: 'law',
    label: '法律',
    color: '#7C3AED',
  },
  society: {
    id: 'society',
    label: '社会',
    color: '#DB2777',
  },
  culture: {
    id: 'culture',
    label: '人文',
    color: '#9333EA',
  },
  sports: {
    id: 'sports',
    label: '体育',
    color: '#0EA5E9',
  },
  healthcare: {
    id: 'healthcare',
    label: '医疗卫生',
    color: '#14B8A6',
  },
  energy: {
    id: 'energy',
    label: '能源',
    color: '#DC2626',
  },
  oil_gas: {
    id: 'oil_gas',
    label: '油气',
    color: '#B45309',
  },
  renewable_energy: {
    id: 'renewable_energy',
    label: '新能源',
    color: '#16A34A',
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
  housing: {
    id: 'housing',
    label: '住建',
    color: '#BE185D',
  },
  manufacturing: {
    id: 'manufacturing',
    label: '制造业',
    color: '#4F46E5',
  },
  livelihood: {
    id: 'livelihood',
    label: '民生',
    color: '#EA580C',
  },
  security: {
    id: 'security',
    label: '国安',
    color: '#0F766E',
  },
  transport: {
    id: 'transport',
    label: '交通',
    color: '#3B82F6',
  },
};

export const categoryList = Object.values(categories);