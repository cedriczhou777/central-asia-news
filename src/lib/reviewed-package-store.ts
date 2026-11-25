import { getSupabaseClient } from '../storage/database/supabase-client';
import { contentHash, issueDate, type ReviewedPackage } from './reviewed-package';

export const REVIEWED_VERSION_CONFLICT = '同版本内容不同；修订稿须使用新的修订版本';

export async function storeReviewedPackage(payload: ReviewedPackage, sb = getSupabaseClient()) {
  const hash = contentHash(payload);
  const { error } = await sb.from('reviewed_packages').insert({
    version: payload.version, issue_date: issueDate(payload.version), content_hash: hash, payload,
  });
  if (!error) return { hash, duplicate: false };
  if (error.code !== '23505') throw new Error('稿包数据库未就绪或写入失败');
  const existing = await sb.from('reviewed_packages').select('content_hash').eq('version', payload.version).single();
  if (existing.error) throw new Error('无法核实已有版本');
  if (existing.data.content_hash !== hash) throw new Error(REVIEWED_VERSION_CONFLICT);
  return { hash, duplicate: true };
}
