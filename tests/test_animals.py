import unittest
from unittest.mock import patch
from pathlib import Path
from manta_ray.ecology.animals import detect
from manta_ray.ecology.animals_worker import summarize


class AnimalTests(unittest.TestCase):
    def test_unavailable_is_not_zero(self):
        with patch.object(Path, 'is_file', return_value=False):
            result = detect(Path('clip.mp4'), Path('report.json'))
        self.assertEqual(result['status'], 'not_configured')
        self.assertIsNone(result['detections'])

    def test_repeated_boxes_are_not_unique_animals(self):
        result = summarize([{'detections': [1, 2]}, {'detections': [1, 2]}, {'detections': []}])
        self.assertEqual(result['detections'], 4)
        self.assertEqual(result['maximum_simultaneous_fish'], 2)
        self.assertEqual(result['frames_with_fish'], 2)
        self.assertIsNone(result['unique_individuals'])

    def test_successful_empty_detections_are_zero(self):
        result = summarize([{'detections': []}])
        self.assertEqual(result['maximum_simultaneous_fish'], 0)
        self.assertEqual(result['detections'], 0)

if __name__ == '__main__':
    unittest.main()
