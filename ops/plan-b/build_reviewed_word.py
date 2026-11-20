#!/usr/bin/env python3
"""Render a prepared, independently reviewed country release as a Word document."""

import argparse
from io import BytesIO
import json
from pathlib import Path
from tempfile import NamedTemporaryFile
from xml.etree import ElementTree
from xml.sax.saxutils import escape, quoteattr
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from lxml import html
from PIL import Image, ImageOps

from prepare_country_release import image_location, read_json, sha, signed_assets
from source_article_images import EFFECTIVE_ISSUE
from validate_work_package import COUNTRIES, digest


W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
PREPARED_FILES = {'aggregate_ingest.json', 'package.json', 'staging_manifest.json'}


def load_reviewed_release(root):
    root = root.resolve(strict=True)
    state = read_json(root / 'prepared.json')
    country, issue, version = (state[key] for key in ('country', 'issueDate', 'version'))
    if country not in COUNTRIES or issue < EFFECTIVE_ISSUE or set(state['files']) != PREPARED_FILES:
        raise ValueError('unsupported country, issue or prepared release')
    files = {name: (root / name).read_bytes() for name in ('aggregate_ingest.json', 'package.json', 'staging_manifest.json')}
    if any(sha(content) != state['files'][name] for name, content in files.items()):
        raise ValueError('prepared files changed after review')
    aggregate = read_json(root / 'aggregate_ingest.json', files['aggregate_ingest.json'])
    package = read_json(root / 'package.json', files['package.json'])
    draft, review = aggregate['drafts'][country], aggregate['reviews'][country]
    articles = review['articles']
    review_hash = review['finalBodyHash']
    if (aggregate['package'] != package or package['readyCountries'] != [country]
            or set(package['countries']) != {country} or package['version'] != version
            or aggregate['issueDate'] != issue or draft['issueDate'] != issue or draft['country'] != country
            or review['issueDate'] != issue or review['country'] != country or review['stage'] != 'verified'
            or not review['reviewer'] or not draft['writerRun'] or review['reviewer'] == draft['writerRun']
            or any(review.get(key) is not True for key in (
                'fullSourceReviewCompleted', 'titleFactReviewCompleted', 'bodyFactReviewCompleted'))
            or review['originalHash'] != digest(draft['articles']) or not 1 <= len(articles) <= 20
            or len(articles) != state['articles'] or digest(articles) != review_hash):
        raise ValueError('prepared country package differs from the independent review')

    assets = signed_assets(articles)
    rows = read_json(root / 'staging_manifest.json', files['staging_manifest.json'])['images']
    if len(rows) != len(assets) or len(assets) != state['uniqueImages']:
        raise ValueError('prepared image manifest does not match the signed image scope')
    pictures = {}
    for row in rows:
        url = row['url']
        if url in pictures or assets.get(url) != {'sha256': row['sha256'], 'bytes': row['bytes']}:
            raise ValueError('prepared image manifest differs from the signed image identity')
        image = image_location(root, row)
        if not image.is_file() or image.stat().st_size != row['bytes']:
            raise ValueError(f"reviewed image bytes are missing or incomplete: {row['sha256']}")
        data = image.read_bytes()
        if len(data) != row['bytes'] or sha(data) != row['sha256']:
            raise ValueError('local image bytes differ from the signed image identity')
        pictures[url] = data
    return state, package['countries'][country], articles, pictures, review_hash


def image_for_word(data):
    with Image.open(BytesIO(data)) as image:
        if image.width * image.height > 40_000_000:
            raise ValueError('reviewed image exceeds the supported pixel limit')
        if (image.format in ('JPEG', 'PNG') and image.getexif().get(274, 1) == 1
                and max(image.size) <= 1600 and len(data) <= 1_000_000):
            return data, image.format.lower(), image.size
        # Convert the same verified original when native Word rendering is not
        # portable. Word receives the displayed first frame of animated images.
        image = ImageOps.exif_transpose(image)
        alpha = 'A' in image.getbands() or 'transparency' in image.info
        image = image.convert('RGBA' if alpha else 'RGB')
        image.thumbnail((1600, 1600))
        output = BytesIO()
        if alpha:
            image.save(output, format='PNG')
        else:
            image.save(output, format='JPEG', quality=88)
        return output.getvalue(), 'png' if alpha else 'jpeg', image.size


def relationship(identifier, kind, target, external=False):
    mode = ' TargetMode="External"' if external else ''
    return f'<Relationship Id="{identifier}" Type="{R}/{kind}" Target={quoteattr(target)}{mode}/>'


def relationships(content):
    return f'<Relationships xmlns="{P}">{content}</Relationships>'


def run(text, properties=''):
    return f'<w:r>{properties}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def paragraph(style, content):
    return f'<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr>{content}</w:p>'


