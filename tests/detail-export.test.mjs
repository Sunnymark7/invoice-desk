import assert from 'node:assert/strict';
import test from 'node:test';
import { loadApp, importSynthetic } from './app-harness.mjs';

test('detail preview and CSV share order, retained invoices and the billable total', async t => {
  const app = loadApp(); t.after(app.cleanup);
  await importSynthetic(app, 'a', '11111111111111111111', '21.16');
  await importSynthetic(app, 'b', '22222222222222222222', '144.29');
  await importSynthetic(app, 'c', '33333333333333333333', '50.00');
  app.run("state.records[0].pages=[1,2];state.units.splice(1,0,{...state.units[0],id:'continuation',page:2});state.records[2].included=false;state.records[2].status='attachment';reviewFilter='review';");
  app.context.moveRecordToPosition(app.run('state.records[1].id'), 1);
  const snapshot = app.context.buildDetailSnapshot();
  const rows = app.context.detailRows(snapshot);
  assert.equal(snapshot.entries.length, 3);
  assert.equal(rows[1][5], '144.29');
  assert.equal(rows[2][5], '21.16');
  assert.equal(rows[3][6], '否');
  assert.equal(rows.at(-1)[5], '165.45');
  const subset = app.context.detailRows(snapshot, new Set([1, 2]));
  assert.equal(subset.length, 4);
  assert.equal(subset[1][0], 2);
  assert.equal(subset.at(-1)[5], '21.16');
  app.run('state.records[0].amount=999');
  await app.context.exportCsv(snapshot);
  assert.equal(await app.context.download.blob.text(), rows.map(row => row.map(app.context.csvCell).join(',')).join('\r\n'));
});

test('selected copying preserves invoice numbers, escapes line breaks and does not change the batch', async t => {
  const app = loadApp(); t.after(app.cleanup);
  await importSynthetic(app, 'a', '01111111111111111111', '21.16');
  await importSynthetic(app, 'b', '22222222222222222222', '144.29');
  app.run("state.records[0].seller='含制表\\t和换行\\n的商户';detailSnapshot=buildDetailSnapshot();detailSelection.add(0);");
  let copied;
  app.context.navigator = { clipboard: { async writeText(text) { copied = text; } } };
  await app.context.copyDetails(true);
  const rows = copied.split('\r\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[1].split('\t').length, 12);
  assert.match(rows[1], /01111111111111111111/);
  assert.doesNotMatch(copied, /22222222222222222222/);
  assert.match(rows[2], /21\.16/);
  assert.match(app.node('detailsCopyStatus').textContent, /已复制 1/);
  assert.equal(app.run('state.records.length'), 2);
  assert.equal(app.run('totalAmount(countedRecords())'), 165.45);
});

test('a blocked clipboard falls back inside the modal and reports an actual failure', async t => {
  const app = loadApp(); t.after(app.cleanup);
  await importSynthetic(app, 'a', '11111111111111111111');
  app.run('detailSnapshot=buildDetailSnapshot()');
  app.context.navigator = { clipboard: { async writeText() { throw new Error('denied'); } } };
  let appended = false, removed = false;
  app.context.document.createElement = () => ({ style: {}, setAttribute() {}, select() { assert.ok(appended); }, remove() { removed = true; } });
  app.node('detailsDialog').append = () => { appended = true; };
  app.context.document.execCommand = () => false;
  await app.context.copyDetails(false);
  assert.ok(removed);
  assert.match(app.node('detailsCopyStatus').textContent, /复制未成功/);
  app.context.document.execCommand = () => true;
  await app.context.copyDetails(false);
  assert.match(app.node('detailsCopyStatus').textContent, /已复制 1/);
});
