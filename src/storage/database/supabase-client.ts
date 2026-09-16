import { createClient, SupabaseClient } from '@supabase/supabase-js';

interface SupabaseCredentials {
  url: string;
  anonKey: string;
}

// 数据库连接信息：优先用通用命名，兼容扣子平台注入的 COZE_* 命名。
// （迁移期两边都能跑，之后可以只留 SUPABASE_* 一套。）
function firstDefined(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function getSupabaseCredentials(): SupabaseCredentials {
  const url = firstDefined('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'COZE_SUPABASE_URL');
  const anonKey = firstDefined(
    'SUPABASE_ANON_KEY',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'COZE_SUPABASE_ANON_KEY'
  );

  if (!url) {
    throw new Error(
      '缺少 Supabase 地址，请配置环境变量 SUPABASE_URL（兼容 NEXT_PUBLIC_SUPABASE_URL / COZE_SUPABASE_URL）'
    );
  }
  if (!anonKey) {
    throw new Error(
      '缺少 Supabase Key，请配置环境变量 SUPABASE_ANON_KEY（兼容 NEXT_PUBLIC_SUPABASE_ANON_KEY / COZE_SUPABASE_ANON_KEY）'
    );
  }

  return { url, anonKey };
}

function getSupabaseServiceRoleKey(): string | undefined {
  return firstDefined('SUPABASE_SERVICE_ROLE_KEY', 'COZE_SUPABASE_SERVICE_ROLE_KEY');
}

function getSupabaseClient(token?: string): SupabaseClient {
  const { url, anonKey } = getSupabaseCredentials();

  let key: string;
  if (token) {
    key = anonKey;
  } else {
    const serviceRoleKey = getSupabaseServiceRoleKey();
    key = serviceRoleKey ?? anonKey;
  }

  return createClient(url, key, {
    db: {
      timeout: 10000,
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export { getSupabaseCredentials, getSupabaseServiceRoleKey, getSupabaseClient };
