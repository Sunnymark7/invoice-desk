import assert from 'node:assert/strict';
import test from 'node:test';
import { loadApp, importSynthetic } from './app-harness.mjs';

test('moving a list row moves every page of the same invoice and changes export order', async t => {
  const app = loadApp(); t.after(app.cleanup);
  await importSynthetic(app, 'a', '11111111111111111111');
  await importSynthetic(app, 'b', '22222222222222222222');
  app.run("state.records[0].pages=[1,2];state.units.splice(1,0,{...state.units[0],id:'continuation',page:2});");
  const from = app.run('state.units[2].id'), to = app.run('state.units[0].id');
  assert.equal(app.context.moveGroupBefore(from, to), true);
  assert.equal(app.run('state.units.map(unit=>unit.fileId).join()'), 'b,a,a');
  assert.equal(app.run('state.records.map(record=>record.fileId).join()'), 'b,a');
  app.context.moveInvoiceGroup(app.run('state.units[1].id'), -1);
  assert.equal(app.run('state.units.map(unit=>unit.page).join()'), '1,2,1');
  assert.equal(app.node('sortModeSelect').value, 'manual');
  assert.equal(app.run('totalAmount(countedRecords())'), 20);
});

test('filtering the unified list does not change CSV or page export order', async t => {
  const app = loadApp(); t.after(app.cleanup);
  await importSynthetic(app, 'a', '11111111111111111111', '10.00');
  await importSynthetic(app, 'b', '22222222222222222222', '20.00');
  app.context.moveGroupBefore(app.run('state.units[1].id'), app.run('state.units[0].id'));
  app.node('reviewSearch').value = 'not-present';
  app.context.renderInvoiceTable();
  assert.match(app.node('invoiceBody').innerHTML, /没有匹配/);
  await app.context.exportCsv();
  const csv = await app.context.download.blob.text();
  assert.ok(csv.indexOf('22222222222222222222') < csv.indexOf('11111111111111111111'));
  assert.match(csv, /30\.00/);
  assert.equal(app.run('state.units.length'), 2);
});

test('successful draft saves stay quiet while storage failures remain visible', async t => {
  const app = loadApp(); t.after(app.cleanup);
  await importSynthetic(app, 'a', '11111111111111111111');
  await app.context.flushDraftSave();
  assert.equal(app.node('storageWarning').hidden, true);
  app.context.saveDraft = async () => { throw new Error('quota'); };
  app.context.scheduleDraftSave();
  await app.context.flushDraftSave();
  assert.equal(app.node('storageWarning').hidden, false);
  assert.match(app.node('storageWarning').textContent, /保存失败/);
});

test('moving down to a numbered position keeps all pages, totals and CSV order consistent', async t => {
  const app = loadApp(); t.after(app.cleanup);
  const first = await importSynthetic(app, 'a', '11111111111111111111', '10.00');
  await importSynthetic(app, 'b', '22222222222222222222', '20.00');
  await importSynthetic(app, 'c', '33333333333333333333', '30.00');
  app.run("state.records[0].pages=[1,2];state.units.splice(1,0,{...state.units[0],id:'continuation',page:2});layoutMode='grid';");
  assert.equal(app.context.moveRecordToPosition(first.id, 3), true);
  assert.equal(app.run('state.records.map(record=>record.fileId).join()'), 'b,c,a');
  assert.equal(app.run('state.units.map(unit=>unit.fileId).join()'), 'b,c,a,a');
  assert.equal(app.run('totalAmount(countedRecords())'), 60);
  assert.equal(app.context.captureDraft().layoutMode, 'grid');
  await app.context.exportCsv();
  const csv = await app.context.download.blob.text();
  assert.ok(csv.indexOf('33333333333333333333') < csv.indexOf('11111111111111111111'));
  assert.equal(app.context.moveRecordToPosition(first.id, 0), false);
  assert.equal(app.context.moveRecordToPosition(first.id, 1.5), false);
  assert.equal(app.run('state.units.length'), 4);
  app.run('state.exporting=true');
  assert.equal(app.context.moveRecordToPosition(first.id, 1), false);
});
