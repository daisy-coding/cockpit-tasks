#!/usr/bin/env python3
"""Семь суток простоя: успех продлевает, ошибки и чтение без ключа — нет."""
import secrets
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from support import Harness
from agents.claude.cockpit import rpc


class AttestationLifetimeTests(Harness):
    def setUp(self):
        super().setUp()
        self.clock = datetime(2026, 10, 5, tzinfo=timezone.utc)
        self.secret = secrets.token_hex(32)
        self.assertTrue(self.call("session.attest")["ok"])

    def call(self, op, args=None, request=None, secret=True):
        request = request or self.request(op, args)
        if secret:
            request = {**request, "panelSecret": self.secret, "actor": "owner"}
        stamp = self.clock.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        with patch("agents.claude.cockpit.store.state_directory", return_value=str(self.state)), patch("agents.claude.cockpit.domain.now", return_value=stamp):
            return rpc.handle(request)

    def test_fresh_works_and_exactly_seven_days_idle_expires_before_cache(self):
        request = self.request("snapshot")
        self.assertTrue(self.call("snapshot", request=request)["ok"])
        before = self.rows("SELECT * FROM requests")
        self.clock += timedelta(days=7)
        response = self.call("snapshot", request=request)
        self.error(response, "ATTESTATION_FAILED")
        self.assertTrue(response["error"]["message"].startswith("[attestation-expired]"))
        self.assertEqual(self.rows("SELECT * FROM requests"), before)
        self.assertTrue(self.call("tasks.context", secret=False)["ok"])
        self.error(self.call("session.attest"), "ATTESTATION_FAILED")

    def test_successful_use_and_successful_cached_replay_extend_lifetime(self):
        request = self.request("snapshot")
        self.assertTrue(self.call("snapshot", request=request)["ok"])
        self.clock += timedelta(days=6)
        self.assertTrue(self.call("snapshot", request=request)["ok"])
        self.clock += timedelta(days=6)
        self.assertTrue(self.call("snapshot")["ok"])
        self.clock += timedelta(days=7)
        self.error(self.call("snapshot"), "ATTESTATION_FAILED")

    def test_failed_operation_and_unsigned_read_do_not_extend_lifetime(self):
        before = self.rows("SELECT * FROM attestation_usage")
        self.clock += timedelta(days=6)
        self.error(self.call("task.get", {"taskId": "missing"}), "NOT_FOUND")
        self.assertTrue(self.call("tasks.context", secret=False)["ok"])
        wrong = {**self.request("snapshot"), "panelSecret": secrets.token_hex(32), "actor": "owner"}
        self.error(self.call("snapshot", request=wrong, secret=False), "ATTESTATION_FAILED")
        self.assertEqual(self.rows("SELECT * FROM attestation_usage"), before)
        self.clock += timedelta(days=1)
        self.error(self.call("snapshot"), "ATTESTATION_FAILED")

    def test_regular_use_does_not_keep_key_alive_past_maximum_age(self):
        # Ключ используют каждые шесть суток: простой не наступает, но возраст ограничен.
        for _ in range(2):
            self.clock += timedelta(days=6)
            self.assertTrue(self.call("snapshot")["ok"])
        self.clock += timedelta(days=2)
        response = self.call("snapshot")
        self.error(response, "ATTESTATION_FAILED")
        self.assertTrue(response["error"]["message"].startswith("[attestation-expired]"))
        self.assertTrue(self.call("tasks.context", secret=False)["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
