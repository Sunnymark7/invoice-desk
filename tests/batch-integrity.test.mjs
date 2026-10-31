import assert from 'node:assert/strict';
import test from 'node:test';
import { loadApp, importSynthetic, validValues } from './app-harness.mjs';

test('editing an invoice number refreshes deduplication before later imports', async t => {
  const app = loadApp(); t.after(app.cleanup);
  const record = await importSynthetic(app, 'a', '11111111111111111111');
  assert.ok(app.context.commitRecordChanges(record, validValues('22222222222222222222')).ok);
  assert.equal(app.run("state.invoiceKeys.has('number:11111111111111111111')"), false);
  await importSynthetic(app, 'b', '22222222222222222222');
  assert.equal(app.run('state.records.length'), 1);
  assert.equal(app.run('state.duplicatePages'), 1);
  assert.equal(app.run('totalAmount(countedRecords())'), 10);
});

test('failed sources cannot become billable or inflate totals without pages', t => {
  const app = loadApp(); t.after(app.cleanup);
  const record = app.run("const failed = makeRecord({id:'failed',fileId:'bad',page:0,included:false,status:'review'});state.records=[failed];failed;");
  assert.equal(app.context.commitRecordChanges(record, validValues('33333333333333333333', '99')).ok, undefined);
  record.included = true; record.amount = 99;
  assert.equal(app.run('totalAmount(countedRecords())'), 0);
});

test('saving requires valid date, seller and complete money values without changing prior data', async t => {
  const app = loadApp(); t.after(app.cleanup);
  const record = await importSynthetic(app, 'a', '11111111111111111111');
  for (const [field, value] of [['date', ''], ['date', '2026-02-30'], ['seller', ''], ['amount', '10.001'], ['amount', 'Infinity']]) {
    assert.ok(app.context.commitRecordChanges(record, { ...validValues(record.number), [field]: value }).error);
    assert.equal(record.amount, 10);
    assert.equal(record.date, '2026-01-01');
    assert.equal(record.confirmed, false);
  }
  assert.ok(app.context.commitRecordChanges(record, validValues(record.number, '12.34')).ok);
  assert.equal(record.confirmed, true);
  assert.equal(record.amountSource, '人工修改');
  assert.equal(app.context.matchesReviewFilter(record, 'confirmed'), true);
  assert.equal(app.context.matchesReviewFilter(record, 'ready'), false);
});

test('export locks mutations and uses one snapshot for pages and filename', async t => {
  const app = loadApp(); t.after(app.cleanup);
  await importSynthetic(app, 'a', '11111111111111111111', '10.00');
  await importSynthetic(app, 'b', '22222222222222222222', '20.00');
  let resume; const gate = new Promise(resolve => { resume = resolve; });
  const output = [];
  app.context.window.PDFLib = { PDFDocument: {
    create: async () => ({ copyPages: async source => [source], addPage: page => output.push(page), save: async () => new Uint8Array([1]) }),
    load: async () => { await gate; return 'source-page'; }
  } };
  const exporting = app.context.mergePdfs();
  assert.equal(app.run('state.exporting'), true);
  const firstId = app.run('state.units[0].id');
  app.context.deletePage(firstId);
  app.context.clearAll();
  app.context.restoreImportOrder();
  assert.equal(app.run('state.units.length'), 2);
  assert.ok(app.context.commitRecordChanges(app.run('state.records[0]'), validValues('11111111111111111111', '999')).error);
  // Even external collection replacement cannot change an already captured export.
  app.run('state.units=[];state.records=[];');
  resume(); await exporting;
  assert.equal(output.length, 2);
  assert.match(app.context.download.name, /-2张-30\.00元-合并发票\.pdf$/);
  assert.equal(app.run('state.exporting'), false);
});

test('multi-page deletion counts once until the last page and undo restores order', async t => {
  const app = loadApp(); t.after(app.cleanup);
  const record = await importSynthetic(app, 'a', '11111111111111111111');
  app.run("state.records[0].pages=[1,2];state.units.push({...state.units[0],id:'second',page:2});");
  const firstId = app.run('state.units[0].id');
  app.context.deletePage(firstId);
  assert.equal(app.run('totalAmount(countedRecords())'), 10);
  app.context.deletePage('second');
  assert.equal(app.run('totalAmount(countedRecords())'), 0);
  app.context.undoPageDelete(); app.context.undoPageDelete();
  assert.equal(app.run('state.units.map(unit=>unit.page).join()'), '1,2');
  assert.equal(app.run('totalAmount(countedRecords())'), 10);
  assert.equal(app.run('state.records[0].number'), record.number);
});

