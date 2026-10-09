#!/usr/bin/env python3
"""Эпохи независимы; явный отзыв требует ключ именно отзываемой привязки."""
import secrets
import unittest
from support import Harness


class RevocationTests(Harness):
    def signed(self, op, session, secret, cwd=None, key=None, actor="owner", args=None):
        return {**self.request(op, args, session=session, cwd=cwd, key=key), "panelSecret": secret, "actor": actor}

    def test_new_epoch_preserves_base_and_old_epoch_including_cached_replay(self):
        base, epoch1, epoch2 = "conversation", "conversation.cockpit-1-1234abcd", "conversation.cockpit-2-5678abcd"
        keys = {session: secrets.token_hex(32) for session in (base, epoch1, epoch2)}
        requests = []
        for session in (base, epoch1):
            self.assertTrue(self.invoke(self.signed("session.attest", session, keys[session]))["ok"])
            request = self.signed("snapshot", session, keys[session])
            self.assertTrue(self.invoke(request)["ok"])
            requests.append(request)
        fingerprints = self.rows("SELECT * FROM session_attestations")
        self.assertTrue(self.invoke(self.signed("session.attest", epoch2, keys[epoch2]))["ok"])
        before = self.rows("SELECT * FROM requests")
        for request in requests:
            self.assertTrue(self.invoke(request)["ok"])
            self.assertTrue(self.invoke(request)["ok"])
        self.assertEqual(self.rows("SELECT * FROM requests"), before)
        self.assertEqual(self.rows("SELECT * FROM session_attestations")[:2], fingerprints)
        self.assertEqual(len(self.rows("SELECT * FROM attestation_revocations")), 0)
        events = self.rows("SELECT * FROM events WHERE kind='security.attestation-revoked-use'")
        self.assertEqual(len(events), 0)
        self.assertNotIn("secret", str(events))
        self.assertTrue(self.invoke(self.signed("session.attest", epoch1, keys[epoch1]))["ok"])
        self.assertTrue(self.invoke(self.signed("session.attest", "conversation.cockpit-1-aaaabbbb", secrets.token_hex(32)))["ok"])
        self.assertTrue(self.invoke(self.signed("session.attest", base, keys[base]))["ok"])
        for session in (base, epoch1):
            response = self.invoke(self.signed("tasks.agent.create", session, keys[session], actor="agent", args={"tasks": [{"title": f"Работа {session}"}]}))
            self.assertTrue(response["ok"])
        self.assertEqual(self.ok("doctor")["counts"]["attestation_revocations"], 0)

    def test_other_base_and_other_worktree_survive_revocation(self):
        other = self.linked_worktrees()
        key1, key2, key_other = (secrets.token_hex(32) for _ in range(3))
        first, second = "owner.cockpit-1-1234abcd", "owner.cockpit-2-5678abcd"
        for session, key, cwd in ((first, key1, self.cwd), (first, key1, other), ("owner-extra", key_other, self.cwd)):
            self.assertTrue(self.invoke(self.signed("session.attest", session, key, cwd))["ok"])
        self.assertTrue(self.invoke(self.signed("session.attest", second, key2))["ok"])
        self.assertTrue(self.invoke(self.signed("session.revoke", first, key1))["ok"])
        self.assertTrue(self.invoke(self.signed("snapshot", first, key1, other))["ok"])
        self.assertTrue(self.invoke(self.signed("snapshot", "owner-extra", key_other))["ok"])
        self.error(self.invoke(self.signed("snapshot", first, key1)), "ATTESTATION_FAILED")

    def test_explicit_revoke_rejects_cached_replay_without_changing_witness(self):
        secret = secrets.token_hex(32)
        self.assertTrue(self.invoke(self.signed("session.attest", "owner", secret))["ok"])
        replay = self.signed("snapshot", "owner", secret)
        self.assertTrue(self.invoke(replay)["ok"])
        before = self.rows("SELECT * FROM session_attestations")
        self.assertEqual(self.invoke(self.signed("session.revoke", "owner", secret))["result"], {"revoked": True})
        for _ in range(2):
            response = self.invoke(replay)
            self.error(response, "ATTESTATION_FAILED")
            self.assertTrue(response["error"]["message"].startswith("[attestation-revoked]"))
        self.assertEqual(self.rows("SELECT * FROM session_attestations"), before)
        self.assertEqual(len(self.rows("SELECT * FROM attestation_revocations")), 1)
        self.assertEqual(len(self.rows("SELECT * FROM events WHERE kind='security.attestation-revoked-use'")), 1)
        self.error(self.invoke(self.signed("session.attest", "owner", secret)), "ATTESTATION_CONFLICT")

    def test_revoke_without_key_wrong_or_foreign_key_and_agent_cannot_revoke(self):
        own, foreign = secrets.token_hex(32), secrets.token_hex(32)
        self.assertTrue(self.invoke(self.signed("session.attest", "owner", own))["ok"])
        self.assertTrue(self.invoke(self.signed("session.attest", "foreign", foreign))["ok"])
        before = self.rows("SELECT * FROM session_attestations")
        for request in (self.request("session.revoke", session="owner"),
                        {**self.request("session.revoke", session="owner"), "actor": "owner"},
                        self.signed("session.revoke", "owner", secrets.token_hex(32)),
                        self.signed("session.revoke", "owner", foreign)):
            self.error(self.invoke(request), "ATTESTATION_FAILED")
        self.error(self.invoke(self.signed("session.revoke", "owner", own, actor="agent")), "INVALID_REQUEST")
        implicit_owner = self.signed("session.revoke", "owner", own)
        del implicit_owner["actor"]
        self.error(self.invoke(implicit_owner), "INVALID_REQUEST")
        self.assertEqual(self.rows("SELECT * FROM attestation_revocations"), [])
        self.assertEqual(self.rows("SELECT * FROM session_attestations"), before)
        self.assertTrue(self.invoke(self.signed("snapshot", "owner", own))["ok"])

    def test_preexisting_revocation_remains_effective(self):
        import sqlite3
        secret = secrets.token_hex(32)
        self.assertTrue(self.invoke(self.signed("session.attest", "old", secret))["ok"])
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("INSERT INTO attestation_revocations SELECT session_id,project_id,worktree_id,'owner',session_id,created_at FROM session_attestations")
        self.assertTrue(self.invoke(self.signed("session.attest", "old.cockpit-9-1234abcd", secrets.token_hex(32)))["ok"])
        self.error(self.invoke(self.signed("snapshot", "old", secret)), "ATTESTATION_FAILED")


if __name__ == "__main__":
    unittest.main(verbosity=2)
