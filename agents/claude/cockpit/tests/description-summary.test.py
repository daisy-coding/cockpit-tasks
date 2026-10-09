#!/usr/bin/env python3
"""Сводка не меняет поручение, маскируется и считается один раз по содержимому."""
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from agent_support import AgentHarness


class DescriptionSummaryTests(AgentHarness):
    def test_usage_survives_restart_and_duplicate_report_does_not_replace_it(self):
        card = self.create()
        claim = self.claim(card)
        args = {'taskId': card['taskId'], 'descriptionHash': claim['descriptionHash'],
                'summary': 'Исправить перенос строк в карточке задачи.',
                'metrics': {'durationMs': 123, 'inputTokens': 120, 'outputTokens': 20,
                            'cacheReadTokens': 0, 'cacheCreationTokens': 0}}
        self.signed('task.summary.report', args, actor='owner')
        with sqlite3.connect(self.state / 'cockpit.db') as db:
            self.assertEqual(db.execute('SELECT duration_ms,input_tokens,output_tokens FROM task_description_summaries').fetchone(), (123, 120, 20))
        args['metrics']['inputTokens'] = 999
        self.signed('task.summary.report', args, actor='owner')
        self.assertEqual(self.rows('SELECT input_tokens FROM task_description_summaries')[0]['input_tokens'], 120)
        args['metrics']['inputTokens'] = 'PRIVATE SECRET'
        self.error(self.signed_response('task.summary.report', args, actor='owner'), 'INVALID_REQUEST')

    def create(self, description=None):
        return self.owner_task(description=description or ('Исправить перенос строк в карточке задачи. ' * 12))

    def claim(self, card):
        return self.signed('task.summary.claim', {'taskId': card['taskId'], 'expectedRevision': card['revision']}, actor='owner')

    def report(self, card, claim, summary):
        return self.signed('task.summary.report', {'taskId': card['taskId'], 'descriptionHash': claim['descriptionHash'], 'summary': summary}, actor='owner')

    def test_once_per_description_survives_new_rpc_keys_and_unrelated_edits(self):
        card = self.create()
        first = self.claim(card)
        self.assertTrue(first['claimed'])
        self.assertFalse(self.claim(card)['claimed'])
        result = self.report(card, first, 'Исправить перенос строк в карточке задачи.')
        self.assertEqual(result['summary'], 'Исправить перенос строк в карточке задачи.')
        full = self.card(card['taskId'])
        self.assertEqual(full['description'], card['description'])
        self.assertEqual(full['revision'], card['revision'])
        self.assertEqual(full['summary'], result['summary'])
        changed = self.signed('task.edit', {'taskId': card['taskId'], 'expectedRevision': card['revision'], 'title': 'Новое название'}, actor='owner')['task']
        self.assertFalse(self.claim(changed)['claimed'])
        changed = self.signed('task.edit', {'taskId': card['taskId'], 'expectedRevision': changed['revision'], 'description': 'Добавить поиск комментариев в списке задач. ' * 12}, actor='owner')['task']
        self.assertNotIn('summary', changed)
        self.assertTrue(self.claim(changed)['claimed'])
        self.assertIsNone(self.report(card, first, 'Исправить перенос строк.')['summary'])

    def test_short_descriptions_and_failed_attempts_do_not_retry(self):
        self.assertFalse(self.claim(self.create('Короткое описание'))['claimed'])
        card = self.create()
        claimed = self.claim(card)
        self.assertIsNone(self.report(card, claimed, None)['summary'])
        self.assertFalse(self.claim(card)['claimed'])
        self.assertNotIn('summary', self.card(card['taskId']))
        self.assertIsNone(self.report(card, claimed, 'Исправить перенос строк.')['summary'])

    def test_concurrent_claims_have_one_winner_and_stale_revision_is_refused(self):
        card = self.create()
        with ThreadPoolExecutor(max_workers=2) as pool:
            claims = list(pool.map(lambda _: self.claim(card), range(2)))
        self.assertEqual(sum(result['claimed'] for result in claims), 1)
        self.assertEqual(len(self.rows('SELECT * FROM task_description_summaries')), 1)
        self.error(self.signed_response('task.summary.claim', {'taskId': card['taskId'], 'expectedRevision': card['revision'] + 1}, actor='owner'), 'REVISION_CONFLICT')

    def test_report_from_another_session_is_refused(self):
        card = self.create()
        claim = self.claim(card)
        self.signed('session.attest', actor='owner', session='other')
        self.error(self.signed_response('task.summary.report', {'taskId': card['taskId'], 'descriptionHash': claim['descriptionHash'], 'summary': 'Исправить перенос строк.'}, actor='owner', session='other'), 'ATTESTATION_FAILED')

    def test_mask_before_model_and_before_summary_output(self):
        card = self.create()
        secret = 'gh' + 'p_' + 'q' * 36
        text = 'Исправить перенос строк в карточке задачи. ' * 10 + secret
        with sqlite3.connect(self.state / 'cockpit.db') as db:
            db.execute('UPDATE tasks SET description=? WHERE task_id=?', (text, card['taskId']))
        claimed = self.claim(card)
        self.assertEqual(claimed['description'], self.card(card['taskId'])['description'])
        self.assertNotIn(secret, claimed['description'])
        output = self.report(card, claimed, 'Исправить перенос строк ' + secret + '.')
        self.assertNotIn(secret, output['summary'])
        self.assertNotIn(secret, self.rows('SELECT summary FROM task_description_summaries')[0]['summary'])

    def test_unrelated_empty_long_or_incomplete_output_is_not_used(self):
        for text in ('', 'а' * 301, 'Погода на море прекрасная.', 'Исправить перенос строк…'):
            card = self.create('Исправить перенос строк в карточке задачи. ' * 10 + str(len(text)))
            with self.subTest(text=text):
                claimed = self.claim(card)
                self.assertIsNone(self.report(card, claimed, text)['summary'])
                self.assertFalse(self.claim(card)['claimed'])

    def test_queue_and_working_rows_carry_summary_without_detail_read(self):
        current = self.create()
        queued = self.create('Добавить поиск комментариев в списке задач. ' * 10)
        for card, text in ((current, 'Исправить перенос строк в карточке задачи.'), (queued, 'Добавить поиск комментариев в списке задач.')):
            self.report(card, self.claim(card), text)
        page = self.ok('tasks.page', {'list': 'queue', 'offset': 0, 'limit': 30, 'preview': 300})
        self.assertEqual(page['tasks'][0]['summary'], 'Добавить поиск комментариев в списке задач.')
        self.signed('focus.detour', {'expectedRevision': self.ok('focus.get')['revision'], 'taskId': queued['taskId']}, actor='owner')
        snapshot = self.ok('snapshot', {'limits': {'tasks': 0, 'preview': 300}})
        self.assertEqual(snapshot['workingTasks'][0]['summary'], 'Исправить перенос строк в карточке задачи.')

    def test_only_attested_panel_may_claim_and_agent_cannot_write_summary(self):
        card = self.create()
        args = {'taskId': card['taskId'], 'expectedRevision': card['revision']}
        self.error(self.invoke(self.request('task.summary.claim', args)), 'ATTESTATION_FAILED')
        self.error(self.signed_response('task.summary.claim', args), 'INVALID_REQUEST')


if __name__ == '__main__':
    unittest.main(verbosity=2)
