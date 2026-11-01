import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const context = vm.createContext({});
for (const name of ['textInReadingOrder', 'normalizeInvoiceText', 'extractCapitalTotal', 'extractAmount', 'isCompleteAmount', 'extractDate', 'extractNumber']) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  vm.runInContext(source.slice(start, end < 0 ? source.length : end), context);
}
const fragment = (str, x, y = 20, width = 9) => ({ str, width, height: 9, transform: [9, 0, 0, 9, x, y] });
const digits = (str, x, y) => [...str].map((char, index) => fragment(char, x + index * 4.5, y));

test('individually positioned digits form complete totals, invoice numbers and dates', () => {
  const items = [
    fragment('发票号码：', 0, 60, 45), ...digits('12345678901234567890', 46, 60),
    fragment('开票日期：', 0, 40, 45), ...digits('2026年12月27日', 46, 40),
    fragment('（小写）', 0, 20, 36), fragment('¥', 37), ...digits('21.16', 44, 20)
  ];
  const text = context.textInReadingOrder(items, {});
  assert.equal(context.extractAmount(text, false), 21.16);
  assert.equal(context.extractDate(text), '2026-12-27');
  assert.equal(context.extractNumber(text, false), '12345678901234567890');
});

test('capital totals recover missing digits and cross-check lowercase totals', () => {
  assert.equal(context.extractAmount('价税合计（大写）⊗贰拾壹圆壹角陆分 （小写）¥21.16', false), 21.16);
  assert.equal(context.extractAmount('价税合计（大写）⊗贰拾壹圆壹角陆分 （小写）¥2', false), null);
  assert.equal(context.extractAmount('价税合计（大写）⊗贰拾壹圆壹角陆分 （小写）¥2 1 . 1 6', false), 21.16);
  assert.equal(context.extractAmount('价税合计（大写）壹仟零叁拾圆零伍分', false), 1030.05);
  assert.equal(context.extractAmount('价税合计（大写）负壹佰圆整 （小写）¥-100.00', false), -100);
  assert.equal(context.extractAmount('价税合计（大写）零圆整 （小写）¥0.00', false), 0);
});

test('normalizes fullwidth fields and rejects unlabelled line-item totals', () => {
  assert.equal(context.extractAmount('（小写）￥２１．１６', false), 21.16);
  assert.equal(context.extractAmount('增值税电子发票 数量1 单价¥999.00 税额¥0.21 价税合计模糊', false), null);
  assert.equal(context.extractNumber('发票号码：１２３４５６７８９０１２３４５６７８９０', false), '12345678901234567890');
  assert.equal(context.extractNumber('发票号码：12345678901234567890123', false), '');
});

test('issue date takes priority over travel dates and validates the calendar', () => {
  assert.equal(context.extractDate('日期：2026-01-01 开票日期：2026-02-03'), '2026-02-03');
  assert.equal(context.extractDate('开具日期：２０２６年２月３日'), '2026-02-03');
  assert.equal(context.extractDate('开票日期：2026-02-30'), '');
  assert.equal(context.extractDate('开票日期：2024-02-29'), '2024-02-29');
});

test('labelled totals take priority over fare components and unknown totals never use a fare', () => {
  assert.equal(context.extractAmount('票价 ¥400.00 燃油 ¥100.00 （小写）¥520.00', false), 520);
  assert.equal(context.extractAmount('票价 ¥400.00 （小写）模糊', false), null);
  assert.equal(context.extractAmount('票价 ¥67.00', false), 67);
  assert.equal(context.extractAmount('票价 ¥400.00 机票总金额 模糊', true), null);
});

test('joining adjacent fragments preserves separate table columns and English words', () => {
  const items = [fragment('3', 0), ...digits('6.983498', 25, 20), ...digits('20.95', 100, 20),
    fragment('TOTAL', 0, 40, 28), fragment('INCLUDING', 32, 40, 50), fragment('TAX', 86, 40, 18)];
  const text = context.textInReadingOrder(items, {});
  assert.ok(text.includes('3 6.983498 20.95'));
  assert.ok(text.includes('TOTAL INCLUDING TAX'));
});

test('rotated text fragments retain numeric reading order', () => {
  const items = digits('21.16', 0, 20).map(item => ({ ...item, transform: [0, 9, -9, 0, -20, item.transform[4]] }));
  assert.equal(context.textInReadingOrder(items, {}), '21.16');
});

test('an amount parser must not accept a detached first digit or truncate decimals', () => {
  assert.equal(context.extractAmount('（小写） ¥ 2 1 . 1 6', false), null);
  assert.equal(context.extractAmount('合计 ¥20.95 ¥0.21\n（小写） ¥ 2 1 . 1 6', false), null);
  assert.equal(context.extractAmount('（小写） ¥ 21.166', false), null);
  assert.equal(context.extractAmount('（小写） ¥ 21.16\n备注：已付款', false), 21.16);
  assert.equal(context.extractAmount('（小写） ¥ 2', false), 2);
  assert.equal(context.extractAmount('（小写） ¥ 0.00', false), 0);
});
