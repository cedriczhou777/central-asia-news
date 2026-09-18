import type { Country, CountryCode } from './types';

export const countries: Record<CountryCode, Country> = {
  kz: {
    code: 'kz',
    name: '哈萨克斯坦',
    nameEn: 'Kazakhstan',
    capital: '阿斯塔纳',
    color: '#00AFCA',
    flag: '🇰🇿',
  },
  uz: {
    code: 'uz',
    name: '乌兹别克斯坦',
    nameEn: 'Uzbekistan',
    capital: '塔什干',
    color: '#1EB53A',
    flag: '🇺🇿',
  },
  kg: {
    code: 'kg',
    name: '吉尔吉斯斯坦',
    nameEn: 'Kyrgyzstan',
    capital: '比什凯克',
    color: '#E8112B',
    flag: '🇰🇬',
  },
  az: {
    code: 'az',
    name: '阿塞拜疆',
    nameEn: 'Azerbaijan',
    capital: '巴库',
    color: '#00AF66',
    flag: '🇦🇿',
  },
  tj: {
    code: 'tj',
    name: '塔吉克斯坦',
    nameEn: 'Tajikistan',
    capital: '杜尚别',
    color: '#CC0000',
    flag: '🇹🇯',
  },
};

export const countryList = Object.values(countries);
