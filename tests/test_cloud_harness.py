"""Offline regressions for native cloud-client failure diagnostics."""
import ctypes
import os
import unittest
from unittest.mock import Mock, patch

import test_cloud as cloud


class CloudClientDiagnostics(unittest.TestCase):
    def test_fixed_categories_never_return_driver_message_contents(self):
        for message, expected in (
                (b'connection refused: postgresql://private:secret@example.invalid/database', 'connection-refused'),
                (b'password authentication failed for user "private"', 'authentication'),
                (b'connection timeout expired', 'timeout'),
                (b'could not translate host name private.example', 'name-resolution'),
                (b'SSL error: private certificate', 'tls'),
                (b'undocumented private driver error', 'connection'),
                (None, 'connection')):
            with self.subTest(category=expected):
                self.assertEqual(cloud.postgres_failure_category(message), expected)

    def test_failed_native_connection_is_closed_and_error_contains_only_category(self):
        pq, mongo, bson = Mock(), Mock(), Mock()
        pq.PQconnectdb.return_value = 123
        pq.PQstatus.return_value = 1
        pq.PQerrorMessage.return_value = b'connection refused postgresql://synthetic:private-secret@127.0.0.1:9/test'
        with patch.object(cloud, 'native_library', side_effect=[pq, mongo, bson]), \
                patch.dict(os.environ, {'OPENBOARD_POSTGRES_URL': 'postgresql://synthetic:private-secret@127.0.0.1:9/test'}):
            with self.assertRaises(RuntimeError) as caught:
                cloud.NativeStores()
        self.assertEqual(str(caught.exception), 'Test PostgreSQL unavailable (connection-refused)')
        self.assertEqual(pq.PQconnectdb.argtypes, [ctypes.c_char_p])
        self.assertIs(pq.PQconnectdb.restype, ctypes.c_void_p)
        self.assertEqual(pq.PQstatus.argtypes, [ctypes.c_void_p])
        self.assertIs(pq.PQstatus.restype, ctypes.c_int)
        self.assertEqual(pq.PQerrorMessage.argtypes, [ctypes.c_void_p])
        self.assertIs(pq.PQerrorMessage.restype, ctypes.c_char_p)
        pq.PQfinish.assert_called_once_with(123)
        mongo.mongoc_client_new.assert_not_called()


if __name__ == '__main__':
    unittest.main()
