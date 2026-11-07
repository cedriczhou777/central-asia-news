'use client';

/**
 * ★ Word 稿上传页（2026-11-07 新链路）。
 *
 * 路径：`/word` ⇒ 上传 .docx ⇒ 看校核报告 ⇒ **一键复制修正清单**（贴回 ChatGPT）。
 *
 * ⭐ 为什么要有这个页面：
 * · 不依赖任何命令行（curl / 脚本）⇒ 你只要拖个文件进去；
 * · 修正清单能**一键复制**⇒ 直接贴给 ChatGPT，它按清单改；
 * · 上传**默认不落库**（只有勾了「同时落库」才写）⇒ 改稿期间不会污染生产库。
 */
import { useState } from 'react';

interface Finding {
  severity: string;
  kind: string;
  message: string;
  country: string;
  index: number;
  title: string;
}

export default function WordIngestPage() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<{
    articles: number;
    warnings: string[];
    findings: Finding[];
    byCountry: Record<string, { total: number; findings: number }>;
    fixList: string;
    persisted: { inserted: number; skipped: number } | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [persist, setPersist] = useState(false);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setErr(null);
    setCopied(false);
    try {
      const fd = new FormData();
      fd.append('file', f);
      if (persist) fd.append('persist', '1');
      const res = await fetch('/api/word-ingest', { method: 'POST', body: fd });
      const j = await res.json();
      if (!j.ok) {
        setErr(j.error || '未知错误');
        setReport(null);
      } else {
        setReport({
          articles: j.parsed.articles,
          warnings: j.parsed.warnings || [],
          findings: j.audit.findings || [],
          byCountry: j.audit.byCountry || {},
          fixList: j.fixList || '',
          persisted: j.persisted || null,
        });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const high = report?.findings.filter((f) => f.severity === 'high') || [];
  const mid = report?.findings.filter((f) => f.severity === 'medium') || [];
  const low = report?.findings.filter((f) => f.severity === 'low') || [];

  return (
    <main style={{ maxWidth: 900, margin: '40px auto', padding: '0 20px', fontFamily: 'system-ui, sans-serif' }}>
      <h1>五国日报 Word 稿 · 上传与校核</h1>
      <p style={{ color: '#666' }}>
        上传 ChatGPT 产出的 .docx ⇒ 得到校核报告与<b>可直接回喂给 ChatGPT 的修正清单</b>。
        默认只校核、不落库。
      </p>

      <div style={{ margin: '20px 0', padding: '20px', border: '1px solid #ddd', borderRadius: 8 }}>
        <input type="file" accept=".docx" onChange={onPick} disabled={busy} />
        <label style={{ marginLeft: 16 }}>
          <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />{' '}
          同时落库（确认稿子已改好再用）
        </label>
        {busy && <span style={{ marginLeft: 16, color: '#888' }}>解析中…</span>}
      </div>

      {err && (
        <div style={{ padding: '12px 16px', background: '#fff1f0', border: '1px solid #ffa39e', borderRadius: 6 }}>
          <b>失败</b>：{err}
        </div>
      )}

      {report && (
        <>
          <div style={{ display: 'flex', gap: 24, margin: '20px 0', flexWrap: 'wrap' }}>
            <Stat label="稿件数" value={report.articles} />
            <Stat label="必须改" value={high.length} color="#cf1322" />
            <Stat label="建议改" value={mid.length} color="#d46b08" />
            <Stat label="可选改" value={low.length} color="#8c8c8c" />
            {report.persisted && <Stat label="已落库" value={report.persisted.inserted} color="#389e0d" />}
          </div>

          {Object.keys(report.byCountry).length > 0 && (
            <p style={{ color: '#666' }}>
              分国：{Object.entries(report.byCountry).map(([c, v]) => `${c} ${v.total}篇/${v.findings}问题`).join('，')}
            </p>
          )}

          {report.warnings.length > 0 && (
            <details style={{ margin: '16px 0' }}>
              <summary>解析提醒（{report.warnings.length}）</summary>
              <ul>{report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}

          {report.findings.length > 0 && (
            <>
              <h2>问题清单</h2>
              {[['必须修改', high], ['建议修改', mid], ['可选修改', low]].map(([label, arr]) => {
                const list = arr as Finding[];
                if (!list.length) return null;
                return (
                  <div key={label as string}>
                    <h3>{label as string}（{list.length}）</h3>
                    {list.map((f, i) => (
                      <div key={i} style={{ padding: '10px 14px', margin: '6px 0', background: '#fafafa', borderLeft: '3px solid #d9d9d9' }}>
                        <div style={{ fontWeight: 600 }}>第 {f.index} 条｜{f.title}</div>
                        <div style={{ color: '#555', marginTop: 4 }}>{f.message}</div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </>
          )}

          {report.fixList && (
            <>
              <h2>修正清单（贴回 ChatGPT）</h2>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(report.fixList);
                    setCopied(true);
                  } catch { /* 剪贴板不可用时手动选中即可 */ }
                }}
              >
                {copied ? '✔ 已复制' : '复制清单'}
              </button>
              <pre style={{ background: '#f6f6f6', padding: 14, borderRadius: 6, whiteSpace: 'pre-wrap', fontSize: 13 }}>
                {report.fixList}
              </pre>
            </>
          )}
        </>
      )}
    </main>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 8, padding: '10px 18px', minWidth: 96 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || '#111' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#888' }}>{label}</div>
    </div>
  );
}
