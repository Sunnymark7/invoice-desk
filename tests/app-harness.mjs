import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

export function loadApp() {
  const nodes = new Map();
  const timers = new Set();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', dataset: {}, style: {}, disabled: false, hidden: false, open: false, isConnected: true,
      handlers: {}, parentElement: { scrollTop: 0 }, addEventListener(name, handler) { this.handlers[name] = handler; },
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      querySelectorAll() { return []; }, querySelector() { return null; }, closest(selector) { return selector === '.preview-viewer' ? node('preview-viewer') : null; }, close() { this.open = false; }, focus() {},
      classList: { add() {}, remove() {}, toggle() {} }, setPointerCapture() {}, hasPointerCapture() { return false; } });
    return nodes.get(id);
  };
  const context = vm.createContext({ console, crypto: webcrypto, Intl, URL, Blob, Map, Set,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout,
    document: { getElementById: node, querySelectorAll() { return []; }, addEventListener() {} },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }), devicePixelRatio: 1 },
    pdfjsLib: { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => ({}) }) }) },
    loadDraft: async () => null, saveDraft: async () => {}, deleteDraft: async () => {} });
  const source = fs.readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(new URL('../dist/app.js', import.meta.url).href)).replace(/\n\/\/ Bootstrap[\s\S]*$/, '');
  vm.runInContext(source, context);
  const run = source => vm.runInContext(source, context);
  run('toast = message => globalThis.lastToast = message; downloadBlob = (blob, name) => { globalThis.download = { blob, name }; };');
  return { context, node, run, cleanup() { timers.forEach(clearTimeout); } };
}

export function validValues(number, amount = '10.00') {
  return { date: '2026-01-01', seller: '合成测试商户', number, category: '研发耗材', amount, included: true };
}

export async function importSynthetic(app, id, number, amount = '10.00') {
  const item = { id, file: { name: `${id}.pdf`, size: 1 }, kind: 'pdf' };
  app.context.item = item;
  app.run('state.files.push(item)');
  const text = `电子发票 发票号码：${number}\n开票日期：2026年01月01日\n名称：测试购买方 名称：合成测试商户\n气泵\n（小写）¥${amount}`;
  await app.context.processPdfBytes(item, new Uint8Array([1]), 0, 1, [text]);
  return app.run(`state.records.find(record => record.fileId === '${id}')`);
}
