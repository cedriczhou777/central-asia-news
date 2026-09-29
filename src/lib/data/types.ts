export type CountryCode = 'kz' | 'uz' | 'kg' | 'az' | 'tj';

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
  | 'law'
  | 'society'
  | 'culture'
  | 'sports'
  | 'healthcare'
  | 'energy'
  | 'oil_gas'
  | 'renewable_energy'
  | 'chemicals'
  | 'minerals'
  | 'infrastructure'
  | 'housing'
  | 'manufacturing'
  | 'livelihood'
  | 'security'
  | 'transport';

export interface CategoryInfo {
  id: Category;
  label: string;
  color: string;
}
