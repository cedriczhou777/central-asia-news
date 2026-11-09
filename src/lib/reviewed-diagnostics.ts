import { load } from 'cheerio';
import { makeSourceUrlsVisible, type ReviewedCountry } from './reviewed-package';

// Read-only diagnostics for a known existing draft. Never includes credentials or media IDs.
export function summarizeDraftReadback(expected: ReviewedCountry, actual: { title: string; digest: string; content: string }, expectedImages: string[]) {
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
  return {
    titleMatch: actual.title === expected.title, digestMatch: actual.digest === expected.summary,
    expectedTextMatch: actualText === expectedText, legacyTextMatch: actualText === oldText,
    actualLength: actualText.length, legacyLength: oldText.length, firstDifference: difference,
    expectedSnippet: oldText.slice(Math.max(0, difference - 25), difference + 100),
    actualSnippet: actualText.slice(Math.max(0, difference - 25), difference + 100),
    expectedImages: expectedImages.length, actualImageTags: imageAttributes.length, imageAttributes,
    expectedImageIdentities: expectedImages.map(imageIdentity), actualImageIdentities: actualImages.map(imageIdentity),
  };
}