test('explicitly reviewing a linked itinerary preserves the chosen attachment state', async t => {
  const app = loadApp(); t.after(app.cleanup);
  const record = await importSynthetic(app, 'a', '11111111111111111111');
  Object.assign(record, { linkedInvoiceId: 'other', beforeLinkIncluded: true, beforeLinkStatus: 'ready' });
  assert.ok(app.context.commitRecordChanges(record, { ...validValues(record.number), included: false }).ok);
  assert.equal(record.included, false);
  assert.equal(record.status, 'attachment');
  assert.equal(record.linkOverride, true);
});

test('two-pointer zoom updates scale and one-pointer dragging resumes afterwards', t => {
  const app = loadApp(); t.after(app.cleanup);
  const stage = app.node('gesture-stage'), canvas = app.node('gesture-canvas'), label = app.node('gesture-label');
  const transform = { zoom: 1, x: 0, y: 0 };
  app.context.setupPanZoom(stage, canvas, transform, label);
  const event = (pointerId, clientX, clientY) => ({ pointerId, clientX, clientY, button: 0 });
  stage.handlers.pointerdown(event(1, 0, 0)); stage.handlers.pointerdown(event(2, 100, 0));
  stage.handlers.pointermove(event(2, 200, 0));
  assert.equal(transform.zoom, 2);
  stage.handlers.pointerup(event(2, 200, 0));
  stage.handlers.pointermove(event(1, 10, 20));
  assert.equal(transform.x, 10); assert.equal(transform.y, 20);
});

test('draft snapshots retain original files, converted pages, edits and undo without live PDF handles', async t => {
  const app = loadApp(); t.after(app.cleanup);
  await importSynthetic(app, 'a', '11111111111111111111');
  app.run("state.files[0].kind='image';state.records[0].confirmed=true;");
  app.context.deletePage(app.run('state.units[0].id'));
  const draft = app.context.captureDraft();
  assert.equal(draft.version, 1);
  assert.equal(draft.files[0].pdfDoc, undefined);
  assert.ok(draft.files[0].pdfBytes);
  assert.equal(draft.deletedPages.length, 1);
  assert.equal(draft.deletedPages[0].record.confirmed, true);
});

test('OCR failure terminates its worker and ignores late progress callbacks', async t => {
  const app = loadApp(); t.after(app.cleanup);
  let terminated = 0, logger;
  app.context.window.Tesseract = { createWorker: async (_lang, _oem, options) => {
    logger = options.logger;
    return { recognize: async () => { throw new Error('worker failure'); }, terminate: async () => { terminated += 1; } };
  } };
  app.run('state.busy=true;globalThis.progressCalls=0;setProgress=()=>globalThis.progressCalls++;');
  await assert.rejects(app.context.ocrCanvas({}, 1, 'fixture'), /worker failure/);
  logger({ status: 'recognizing text', progress: 1 });
  assert.equal(terminated, 1);
  assert.equal(app.run('progressCalls'), 0);
});

test('a failed local save leaves an explicit warning rather than claiming success', async t => {
  const app = loadApp(); t.after(app.cleanup);
  await importSynthetic(app, 'a', '11111111111111111111');
  app.context.saveDraft = async () => { throw new Error('quota'); };
  app.context.scheduleDraftSave();
  await app.context.flushDraftSave();
  assert.match(app.node('storageWarning').textContent, /保存失败/);
  assert.equal(app.run('draftDirty'), true);
});

test('clearing a draft queues deletion after any pending write', async t => {
  const app = loadApp(); t.after(app.cleanup);
  await importSynthetic(app, 'a', '11111111111111111111');
  let resume; const gate = new Promise(resolve => { resume = resolve; });
  const operations = [];
  app.context.saveDraft = async () => { operations.push('write'); await gate; operations.push('written'); };
  app.context.deleteDraft = async () => { operations.push('delete'); };
  const saving = app.context.flushDraftSave();
  await Promise.resolve(); await Promise.resolve();
  app.context.clearLocalDraft();
  resume(); await saving; await app.run('draftWrites'); await Promise.resolve();
  assert.deepEqual(operations, ['write', 'written', 'delete']);
  assert.equal(app.node('storageWarning').hidden, true);
  assert.equal(app.run('draftDirty'), false);
});

test('OFD rendering failure always releases document resources', async t => {
  const app = loadApp(); t.after(app.cleanup);
  let destroyed = false;
  app.context.getOfdDocument = async () => ({
    numPages: 1, destroy() { destroyed = true; },
    getPage: async () => ({ getTextContent: async () => ({ items: [] }), getViewport: () => ({}), render: () => ({ promise: Promise.reject(new Error('render failure')) }) })
  });
  app.context.document.createElement = () => ({ getContext: () => ({}) });
  app.context.window.PDFLib = { PDFDocument: { create: async () => ({}) } };
  await assert.rejects(app.context.processOfdFile({ file: { name: 'synthetic.ofd' } }, new Uint8Array(), 0, 1), /render failure/);
  assert.equal(destroyed, true);
});
