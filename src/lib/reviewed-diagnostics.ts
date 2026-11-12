import { load } from 'cheerio';
import { makeSourceUrlsVisible, type ReviewedCountry } from './reviewed-package';

// Read-only diagnostics for a known existing draft. Never includes credentials or media IDs.
export function summarizeDraftReadback(expected: ReviewedCountry, actual: { title: string; digest: string; content: string; content_source_url?: string; thumb_media_id?: string }, expectedImages: string[]) {
  const text = (html: string) => load(html, {}, false).text().replace(/\s+/g, '');
  const oldText = text(makeSourceUrlsVisible(expected.bodyHtml));
  const expectedText = text(expected.bodyHtml);
  const actualText = text(actual.content);
  let difference = 0;
  while (difference < oldText.length && difference < actualText.length && oldText[difference] === actualText[difference]) difference++;
  const $ = load(actual.content, {}, false);
  const imageAttributes = $('img').toArray().map(el => ({ src: !!$(el).attr('src'), dataSrc: !!$(el).attr('data-src') }));
  const imageIdentity = (value: string) => { try { const u = new URL(value); return { host:u.hostname, path:u.pathname }; } catch { return null; } };
  const actualImages = $('img').toArray().map(el => $(el).attr('src') || $(el).attr('data-src') || '');
  const compactStyle = (style:string) => style.toLowerCase().replace(/\s+/g,'');
  const expectedDom = load(expected.bodyHtml,{},false);
  const expectedBodyCount = expectedDom('p').toArray().filter(el=>compactStyle(expectedDom(el).attr('style')||'').includes('font-size:16px')).length;
  const bodyStyles = $('p').toArray().map(el=>compactStyle($(el).attr('style')||'')).filter(style=>style.includes('font-size:16px'));
  const allStyles = $('[style]').toArray().map(el=>compactStyle($(el).attr('style')||''));
  const bodyCountMatch = expectedBodyCount>0 && bodyStyles.length===expectedBodyCount;
  const footerLines=['中亚投资资讯 | Central Asia Investment Daily','数据来源：各国主流媒体'];
  const paragraphs=$('p').toArray();
  const actualFooterParagraphs=paragraphs.slice(-2);
  const actualFooterLines=actualFooterParagraphs.map(el=>$(el).text().trim());
  const actualFooterStyles=actualFooterParagraphs.map(el=>compactStyle($(el).attr('style')||''));
  const footerContainerStyle=actualFooterParagraphs.length===2
    ? compactStyle($(actualFooterParagraphs[0]).parent().attr('style')||'') : '';
  const footerTextOrderMatch=actualFooterLines.length===2 && footerLines.every((line,index)=>actualFooterLines[index]===line);
  const footerAtEnd=actualFooterParagraphs.length===2 && actualFooterParagraphs[1]===paragraphs.at(-1);
  const footerCentered=actualFooterStyles.every(style=>style.includes('text-align:center')) && footerContainerStyle.includes('text-align:center');
  const footerFontSize12=actualFooterStyles.every(style=>style.includes('font-size:12px'));
  const footerGray=actualFooterStyles.every(style=>style.includes('color:#929292'));
  const footerBackground=footerContainerStyle.includes('background:#f7f5ef');
  return {
    diagnosticsVersion:3,
    titleMatch: actual.title === expected.title, digestMatch: actual.digest === expected.summary,
    expectedTextMatch: actualText === expectedText, legacyTextMatch: actualText === oldText,
    actualLength: actualText.length, legacyLength: oldText.length, firstDifference: difference,
    expectedSnippet: oldText.slice(Math.max(0, difference - 25), difference + 100),
    actualSnippet: actualText.slice(Math.max(0, difference - 25), difference + 100),
    expectedImages: expectedImages.length, actualImageTags: imageAttributes.length, imageAttributes,
    expectedImageIdentities: expectedImages.map(imageIdentity), actualImageIdentities: actualImages.map(imageIdentity),
    originalLinkEmpty:typeof actual.content_source_url==='string' ? actual.content_source_url==='' : null,
    thumbnailPresent:typeof actual.thumb_media_id==='string' && actual.thumb_media_id.length>0,
    layout:{expectedBodyParagraphs:expectedBodyCount,actualBodyParagraphs:bodyStyles.length,bodyCountMatch,
      justified:bodyCountMatch && bodyStyles.every(style=>style.includes('text-align:justify')),
      lastLineLeft:bodyCountMatch && bodyStyles.every(style=>style.includes('text-align-last:left')),
      lineHeight19:bodyCountMatch && bodyStyles.every(style=>style.includes('line-height:1.9')),
      outerMargin10:allStyles.some(style=>/(?:^|;)padding:010px20px(?:;|$)/.test(style)),
      innerMargin12:allStyles.some(style=>/(?:^|;)padding:20px12px(?:;|$)/.test(style)),
    },
    footer:{expectedLines:footerLines,actualLines:actualFooterLines,textOrderMatch:footerTextOrderMatch,
      atEnd:footerAtEnd,centered:footerCentered,fontSize12:footerFontSize12,gray:footerGray,
      backgroundF7F5EF:footerBackground,
      passed:footerTextOrderMatch && footerAtEnd && footerCentered && footerFontSize12 && footerGray && footerBackground},
  };
}