def drawing(index, rel_id, size):
    width, height = size
    scale = min(5.9 * 914400 / width, 2.2 * 914400 / height, 914400 / 125)
    cx, cy = round(width * scale), round(height * scale)
    return (
        '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
        f'<wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{index}" name="Original photo {index}"/>'
        f'<a:graphic><a:graphicData uri="{PIC}"><pic:pic>'
        f'<pic:nvPicPr><pic:cNvPr id="0" name="Photo {index}"/><pic:cNvPicPr/></pic:nvPicPr>'
        f'<pic:blipFill><a:blip r:embed="{rel_id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    )


def style(style_id, name, size, color, *, before=0, after=0, bold=False, keep_next=False, align='left'):
    return (
        f'<w:style w:type="paragraph" w:styleId="{style_id}"><w:name w:val="{name}"/>'
        '<w:pPr>' + ('<w:keepNext/>' if keep_next else '')
        + f'<w:spacing w:before="{before}" w:after="{after}" w:line="325" w:lineRule="auto"/>'
        f'<w:jc w:val="{align}"/></w:pPr><w:rPr>'
        '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/>'
        + ('<w:b/>' if bold else '') + f'<w:color w:val="{color}"/><w:sz w:val="{size}"/>'
        '</w:rPr></w:style>'
    )


def word_parts(country, articles, pictures):
    rels = [relationship('rStyles', 'styles', 'styles.xml')]
    media = {}
    image_map = {}
    body = [paragraph('Title', run(country['title'])), paragraph('Summary', run(country['summary']))]
    photo_number = 0
    for position, article in enumerate(articles, 1):
        body.append(paragraph('Category', run(article['category'])))
        body.append(paragraph('Heading1', run(article['title'])))
        url = article.get('image_url')
        if url:
            if url not in image_map:
                data, suffix, size = image_for_word(pictures[url])
                index = len(image_map) + 1
                name = f'media/image-{index}.{suffix}'
                rel_id = f'rPhoto{index}'
                media['word/' + name] = data
                rels.append(relationship(rel_id, 'image', name))
                image_map[url] = (rel_id, size)
            photo_number += 1
            body.append(paragraph('Photo', drawing(photo_number, *image_map[url])))
        for line in article['body'].split('\n'):
            if line.strip():
                body.append(paragraph('Normal', run(line)))
        source_rel = f'rSource{position}'
        rels.append(relationship(source_rel, 'hyperlink', article['source_url'], external=True))
        linked_name = run(article['source'], '<w:rPr><w:color w:val="294E71"/><w:u w:val="single"/></w:rPr>')
        source = run('来源：') + f'<w:hyperlink r:id="{source_rel}">{linked_name}</w:hyperlink>'
        body.append(paragraph('Attribution', source))
    published_layout = html.fragment_fromstring(country['bodyHtml'], create_parent=True)
    footer = published_layout.xpath('.//*[@data-role="daily-footer"]')
    if len(footer) != 1:
        raise ValueError('prepared country package is missing its issue footer')
    for line in footer[0].xpath('./p'):
        body.append(paragraph('IssueFooter', run(line.text_content())))

    document = (
        f'<w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:wp="{WP}" xmlns:a="{A}" xmlns:pic="{PIC}">'
        '<w:body>' + ''.join(body) + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1150" w:right="1280" w:bottom="1150" w:left="1280"/>'
        '</w:sectPr></w:body></w:document>'
    )
    styles = ''.join([
        style('Normal', 'Normal', 22, '252525', after=80, align='both', keep_next=True),
        style('Title', 'Title', 39, '000000', after=150, bold=True, keep_next=True),
        style('Summary', 'Summary', 21, '454E56', after=180, keep_next=True),
        style('Category', 'Category', 17, '8C672A', before=160, after=30, bold=True, keep_next=True),
        style('Heading1', 'heading 1', 29, '111923', after=80, bold=True, keep_next=True),
        style('Photo', 'Photo', 22, '252525', after=80, align='center', keep_next=True),
        style('Attribution', 'Attribution', 18, '576673', after=120),
        style('IssueFooter', 'Issue Footer', 18, '576673', after=45, align='center'),
    ])
    types = (
        f'<Types xmlns="{CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
        '<Default Extension="png" ContentType="image/png"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '</Types>'
    )
    return {
        '[Content_Types].xml': types,
        '_rels/.rels': relationships(relationship('rDocument', 'officeDocument', 'word/document.xml')),
        'word/_rels/document.xml.rels': relationships(''.join(rels)),
        'word/document.xml': document,
        'word/styles.xml': f'<w:styles xmlns:w="{W}">{styles}</w:styles>',
        **media,
    }, photo_number


def build_word(release, output):
    if output.suffix != '.docx' or output.is_symlink():
        raise ValueError('output must be a regular .docx path')
    state, country, articles, pictures, review_hash = load_reviewed_release(release)
    parts, photo_count = word_parts(country, articles, pictures)
    for content in parts.values():
        if isinstance(content, str):
            ElementTree.fromstring(content)
    output.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=output.parent, prefix='.reviewed-word-', delete=False) as temporary:
        candidate = Path(temporary.name)
    try:
        with ZipFile(candidate, 'w', compression=ZIP_DEFLATED) as archive:
            for name, content in parts.items():
                member = ZipInfo(name)
                member.compress_type = ZIP_DEFLATED
                archive.writestr(member, content)
        report = {
            'ok': True, 'issueDate': state['issueDate'], 'country': state['country'], 'version': state['version'],
            'articles': len(articles), 'images': photo_count, 'signedFinalBodyHash': review_hash,
            'wordSha256': sha(candidate.read_bytes()), 'wordPath': str(output),
        }
        candidate.replace(output)
    finally:
        candidate.unlink(missing_ok=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        report = build_word(args.release, args.output)
    except (KeyError, TypeError, ValueError, OSError, ElementTree.ParseError, Image.DecompressionBombError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
