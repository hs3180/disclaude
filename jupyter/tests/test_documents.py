import copy
import asyncio
import unittest
from unittest.mock import AsyncMock

from jupyter_ydoc import YNotebook

from disclaude_jupyter.documents import Documents, RoomLease, RoomPeer, revision
from tornado.web import HTTPError


class DocumentRevisionTests(unittest.TestCase):
    def setUp(self):
        self.content = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [
            {"id": "code", "cell_type": "code", "source": "print('中文 🧪')",
             "metadata": {"custom": "keep"}, "execution_count": None, "outputs": []},
            {"id": "human", "cell_type": "markdown", "source": "Human text",
             "metadata": {}, "attachments": {"image": {"image/png": "owned"}}},
        ]}

    def document(self, value):
        document = YNotebook()
        document.set(copy.deepcopy(value))
        return document

    def test_cold_load_and_dirty_bookkeeping_do_not_invalidate_content_revision(self):
        first = self.document(self.content)
        second = self.document(self.content)
        self.assertNotEqual(first.ydoc.get_state(), second.ydoc.get_state())
        self.assertEqual(revision(first), revision(second))
        first.dirty = True
        self.assertEqual(revision(first), revision(second))

    def test_full_notebook_edits_invalidate_revision(self):
        original = revision(self.document(self.content))
        variants = []
        source = copy.deepcopy(self.content)
        source["cells"][0]["source"] += "\nprint(2)"
        variants.append(source)
        metadata = copy.deepcopy(self.content)
        metadata["cells"][0]["metadata"]["custom"] = "human edit"
        variants.append(metadata)
        attachment = copy.deepcopy(self.content)
        attachment["cells"][1]["attachments"]["image"]["image/png"] = "new"
        variants.append(attachment)
        output = copy.deepcopy(self.content)
        output["cells"][0]["outputs"] = [{"output_type": "stream", "name": "stdout", "text": "new\n"}]
        variants.append(output)
        reordered = copy.deepcopy(self.content)
        reordered["cells"].reverse()
        variants.append(reordered)
        for value in variants:
            with self.subTest(value=value):
                self.assertNotEqual(original, revision(self.document(value)))

    def test_revision_read_does_not_deduplicate_or_mutate_shared_cell_ids(self):
        value = copy.deepcopy(self.content)
        value["cells"][1]["id"] = "code"
        document = self.document(value)
        state = document.ydoc.get_state()
        revision(document)
        self.assertEqual(document.ydoc.get_state(), state)
        self.assertEqual([cell["id"] for cell in document.ycells], ["code", "code"])


class DocumentLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def documents(self, rtc=None):
        documents = Documents(rtc, None, None, None, idle_seconds=0, max_rooms=1)
        documents.locate = lambda value: value
        return documents

    def notebook(self, document_id):
        return {"identity": {"documentId": document_id}, "contentPath": document_id + ".ipynb"}

    def entry(self, document_id):
        peer = RoomPeer("json:notebook:" + document_id)
        return RoomLease(document_id, None, None, peer, asyncio.create_task(peer.closed.wait()))

    async def test_failed_cold_load_releases_reservation_and_mutex(self):
        rtc = type("RTC", (), {"get_document": AsyncMock(side_effect=RuntimeError("load failed"))})()
        documents = self.documents(rtc)
        with self.assertRaisesRegex(RuntimeError, "load failed"):
            await documents.acquire(self.notebook("first"))
        self.assertEqual(documents.pending_rooms, set())
        self.assertEqual(documents.locks, {})
        self.assertEqual(documents.lock_users, {})

    async def test_parallel_cold_loads_respect_the_room_limit(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def load(**kwargs):
            started.set()
            await release.wait()
            raise RuntimeError("owned load failure")
        rtc = type("RTC", (), {"get_document": AsyncMock(side_effect=load)})()
        documents = self.documents(rtc)
        first = asyncio.create_task(documents.acquire(self.notebook("first")))
        await started.wait()
        with self.assertRaises(HTTPError) as error:
            await documents.acquire(self.notebook("second"))
        self.assertEqual(error.exception.status_code, 429)
        self.assertEqual(documents.pending_rooms, {"first"})
        release.set()
        with self.assertRaisesRegex(RuntimeError, "owned load failure"):
            await first
        self.assertEqual(documents.pending_rooms, set())
        self.assertEqual(documents.locks, {})

    async def test_save_failure_retains_state_with_visible_bounded_retry(self):
        documents = self.documents()
        entry = self.entry("first")
        documents.leases["first"] = entry
        documents.save = AsyncMock(side_effect=RuntimeError("save not confirmed"))
        await documents._expire(entry)
        self.assertIs(documents.leases["first"], entry)
        self.assertFalse(entry.peer.closed.is_set())
        self.assertEqual(documents.cleanup_errors["first"], "save not confirmed")
        self.assertIsNotNone(entry.cleaner)
        self.assertFalse(entry.cleaner.done())
        with self.assertRaises(ExceptionGroup):
            await documents.close()
        self.assertTrue(entry.peer.closed.is_set())
        self.assertTrue(entry.task.done())
        self.assertEqual(documents.leases, {})

    async def test_shutdown_closes_every_peer_after_an_unconfirmed_save(self):
        documents = self.documents()
        entries = [self.entry("first"), self.entry("second")]
        documents.leases = {entry.document_id: entry for entry in entries}
        documents.save = AsyncMock(side_effect=[RuntimeError("first save failed"), None])
        with self.assertRaises(ExceptionGroup):
            await documents.close()
        self.assertTrue(all(entry.peer.closed.is_set() and entry.task.done() for entry in entries))
        self.assertEqual(documents.leases, {})
        self.assertEqual(documents.locks, {})

    async def test_failure_history_is_bounded(self):
        documents = self.documents()
        documents.cleanup_failed("first", RuntimeError("one"))
        documents.cleanup_failed("second", RuntimeError("two"))
        self.assertEqual(dict(documents.cleanup_errors), {"second": "two"})


if __name__ == "__main__":
    unittest.main()
