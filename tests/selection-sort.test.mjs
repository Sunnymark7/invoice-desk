import assert from 'node:assert/strict';
import test from 'node:test';
import { loadApp, importSynthetic } from './app-harness.mjs';

test('imports preserve input order by default and sort later additions only after explicit date sorting', async t => {
  const app = loadApp(); t.after(app.cleanup);
  app.context.processFile = async (item, index, count) => {
    const text = `电子发票 发票号码：${item.file.number}\n开票日期：${item.file.date}\n名称：购买方 名称：合成测试商户\n（小写）¥10.00`;
    await app.context.processPdfBytes(item, new Uint8Array([1]), index, count, [text]);
  };
  const file = (name, number, date) => ({ name, type: 'application/pdf', number, date });
  await app.context.addFiles([file('late.pdf', '11111111111111111111', '2026年03月01日'), file('early.pdf', '22222222222222222222', '2026年02月01日')]);
  assert.equal(app.run('state.records.map(record=>record.source).join()'), 'late.pdf,early.pdf');
  assert.equal(app.node('sortModeSelect').value, 'import');
  await app.context.addFiles([file('earliest.pdf', '33333333333333333333', '2026年01月01日')]);
  assert.equal(app.run('state.records.map(record=>record.source).join()'), 'late.pdf,early.pdf,earliest.pdf');
  app.context.sortByInvoiceDate(true);
  await app.context.addFiles([file('middle.pdf', '44444444444444444444', '2026年02月15日')]);
  assert.equal(app.run('state.records.map(record=>record.source).join()'), 'earliest.pdf,early.pdf,middle.pdf,late.pdf');
  assert.equal(app.run('totalAmount(countedRecords())'), 40);
});

async function fixture(t) {
  const app = loadApp(); t.after(app.cleanup);
  for (const [id, number] of [['a','11111111111111111111'],['b','22222222222222222222'],['c','33333333333333333333'],['d','44444444444444444444']]) await importSynthetic(app, id, number);
  return app;
}

test('empty state has only the import surface and imports replace it with workspace tools', async t => {
  const app = loadApp(); t.after(app.cleanup);
  app.context.renderBatchSurface();
  assert.equal(app.node('uploadPanel').hidden, false);
  assert.equal(app.node('resultsPanel').hidden, true);
  assert.equal(app.node('appHeader').hidden, true);
  await importSynthetic(app,'a','11111111111111111111');
  app.context.renderBatchSurface();
  assert.equal(app.node('uploadPanel').hidden, true);
  assert.equal(app.node('resultsPanel').hidden, false);
  assert.equal(app.node('batchTools').hidden, false);
});

test('Ctrl toggles selection, Shift selects a range, and group moves preserve pages and export order', async t => {
  const app = await fixture(t);
  const ids = app.run('state.records.map(record=>record.id)');
  app.context.selectInvoice(ids[0]);
  app.context.selectInvoice(ids[2], { ctrlKey: true });
  assert.equal(app.run('selectedRecords.size'), 2);
  app.run("state.records[0].pages=[1,2];state.units.splice(1,0,{...state.units[0],id:'continuation',page:2});");
  assert.equal(app.context.moveSelectedRecordsToTarget(ids[0],ids[3]), true);
  assert.equal(app.run('state.records.map(record=>record.fileId).join()'), 'b,d,a,c');
  assert.equal(app.run('state.units.map(unit=>unit.fileId).join()'), 'b,d,a,a,c');
  assert.equal(app.run('totalAmount(countedRecords())'), 40);
  await app.context.exportCsv();
  const csv = await app.context.download.blob.text();
  assert.ok(csv.indexOf('44444444444444444444') < csv.indexOf('11111111111111111111'));
  app.context.selectInvoice(ids[1]);
  app.context.selectInvoice(ids[0], { shiftKey: true });
  assert.equal(app.run('selectedRecords.size'),3);
  app.context.selectInvoice(ids[3], { ctrlKey:true });
  assert.equal(app.run('selectedRecords.size'),2);
});

test('rectangle selection can replace or add to a selection without affecting totals', async t => {
  const app = await fixture(t);
  const ids = app.run('state.records.map(record=>record.id)');
  const boxes = Array.from(ids, (id,index)=>({id,left:index*100,right:index*100+80,top:0,bottom:100}));
  app.context.selectInvoicesInRect({left:90,right:290,top:10,bottom:90},boxes);
  assert.equal(app.run('selectedRecords.size'),2);
  app.context.selectInvoicesInRect({left:0,right:80,top:10,bottom:90},boxes,[ids[3]]);
  assert.equal(app.run('selectedRecords.size'),2);
  assert.equal(app.run('totalAmount(countedRecords())'),40);
});

test('date and Chinese company sorting keep multi-page invoices together and unknown values last', async t => {
  const app = await fixture(t);
  app.run("Object.assign(state.records[0],{seller:'上海公司',date:'2026-10-03',pages:[1,2]});Object.assign(state.records[1],{seller:'北京公司',date:'2026-10-01'});Object.assign(state.records[2],{seller:'广州公司',date:'2026-10-02'});Object.assign(state.records[3],{seller:'销售方待核对',date:''});state.units.splice(1,0,{...state.units[0],id:'continuation',page:2});");
  app.context.sortByInvoiceDate(true);
  assert.equal(app.run('state.records.map(record=>record.fileId).join()'),'b,c,a,d');
  app.context.sortByInvoiceDate(true,true);
  assert.equal(app.run('state.records.map(record=>record.fileId).join()'),'a,c,b,d');
  app.context.sortByCompanyName(true);
  assert.equal(app.run('state.records.map(record=>record.fileId).join()'),'b,c,a,d');
  assert.equal(app.run('state.units.map(unit=>unit.fileId).join()'),'b,c,a,a,d');
  app.context.sortByCompanyName(true,true);
  assert.equal(app.run('state.records.map(record=>record.fileId).join()'),'a,c,b,d');
});
