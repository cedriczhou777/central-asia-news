"""Build scoped reviewed country packages without changing the daily layout."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from build_work_package import build, country_scope, NAMES


class CountryPackageBuilder(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)

    def tearDown(self):self.temp.cleanup()

    def write_countries(self,codes):
        for code in codes:
            entries=[{'id':code+'01','title':'Synthetic fixture title','body':'Synthetic fixture body, not news.',
                      'source':'Synthetic fixture source','category':'Synthetic fixture category',
                      'image_url':'https://example.com/'+code+'.png','image_caption':'Synthetic fixture image'}]
            (self.root/(code+'.json')).write_text(json.dumps({'articles':entries}))
        (self.root/'summaries.json').write_text(json.dumps({code:'Synthetic fixture summary' for code in codes}))

    def test_scoped_cli_needs_only_selected_country_files(self):
        self.write_countries(['kz','uz'])
        # A broken unrelated file must not block either ready country's package.
        (self.root/'tj.json').write_text('unready country, not JSON')
        result=subprocess.run([sys.executable,str(Path(__file__).with_name('build_work_package.py')),
                               '--root',str(self.root),'--issue','2026-11-16','--countries','kz,uz'],
                              capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        package=json.loads((self.root/'package.json').read_text())
        self.assertEqual(package['readyCountries'],['kz','uz'])
        self.assertEqual(set(package['countries']),{'kz','uz'})
        self.assertTrue((self.root/'preview_kz.html').is_file())
        self.assertFalse((self.root/'preview_tj.html').exists())

    def test_default_preserves_five_countries_layout_and_footer(self):
        self.write_countries(list(NAMES))
        with contextlib.redirect_stdout(io.StringIO()):build(self.root,'2026-11-16')
        package=json.loads((self.root/'package.json').read_text())
        self.assertNotIn('readyCountries',package,'the default package keeps the legacy shape and content hash')
        self.assertEqual(set(package['countries']),set(NAMES))
        for code,country in package['countries'].items():
            body=country['bodyHtml']
            self.assertIn('font-size:16px;line-height:1.9',body)
            self.assertIn('text-align:justify;text-justify:inter-ideograph;text-align-last:left',body)
            self.assertIn('padding:0 10px 20px',body)
            self.assertIn('padding:20px 12px',body)
            self.assertIn('中亚投资资讯 | Central Asia Investment Daily',body)
            self.assertIn('数据来源：各国主流媒体',body)
            self.assertGreater(body.index('data-role="daily-footer"'),body.index('Synthetic fixture body'))
            self.assertEqual(country['coverUrl'],'https://example.com/'+code+'.png')
            self.assertEqual(country['sourceUrl'],'')

    def test_scope_rejects_empty_unknown_and_duplicate_countries(self):
        for scope in ('','kz,kz','kz,xx','kz,','KZ',['kz','kz'],[]):
            with self.subTest(scope=scope),self.assertRaises(ValueError):country_scope(scope)

    def test_default_does_not_silently_turn_missing_country_into_partial_package(self):
        self.write_countries(['kz'])
        with self.assertRaises(FileNotFoundError):
            with contextlib.redirect_stdout(io.StringIO()):build(self.root,'2026-11-16')
        self.assertFalse((self.root/'package.json').exists())


if __name__=='__main__':unittest.main()
