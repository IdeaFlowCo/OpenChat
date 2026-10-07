"""Run with python3 apps/mobile/scripts/test-publish-to-testers.py; no ASC calls."""
import importlib.util
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

sys.modules.setdefault('jwt', types.SimpleNamespace())
spec = importlib.util.spec_from_file_location('publisher', pathlib.Path(__file__).with_name('publish-to-testers.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


def build(version='1.0.16', number='126', state='VALID'):
    return {'data': [{'id': 'exact-build', 'attributes': {'version': number, 'processingState': state},
                      'relationships': {'preReleaseVersion': {'data': {'id': 'release'}}}}],
            'included': [{'id': 'release', 'attributes': {'version': version}}]}


class PublisherTest(unittest.TestCase):
    def test_accepts_exact_archive_already_processed_before_polling(self):
        with patch.object(publisher, 'asc', return_value=(200, build())):
            self.assertEqual(publisher.find_release_build('1.0.16', '126')['id'], 'exact-build')

    def test_refuses_other_versions_builds_and_unprocessed_archives(self):
        for response in [build(version='1.0.15'), build(number='125'), build(state='PROCESSING')]:
            with self.subTest(response=response), patch.object(publisher, 'asc', return_value=(200, response)):
                self.assertIsNone(publisher.find_release_build('1.0.16', '126'))

    def test_main_assigns_exact_ready_build_without_waiting_for_another(self):
        def asc(method, path, body=None):
            if method == 'GET':
                return 200, build()
            self.assertEqual(body['data'][0]['id'] if isinstance(body['data'], list)
                             else body['data']['relationships']['build']['data']['id'], 'exact-build')
            return (204 if 'relationships/builds' in path else 201), {}
        with patch.dict('os.environ', {'OPENCHAT_ASC_BUILD_NUMBER': '126'}), \
                patch.object(publisher, 'read_current_version', return_value='1.0.16'), \
                patch.object(publisher, 'asc', side_effect=asc), \
                patch.object(publisher.time, 'sleep', side_effect=AssertionError('Already ready; no sleep')):
            self.assertEqual(publisher.main(), 0)

    def test_refuses_to_guess_archive_when_build_is_missing(self):
        with patch.dict('os.environ', {'OPENCHAT_ASC_BUILD_NUMBER': ''}), \
                patch.object(publisher, 'asc', side_effect=AssertionError('No API call without exact target')):
            self.assertEqual(publisher.main(), 1)


if __name__ == '__main__':
    unittest.main()
