import assert from 'node:assert/strict';
import test from 'node:test';
import { loadApp, importSynthetic } from './app-harness.mjs';

const invoiceText = (number, amount, date = '2026年01月01日') => `电子发票 发票号码：${number}\n开票日期：${date}\n名称：测试购买方 名称：合成测试商户\n（小写）¥${amount}`;

test('OCR fills missing fields while preserving valid native fields', t => {
  const app = loadApp(); t.after(app.cleanup);
  const native = invoiceText('11111111111111111111', '21.16', '');
  const ocr = invoiceText('22222222222222222222', '99.00', '2026年02月03日');
  assert.equal(app.context.needsOcrRecognition(native), true);
  assert.equal(app.context.needsOcrRecognition(invoiceText('11111111111111111111', '21.16')), false);
  const [record] = app.context.parsePages([native], 'wrong-price-9999.pdf', 'source', [], [], [ocr]);
  assert.equal(record.amount, 21.16);
  assert.equal(record.number, '11111111111111111111');
  assert.equal(record.date, '2026-02-03');
  assert.equal(record.seller, '合成测试商户');
  assert.equal(record.amountSource, '票面自动提取');
});

test('an unreadable amount uses OCR evidence and unnumbered invoices stay pending', t => {
  const app = loadApp(); t.after(app.cleanup);
  const native = invoiceText('11111111111111111111', '?');
  const [record] = app.context.parsePages([native], 'wrong-price-9999.pdf', 'source', [], [], [invoiceText('11111111111111111111', '21.16')]);
  assert.equal(record.amount, 21.16);
  assert.equal(record.amountSource, 'OCR 补充识别');
  const missing = invoiceText('', '21.16');
  assert.equal(app.context.needsOcrRecognition(missing), true);
  const [pending] = app.context.mergeMultiPageRecords(app.context.parsePages([missing], 'source.pdf', 'source'));
  assert.equal(pending.status, 'review');
  assert.equal(app.context.needsOcrRecognition('个人登机凭证 航班 MU5103'), false);
});

test('a price in an unrelated screenshot cannot become a billable invoice', t => {
  const app = loadApp(); t.after(app.cleanup);
  const [record] = app.context.parsePages(['酒店商品价格 ¥999.00 日期 2026年01月01日'], '发票-999元.pdf', 'source');
  assert.equal(record.included, false);
  assert.equal(record.amount, null);
  assert.equal(record.status, 'review');
});

test('replacement retains position, all new pages and undo, without disturbing other invoices', async t => {
  const app = loadApp(); t.after(app.cleanup);
  const original = await importSynthetic(app, 'old', '11111111111111111111', '10.00');
  const other = await importSynthetic(app, 'other', '22222222222222222222', '20.00');
  app.context.pdfjsLib.getDocument = () => ({ promise: Promise.resolve({ numPages: 2, getPage: async () => ({}) }) });
  app.context.processFile = async (item, index, count, batch) => {
    await app.context.processPdfBytes(item, new Uint8Array([2]), index, count, [
      invoiceText('33333333333333333333', '30.00') + '\n共2页 第1页',
      invoiceText('33333333333333333333', '30.00') + '\n共2页 第2页'
    ], batch);
  };
  await app.context.replaceInvoice(original.id, { name: 'replacement.pdf', type: 'application/pdf' });
  assert.equal(app.run('state.records.length'), 2);
  assert.equal(app.run('state.units.length'), 3);
  assert.equal(app.run('state.records[0].amount'), 30);
  assert.equal(app.run('state.records[0].confirmed'), false);
  assert.equal(app.run('totalAmount(countedRecords())'), 50);
  assert.equal(app.run('state.records[1].id'), other.id);
  assert.equal(app.run('orderMode'), 'manual');
  assert.equal(app.run('captureDraft().deletedPages[0].kind'), 'replace');
  app.context.undoPageDelete();
  assert.equal(app.run('state.units.length'), 2);
  assert.equal(app.run('state.records[0].fileId'), 'old');
  assert.equal(app.run('totalAmount(countedRecords())'), 30);
});

test('duplicate or unreadable replacement leaves current invoice and total intact', async t => {
  const app = loadApp(); t.after(app.cleanup);
  const original = await importSynthetic(app, 'old', '11111111111111111111', '10.00');
  await importSynthetic(app, 'other', '22222222222222222222', '20.00');
  app.context.processFile = async (item, index, count, batch) => app.context.processPdfBytes(item, new Uint8Array([2]), index, count, [invoiceText('22222222222222222222', '20.00')], batch);
  await app.context.replaceInvoice(original.id, { name: 'duplicate.pdf', type: 'application/pdf' });
  assert.equal(app.run('totalAmount(countedRecords())'), 30);
  assert.equal(app.run('state.files.length'), 2);
  assert.equal(app.run('deletedPages.length'), 0);
  assert.match(app.context.lastToast, /原发票已保留.*重复/);
  app.context.processFile = async () => { throw new Error('读取失败'); };
  await app.context.replaceInvoice(original.id, { name: 'broken.pdf', type: 'application/pdf' });
  assert.equal(app.run('totalAmount(countedRecords())'), 30);
  assert.equal(app.run('state.busy'), false);
});

test('one-click clear removes records, undo, selection and queued local draft', async t => {
  const app = loadApp(); t.after(app.cleanup);
  await importSynthetic(app, 'old', '11111111111111111111', '10.00');
  app.run('selectedRecords.add(state.records[0].id); deletedPages.push({kind:"batch",records:[],entries:[]});');
  let deleted = 0;
  app.context.deleteDraft = async () => { deleted += 1; };
  app.context.clearAll();
  await app.run('draftWrites');
  assert.equal(app.run('state.files.length + state.records.length + state.units.length + selectedRecords.size + deletedPages.length'), 0);
  assert.equal(app.run('totalAmount(countedRecords())'), 0);
  assert.equal(deleted, 1);
  assert.equal(app.run('draftDirty'), false);
});

test('review shortcut clears a conflicting search without changing bill totals or export scope', async t => {
  const app = loadApp(); t.after(app.cleanup);
  const pending = await importSynthetic(app, 'pending', '11111111111111111111', '10.00');
  await importSynthetic(app, 'ready', '22222222222222222222', '20.00');
  pending.status = 'review';
  app.node('reviewSearch').value = 'does-not-match';
  app.context.focusPendingReviews();
  assert.equal(app.node('reviewSearch').value, '');
  assert.equal(app.run('visibleInvoiceRecords().length'), 1);
  assert.equal(app.run('visibleInvoiceRecords()[0].id'), pending.id);
  assert.equal(app.run('totalAmount(countedRecords())'), 30);
  assert.equal(app.run('state.units.length'), 2);
  app.context.render();
  assert.equal(app.node('totalHint').textContent, '含待核对金额');
  assert.equal(app.node('reviewPendingButton').disabled, false);
  pending.status = 'ready';
  app.context.render();
  assert.equal(app.node('totalHint').hidden, true);
  assert.equal(app.node('reviewPendingButton').disabled, true);
});
