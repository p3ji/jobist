"""Exercise the allowance trigger with concurrent SQLite writers."""

import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path


MIGRATION = Path(__file__).resolve().parents[1] / "migrations/0001_monetization.sql"
RESERVE = """INSERT INTO actions(id,account_id,entitlement_id,kind,idempotency_key,input_digest,status,reserved_at,lease_expires_at)
SELECT ?,account_id,id,?,?,?,'reserved',?,? FROM entitlements
WHERE account_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) AND scans_remaining>0
ORDER BY expires_at IS NULL,expires_at LIMIT 1 ON CONFLICT(account_id,kind,idempotency_key) DO NOTHING"""


class AllowanceSqlTests(unittest.TestCase):
    def test_last_scan_is_spent_once_and_release_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ledger.sqlite"
            setup = sqlite3.connect(path)
            setup.executescript(MIGRATION.read_text())
            setup.execute("INSERT INTO accounts(id,email,created_at) VALUES('a','a@example.com',1)")
            setup.execute("""INSERT INTO entitlements(id,account_id,kind,granted_at,scans_total,scans_remaining,packets_total,packets_remaining)
                VALUES('free','a','free',1,5,1,5,5)""")
            setup.commit()
            setup.close()

            barrier = threading.Barrier(2)
            results = []

            def spend(index):
                connection = sqlite3.connect(path, timeout=5)
                barrier.wait()
                cursor = connection.execute(RESERVE, (f"action-{index}", "scan", f"key-{index}", "d" * 64, 2, 902, "a", 2))
                connection.commit()
                results.append(cursor.rowcount)
                connection.close()

            threads = [threading.Thread(target=spend, args=(index,)) for index in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual(sorted(results), [0, 1])

            check = sqlite3.connect(path)
            self.assertEqual(check.execute("SELECT scans_remaining FROM entitlements").fetchone()[0], 0)
            self.assertEqual(check.execute("SELECT count(*) FROM actions").fetchone()[0], 1)
            check.execute("UPDATE actions SET status='released' WHERE status='reserved'")
            check.execute("UPDATE actions SET status='released' WHERE status='reserved'")
            self.assertEqual(check.execute("SELECT scans_remaining FROM entitlements").fetchone()[0], 1)
            check.close()


if __name__ == "__main__":
    unittest.main()
