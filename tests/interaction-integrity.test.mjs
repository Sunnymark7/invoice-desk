import assert from 'node:assert/strict';
import test from 'node:test';
import { loadApp, importSynthetic } from './app-harness.mjs';

async function fixture(t) {
  const app = loadApp(); t.after(app.cleanup);
  for (const [id, number, amount] of [['a', '11111111111111111111', '10.00'], ['b', '22222222222222222222', '20.00'], ['c', '33333333333333333333', '30.00']]) {
    await importSynthetic(app, id, number, amount);
  }
  return app;
}

test('search retains hidden selection, current select-all only changes visible records', async t => {
  const app = await fixture(t);
  const ids = app.run('state.records.map(record => record.id)');
  app.context.selectInvoice(ids[0]);
  app.node('reviewSearch').value = 'b.pdf';
  app.context.renderInvoiceTable();
  assert.equal(app.run('selectedRecords.has(state.records[0].id)'), true);
  assert.match(app.node('selectionSummary').textContent, /隐藏 1/);
  assert.equal(app.node('revealSelectionButton').hidden, false);
  app.context.toggleAllVisibleInvoices();
  assert.equal(app.run('selectedRecords.size'), 2);
  app.context.toggleAllVisibleInvoices();
  assert.equal(app.run('selectedRecords.size'), 1);
  assert.equal(app.run('selectedRecords.has(state.records[0].id)'), true);
  app.context.revealSelection();
  assert.equal(app.node('reviewSearch').value, '');
  assert.equal(app.run('visibleInvoiceRecords().length'), 3);
  assert.equal(app.node('revealSelectionButton').hidden, true);
  app.context.clearSelection();
  assert.equal(app.run('selectedRecords.size'), 0);
  assert.equal(app.run('totalAmount(countedRecords())'), 60);
});

test('a deleted selected record is removed from persistent selection', async t => {
  const app = await fixture(t);
  app.run('selectedRecords.add(state.records[0].id);');
  app.context.deletePage(app.run('state.units[0].id'));
  assert.equal(app.run('selectedRecords.size'), 0);
  assert.equal(app.run('state.records.length'), 2);
});

test('filtered review navigation preserves a stable record scope through edits and page changes', async t => {
  const app = await fixture(t);
  app.run("state.records[0].status='review';state.records[2].status='review';reviewFilter='review';state.units.splice(1,0,{...state.units[0],id:'second-page',page:2});");
  const ids = app.run('state.units.map(unit => unit.id)');
  app.context.capturePreviewScope(ids[0]);
  assert.equal(app.run('previewUnits().map(unit => unit.fileId).join()'), 'a,a,c');
  app.run('state.records[0].status="ready";previewState.unitId=state.units[0].id;');
  assert.equal(app.run('previewUnits().length'), 3);
  app.context.updatePreviewNavigation();
  assert.equal(app.node('previewPageTotal').textContent, '/ 3 页');
  assert.equal(app.node('previewScopeBadge').hidden, false);
  let opened;
  app.context.openPreview = id => { opened = id; };
  app.context.stepPreview(1);
  assert.equal(opened, 'second-page');
  app.node('previewPageInput').value = '3';
  app.context.jumpPreviewPage();
  assert.equal(opened, ids[3]);
  app.node('previewPageInput').value = '4';
  app.context.jumpPreviewPage();
  assert.match(app.context.lastToast, /1–3/);
  app.run('previewRecordScope=null;');
  app.context.updatePreviewNavigation();
  assert.equal(app.node('previewPageTotal').textContent, '/ 4 页');
  assert.equal(app.node('previewScopeBadge').hidden, true);
  assert.equal(app.run('state.units.length'), 4);
  assert.equal(app.run('totalAmount(countedRecords())'), 60);
});
