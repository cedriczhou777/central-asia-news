/**
 * ★ 最小 **docx（Word）读取器**（2026-11-07 新项目）。
 *
 * ## 为什么自己写
 *
 * · 原项目没有任何 docx 依赖 ⇒ 加一个（`mammoth`/`jszip`）要联网装，
 *   而这个环境装依赖不稳（pnpm 会被 safe-delete 拦）⇒ ⇒ **零依赖更可靠**；
 * · 我们只需要**段落文本**（标题/正文/来源）⇒ 不需要完整的 OOXML 语义。
 *
 * ## docx 是什么
 *
 * docx = **zip 包**，正文在 `word/document.xml`。
 * ⇒ 所以只要：① 读 zip 的中央目录找到 `word/document.xml` 的偏移；
 * ② 按 local header 取出该条目；③ 按压缩方式解压（多半是 deflate）。
 *
 * ## 输出
 *
 * `paragraphs`：按 `<w:p>` 切分的段落文本数组（已合并 run 的 `<w:t>`，
 * 已解实体），**保留空行**（空行是结构信号：分节/分隔正文与来源）。
 *
 * ## 边界
 *
 * · 不处理表格里的段落（`<w:tbl>` 里的 `<w:p>` 也会被 `<w:t>` 收进来
 *   ⇒ 表格内容会混进段落数组 ⇒ ⚠️ 解析器要能容忍；如需严格可在后面过滤）
 * · 不处理页眉页脚（不在 `word/document.xml` 里）⇒ 天然排除 ✓
 * · 不处理文本框（`w:txbxContent` 里的 `<w:p>` 也会进来）⇒ 同上，容忍即可
 */
import { inflateRawSync } from 'zlib';

export interface DocxParagraph {
  /** 段落纯文本（已解实体） */
  text: string;
  /** 段落样式名（来自 `w:pStyle`，如 `Heading1` / `Title`）—— 有助于识别标题 */
  style: string | null;
}

/** 解 XML 实体（docx 里 `&` `<` `>` 会转义） */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * 从 zip 缓冲区里取出**指定条目**的原始字节。
 *
 * @param buf 整个 zip 的字节
 * @param name 条目名（如 `word/document.xml`）
 * @returns 该条目的字节；找不到返回 null
 */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  // ① 找中央目录（End of Central Directory，签名 0x06054b50）
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  // ② 遍历中央目录条目
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null; // 中央目录头签名
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const entryName = buf.toString('utf8', off + 46, off + 46 + nameLen);

    if (entryName === name) {
      // ③ 跳到 local header：它有自己的 name/extra 长度
      if (buf.readUInt32LE(localOff) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return raw; // stored
      if (method === 8) return inflateRawSync(raw); // deflate
      return null; // 其他压缩方式不支持
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * 解析 docx 缓冲 → 段落数组。
 *
 * @param buf .docx 文件的字节
 * @throws 解析不出来时抛错（调用方要报错，不要静默吞）
 */
export function parseDocxParagraphs(buf: Buffer): DocxParagraph[] {
  const xmlEntry = readZipEntry(buf, 'word/document.xml');
  if (!xmlEntry) throw new Error('这不是一个可读的 .docx（找不到 word/document.xml）');
  const xml = xmlEntry.toString('utf8');

  const out: DocxParagraph[] = [];
  // 按 <w:p>…</w:p> 切；注意 <w:p/> 自闭合形式
  const re = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const inner = m[1] ?? '';
    // 段落样式
    const st = inner.match(/<w:pStyle\s+w:val="([^"]+)"/);
    // 文本：合并所有 <w:t>（含带属性的变体）
    let text = '';
    const tre = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let t: RegExpExecArray | null;
    while ((t = tre.exec(inner)) !== null) text += t[1];
    // 换行 <w:br/> 与制表 <w:tab/>
    text = text.replace(/<w:br\s*\/>/g, '\n').replace(/<w:tab\s*\/>/g, '\t');
    out.push({ text: decodeXmlEntities(text).trim(), style: st ? st[1] : null });
  }
  return out;
}
