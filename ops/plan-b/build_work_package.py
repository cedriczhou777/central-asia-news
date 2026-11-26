import argparse, json, html, hashlib, re
from pathlib import Path
from source_article_images import EFFECTIVE_ISSUE, origin_error
from source_attribution import source_name_error
from editorial_policy import EFFECTIVE_ISSUE as EDITORIAL_ISSUE

NAMES={'kz':('哈萨克斯坦','🇰🇿'),'uz':('乌兹别克斯坦','🇺🇿'),'kg':('吉尔吉斯斯坦','🇰🇬'),'tj':('塔吉克斯坦','🇹🇯'),'az':('阿塞拜疆','🇦🇿')}
def country_scope(countries=None):
    if countries is None:return list(NAMES)
    scope=countries.split(',') if isinstance(countries,str) else list(countries)
    if not scope or any(code not in NAMES for code in scope) or len(set(scope))!=len(scope):
        raise ValueError('countries must be a nonempty, unique list of kz,uz,kg,tj,az')
    return scope

def build(root, issue, version=None,countries=None):
    y,m,d=map(int,issue.split('-')); date=f'{y}年{m}月{d}日'
    scope=country_scope(countries)
    package={'version':version or issue,'countries':{}}; manifest={}
    if countries is not None:package['readyCountries']=scope
    for code in scope:
        name,flag=NAMES[code]
        raw=json.loads((root/f'{code}.json').read_text())
        entries=raw if isinstance(raw,list) else raw.get('articles',raw.get('entries'))
        assert entries and len(entries)<=20,(code,'empty or excessive')
        chunks=[f'<section style="background:#f7f5ef;padding:0 10px 20px;max-width:680px;margin:0 auto;"><section style="background:#0f1b2d;text-align:center;padding:24px 12px;"><p style="font-size:28px;margin:0;text-align:center;">{flag}</p><p style="color:#c3a35b;font-size:26px;font-weight:bold;margin:8px 0;text-align:center;">{name}</p><p style="color:#fff;font-size:18px;margin:8px 0;text-align:center;">每日投资资讯</p><p style="color:#c5c9d0;font-size:13px;margin:0;text-align:center;">{date}</p></section><section style="background:#fff;border-radius:10px;padding:20px 12px;">']
        pictures=[]; categories=[]
        for i,e in enumerate(entries):
            if issue >= EFFECTIVE_ISSUE:
                error = source_name_error(e) or origin_error(e)
                if error:
                    raise ValueError(f'{code} story {i + 1}: {error}')
            assert e.get('title') and e.get('body'),(code,i,'missing text')
            assert not any(x in e['body'] for x in ['待核实','建议核对','编辑注意']),(code,i,'editorial remnants')
            category=e.get('category','产业'); categories.append(category)
            source=e.get('source',e.get('source_name',''))
            assert source,(code,i,'missing source')
            chunks += ['<section style="border-bottom:1px dashed #dedede;padding:0 0 20px;margin:0 0 20px;">',f'<p style="color:#b39350;font-size:13px;margin:0 0 8px;">● {html.escape(category)}</p>',f'<p style="font-size:18px;font-weight:bold;line-height:1.6;color:#1a2635;margin:0 0 12px;">{html.escape(e["title"])}</p>']
            image=e.get('image_url') or ''
            if image:
                assert image.startswith('https://'),(code,i,'image must be HTTPS')
                pictures.append(image)
                margin = '0 0 12px' if issue >= EFFECTIVE_ISSUE else '0 0 4px'
                chunks.append(f'<p style="margin:{margin};"><img src="{html.escape(image,quote=True)}" style="width:100%;height:auto;border-radius:6px;" /></p>')
                if issue < EFFECTIVE_ISSUE:
                    caption=e.get('image_caption'); assert caption,(code,i,'missing historical caption')
                    if issue >= '2026-11-17':
                        assert len(caption) <= 80, (code,i,'caption too long')
                        assert not re.search(r'https?://|www\.|Wikimedia|Creative\s+Commons|\bCC\s*(?:BY|0)\b|BY[-\s]?SA|(?:摄影|摄像|图片来源|图源)\s*[:：]', caption, re.I), (code,i,'caption must be concise explanatory text')
                    chunks.append(f'<p style="font-size:11px;line-height:1.6;color:#888;margin:0 0 12px;text-align:left;text-align-last:left;letter-spacing:normal;word-spacing:normal;overflow-wrap:break-word;">{html.escape(caption)}</p>')
            for paragraph in e['body'].split('\n'):
                if paragraph.strip(): chunks.append(f'<p style="font-size:16px;line-height:1.9;color:#252525;margin:0 0 12px;text-align:justify;text-justify:inter-ideograph;text-align-last:left;overflow-wrap:break-word;">{html.escape(paragraph)}</p>')
            source_label = html.escape(source)
            if issue >= EDITORIAL_ISSUE:
                url = e.get('source_url') or ''
                if not url.startswith('https://'):
                    raise ValueError(f'{code} story {i+1}: missing HTTPS original URL')
                escaped_url = html.escape(url,quote=True)
                source_label += f'（<a href="{escaped_url}">{escaped_url}</a>）'
            chunks.append(f'<p style="font-size:12px;line-height:1.6;color:#929292;margin:0;text-align:left;text-align-last:left;letter-spacing:normal;word-spacing:normal;overflow-wrap:break-word;">来源：{source_label}</p></section>')
        chunks.append('</section><section data-role="daily-footer" style="background:#f7f5ef;text-align:center;padding:30px 12px 6px;"><p style="color:#929292;text-align:center;font-size:12px;line-height:1.9;letter-spacing:0.3px;margin:0 0 4px;">中亚投资资讯 | Central Asia Investment Daily</p><p style="color:#929292;text-align:center;font-size:12px;line-height:1.9;letter-spacing:0.3px;margin:0;">数据来源：各国主流媒体</p></section></section>')
        summaries=json.loads((root/'summaries.json').read_text())
        country={'title':f'{name}｜每日投资资讯（{date}）','summary':summaries[code],'bodyHtml':''.join(chunks),'sourceName':'中亚动态–INVEST','sourceUrl':'','coverUrl':pictures[0] if pictures else ''}
        package['countries'][code]=country
        manifest[code]={'articles':len(entries),'images':len(pictures),'imageCoverage':round(len(pictures)/len(entries),4),'imageCoverageTarget':1.0,'imageCoverageReviewTrigger':0.9,'imageGaps':[{'id':e.get('id',i+1),'title':e['title'],'reason':e.get('imageUnavailableReason','')} for i,e in enumerate(entries) if not e.get('image_url')],'footerLines':['中亚投资资讯 | Central Asia Investment Daily', '数据来源：各国主流媒体'],'footerOutsideWhiteBody':True,'firstArticleImage':bool(entries[0].get('image_url')),'bodySha256':hashlib.sha256(country['bodyHtml'].encode()).hexdigest(),'sourceUrlEmpty':True,'categories':list(dict.fromkeys(categories))}
        if issue >= EFFECTIVE_ISSUE:
            manifest[code].pop('imageCoverageTarget')
            manifest[code].pop('imageCoverageReviewTrigger')
            manifest[code]['originalImageRetrievalFailures'] = [
                e['id'] for e in entries if e['sourceImage']['status'] == 'unavailable'
            ]
        (root/f'preview_{code}.html').write_text('<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+country['bodyHtml'])
    target=root/'package.json'; target.write_text(json.dumps(package,ensure_ascii=False,indent=2))
    manifest['packageSha256']=hashlib.sha256(target.read_bytes()).hexdigest()
    (root/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    print(json.dumps(manifest,ensure_ascii=False,indent=2))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--issue',required=True);p.add_argument('--version');p.add_argument('--root',type=Path,default=Path(__file__).parent);p.add_argument('--countries',help='Only build these ready countries, e.g. kz,uz; default is all five');a=p.parse_args();build(a.root,a.issue,a.version,a.countries)
