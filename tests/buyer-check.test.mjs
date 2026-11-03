import assert from 'node:assert/strict';
import test from 'node:test';
import { loadApp, importSynthetic, validValues } from './app-harness.mjs';

const invoice = (body, number = '11111111111111111111') => `电子发票 发票号码：${number}\n开票日期：2026年01月01日\n${body}\n（小写）¥21.16`;
const buyerId = '91370000ABCDEFGH12', sellerId = '91440000ABCDEFGH34';

test('recognition separates purchaser from seller in standard, vertical and reversed layouts', t => {
  const app = loadApp(); t.after(app.cleanup);
  for (const body of [
    `名称：测试（青岛）科技有限公司 名称：测试供应商有限公司\n统一社会信用代码/纳税人识别号：${buyerId} 统一社会信用代码/纳税人识别号：${sellerId}`,
    `购 销\n名称：测试（青岛）科技有限公司 名称：测试供应商有限公司\n买 售\n信 ${buyerId} 信 ${sellerId}\n统一社会信用代码/纳税人识别号： 统一社会信用代码/纳税人识别号：`,
    `购买方信息\n名称：测试（青岛）科技有限公司\n纳税人识别号：${buyerId}\n销售方信息\n名称：测试供应商有限公司\n纳税人识别号：${sellerId}`,
    `销售方信息\n名称：测试供应商有限公司\n纳税人识别号：${sellerId}\n购买方信息\n名称：测试（青岛）科技有限公司\n纳税人识别号：${buyerId}`
  ]) {
    const [record] = app.context.parsePages([invoice(body)], '抬头-错误公司.pdf', 'source');
    assert.equal(record.buyer, '测试(青岛)科技有限公司');
    assert.equal(record.buyerTaxId, buyerId);
    assert.equal(record.seller, '测试供应商有限公司');
    assert.equal(record.amount, 21.16);
  }
});

test('a passenger, lone seller or filename is never a purchaser; OCR cannot overwrite native buyer', t => {
  const app = loadApp(); t.after(app.cleanup);
  assert.equal(app.context.extractBuyer('铁路电子客票 乘车人 张某 中国铁路网络有限公司').name, '');
  assert.equal(app.context.extractBuyer('销售方 名称：测试供应商有限公司').name, '');
  const native = invoice('名称：本机测试购买方 名称：测试供应商有限公司');
  const fallback = invoice(`购买方名称：错误购买方\n税号：${buyerId}`);
  const [record] = app.context.parsePages([native], '错误购买方.pdf', 'source', [], [], [fallback]);
  assert.equal(record.buyer, '本机测试购买方');
  assert.equal(record.buyerTaxId, '');
  const [ocrRecord] = app.context.parsePages([invoice('销售方 名称：测试供应商有限公司')], '无关公司.pdf', 'source', [], [], [invoice(`购买方名称：OCR购买单位\n税号：${buyerId}`)]);
  assert.equal(ocrRecord.buyer, 'OCR购买单位');
  assert.equal(ocrRecord.buyerTaxId, buyerId);
  assert.equal(ocrRecord.buyerSource, 'OCR 补充识别');
  assert.equal(app.context.buyerCheckResult({ included: true, buyer: '' }).kind, 'missing');
  assert.equal(app.context.buyerCheckResult({ included: true, buyer: '个人' }, '测试公司').kind, 'personal');
});

test('multi-page buyer recovery, manual correction, draft and detail exports keep buyer fields', async t => {
  const app = loadApp(); t.after(app.cleanup);
  const record = await importSynthetic(app, 'a', '11111111111111111111');
  app.run("state.records[0].buyer='';state.units[0].text='名称：旧草稿购买方 名称：合成测试商户';");
  app.context.recoverBuyerFields(app.run('state.records'), app.run('state.units'));
  assert.equal(record.buyer, '旧草稿购买方');
  const result = app.context.commitRecordChanges(record, { ...validValues(record.number), buyer: '手工购买方', buyerTaxId: buyerId });
  assert.equal(result.ok, true);
  app.context.recoverBuyerFields(app.run('state.records'), app.run('state.units'));
  assert.equal(record.buyer, '手工购买方');
  assert.equal(record.buyerSource, '人工修改');
  assert.equal(app.context.captureDraft().records[0].buyerTaxId, buyerId);
  const detail = app.context.buildDetailSnapshot();
  assert.equal(detail.entries[0].row[9], '手工购买方');
  assert.equal(detail.entries[0].row[10], buyerId);
  assert.equal(app.context.detailRows(detail).at(-1)[5], '10.00');
  const pages = app.context.mergeMultiPageRecords(app.context.parsePages([
    invoice('销售方 名称：测试供应商有限公司') + '\n共2页 第1页',
    invoice(`购买方 名称：续页购买方\n税号：${buyerId}\n销售方 名称：测试供应商有限公司`) + '\n共2页 第2页'
  ], 'source.pdf', 'source'));
  assert.equal(pages.length, 1);
  assert.equal(pages[0].buyer, '续页购买方');
  assert.equal(pages[0].buyerTaxId, buyerId);
});

test('export review compares normalized names and tax IDs without altering amounts or order', async t => {
  const app = loadApp(); t.after(app.cleanup);
  await importSynthetic(app, 'a', '11111111111111111111');
  await importSynthetic(app, 'b', '22222222222222222222');
  app.run(`state.records[0].buyer='测试（青岛）公司';state.records[0].buyerTaxId='${buyerId}';state.records[1].buyer='其他公司';`);
  const record = app.run('state.records[0]');
  assert.equal(app.context.buyerCheckResult(record, ' 测试(青岛)公司 ', buyerId.toLowerCase()).kind, 'matched');
  assert.equal(app.context.buyerCheckResult(record, '', sellerId).kind, 'mismatch');
  assert.equal(app.context.buyerCheckResult({ included: true, buyer: '测试公司' }, '测试公司', buyerId).kind, 'missing');
  assert.equal(app.context.buyerCheckResult({ included: false }, '测试公司', buyerId).kind, 'attachment');
  app.node('buyerCheckDialog').showModal = function () { this.open = true; };
  app.context.openBuyerCheck('pdf');
  assert.equal(app.node('buyerCheckDialog').open, true);
  assert.match(app.node('buyerCheckSummary').textContent, /2 种抬头/);
  app.node('expectedBuyer').value = '测试(青岛)公司';
  app.context.renderBuyerCheck();
  assert.match(app.node('buyerCheckList').innerHTML, /与预期抬头不一致/);
  assert.equal(app.run('state.records.map(record=>record.fileId).join()'), 'a,b');
  assert.equal(app.run('totalAmount(countedRecords())'), 20);
  app.run('selectedRecords.add(state.records[1].id)');
  app.context.openBuyerCheck('pdf', true);
  assert.equal(app.run('buyerCheckState.records.length'), 1);
  assert.equal(app.run('buyerCheckState.records[0].fileId'), 'b');
});
