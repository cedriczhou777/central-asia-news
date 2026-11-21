"""A photo evidence gap must not discard signed news or authorize an OG image."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops' / 'plan-b'))
from cloud_release import source_photo
from source_article_images import origin_error


class PhotoGap(unittest.TestCase):
    def test_metadata_only_remains_an_explicit_gap_without_network_or_image(self):
        page = 'https://publisher.example/current-story'
        hint = 'https://publisher.example/photo.jpg'
        article = {'id': 'fixture', 'source_url': page,
                   'articleImages': {'candidates': [], 'metadataHints': [hint]}}
        with tempfile.TemporaryDirectory() as root, patch('source_article_images.subprocess.run') as network:
            result = source_photo(article, Path(root))
        network.assert_not_called()
        self.assertEqual(result['sourceImage']['status'], 'unavailable')
        self.assertEqual(result['sourceImage']['candidateEvidence'], 'metadata_only_unconfirmed')
        self.assertEqual(result['sourceImage']['candidateUrls'], [hint])
        self.assertNotIn('image_url', result)
        self.assertIn('不认定原文无图', result['imageUnavailableReason'])
        self.assertIsNone(origin_error({**article, **result}))

    def test_no_photo_evidence_stays_none(self):
        article = {'id': 'fixture', 'source_url': 'https://publisher.example/current-story',
                   'articleImages': {'candidates': [], 'metadataHints': []}}
        with tempfile.TemporaryDirectory() as root:
            result = source_photo(article, Path(root))
        self.assertEqual(result['sourceImage']['status'], 'none')
        self.assertIsNone(origin_error({**article, **result}))

    def test_confirmed_photo_result_is_preserved(self):
        photo = {'id': 'fixture', 'image_url': 'https://publisher.example/photo.jpg',
                 'sourceImage': {'status': 'original', 'candidateUrls': ['https://publisher.example/photo.jpg']}}
        with patch('cloud_release.collect', return_value=photo):
            self.assertIs(source_photo({}, Path('.')), photo)


if __name__ == '__main__':
    unittest.main()
