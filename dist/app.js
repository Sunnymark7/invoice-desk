import * as pdfjsLib from './vendor/pdf.min.mjs';
import { getDocument as getOfdDocument } from './vendor/ofdjs.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const state = { files: [], records: [], units: [], skippedPages: 0, duplicatePages: 0, invoiceKeys: new Set(), busy: false, demo: false, activeView: 'review' };
const canvasTasks = new WeakMap();
const deletedPages = [];
let reviewFilter = 'all';
const previewState = { zoom: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, originX: 0, originY: 0, unitId: '', rotation: 0 };
const editPreviewState = { zoom: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, originX: 0, originY: 0, rotation: 0 };
const el = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const demoRecords = [
  { date: '2026-09-21', number: '2642700000067368••••', category: '交通', seller: '某出行科技有限公司', amount: 112.40, included: true, status: 'ready', source: '出行发票.pdf' },
  { date: '2026-09-19', number: '2642200000333560••••', category: '住宿', seller: '某商务酒店', amount: 159.27, included: true, status: 'ready', source: '住宿发票.pdf' },
  { date: '2026-09-17', number: 'SC4865', category: '机票', seller: '航空行程校验单', amount: 520.00, included: true, status: 'ready', source: '行程校验单.pdf' },
  { date: '', number: '', category: '附件', seller: '登机凭证（请核对）', amount: null, included: false, status: 'attachment', source: '登机凭证.pdf' }
].map((r, i) => ({ ...r, id: `demo-${i}` }));

const dropZone = el('dropZone');
const fileInput = el('fileInput');
el('chooseButton').addEventListener('click', (event) => { event.stopPropagation(); fileInput.click(); });
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (event) => { if (event.target === dropZone && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); fileInput.click(); } });
el('reviewSearch').addEventListener('input', renderInvoiceTable);
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  reviewFilter = button.dataset.filter;
  renderInvoiceTable();
}));
fileInput.addEventListener('change', () => addFiles(fileInput.files));
['dragenter', 'dragover'].forEach(name => dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(name => dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', event => addFiles(event.dataTransfer.files));

el('demoButton').addEventListener('click', () => {
  if (state.busy) return;
  resetBatch();
  state.demo = true;
  state.records = demoRecords.map(record => ({ ...record }));
  render();
  toast('已载入匿名演示数据；上传文件即可替换');
});
el('clearButton').addEventListener('click', clearAll);
el('exportButton').addEventListener('click', exportCsv);
el('sortExportButton').addEventListener('click', exportCsv);
el('quickExportButton').addEventListener('click', exportCsv);
el('quickMergeButton').addEventListener('click', mergePdfs);
el('sortAddButton').addEventListener('click', () => fileInput.click());
el('mergeButton').addEventListener('click', mergePdfs);
el('sortMergeButton').addEventListener('click', mergePdfs);
el('autoOrderButton').addEventListener('click', () => autoArrangeFiles(false));
el('sortDateButton').addEventListener('click', () => sortByInvoiceDate(false));
el('sortImportButton').addEventListener('click', restoreImportOrder);
el('openSortButton').addEventListener('click', () => switchView('sort'));
el('backReviewButton').addEventListener('click', () => switchView('review'));
el('saveEdit').addEventListener('click', saveEdit);
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
el('closePreviewButton').addEventListener('click', () => el('previewDialog').close());
el('previewPrevButton').addEventListener('click', () => stepPreview(-1));
el('previewNextButton').addEventListener('click', () => stepPreview(1));
el('zoomInButton').addEventListener('click', () => setPreviewZoom(previewState.zoom + .2));
el('zoomOutButton').addEventListener('click', () => setPreviewZoom(previewState.zoom - .2));
el('zoomResetButton').addEventListener('click', resetPreviewTransform);
el('rotatePreviewButton').addEventListener('click', rotateCurrentPreview);
el('undoPageDeleteButton').addEventListener('click', undoPageDelete);
el('previewEditButton').addEventListener('click', () => {
  const unit = state.units.find(item => item.id === previewState.unitId);
  if (!unit?.recordId) return;
  el('previewDialog').close();
  openEdit(unit.recordId, unit.page);
});

const previewStage = el('previewStage');
setupPanZoom(previewStage, el('previewCanvas'), previewState, el('zoomResetButton'));
setupPanZoom(el('editPreviewStage'), el('editPreviewCanvas'), editPreviewState, el('editZoomReset'));
document.addEventListener('keydown', event => {
  if (!el('previewDialog').open) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); stepPreview(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); stepPreview(1); }
});
el('editZoomIn').addEventListener('click', () => setTransformZoom(editPreviewState, editPreviewState.zoom + .2, el('editPreviewCanvas'), el('editZoomReset')));
el('editZoomOut').addEventListener('click', () => setTransformZoom(editPreviewState, editPreviewState.zoom - .2, el('editPreviewCanvas'), el('editZoomReset')));
el('editZoomReset').addEventListener('click', () => resetTransform(editPreviewState, el('editPreviewCanvas'), el('editZoomReset')));
el('editRotateButton').addEventListener('click', rotateEditPreview);
el('editPageSelect').addEventListener('change', () => {
  editPreviewState.rotation = 0;
  const record = state.records.find(item => item.id === el('editId').value);
  if (record) renderRecordPreview(record);
});

async function addFiles(fileList) {
  if (state.busy) return toast('正在识别当前批次，请稍候');
  const incoming = [...fileList].filter(isSupportedFile);
  if (!incoming.length) return toast('请选择 PDF、OFD 或图片文件');
  if (state.demo) resetBatch();
  state.demo = false;
  state.busy = true;
  const startIndex = state.files.length;
  state.files.push(...incoming.map((file, i) => ({ file, id: `${Date.now()}-${startIndex + i}`, status: '等待识别', pages: 0, kind: '' })));
  render();
  setProgress(true, 2, '正在检查文件真实格式…');

  for (let i = startIndex; i < state.files.length; i++) {
    const item = state.files[i];
    item.status = '识别中';
    renderQueue();
    try {
      await processFile(item, i, state.files.length);
      item.processed = true;
      const reviewPages = state.records.filter(record => record.fileId === item.id && record.status === 'review').length;
      item.status = `${reviewPages ? `待核对 ${reviewPages} 页` : '已完成'}${item.duplicatePages ? ` · 去重 ${item.duplicatePages}` : ''}`;
      if (!item.recognizedPages && item.duplicatePages) item.status = `重复 · 已排除 ${item.duplicatePages}`;
    } catch (error) {
      console.warn('file needs review', item.file.name, error);
      item.status = '文件读取失败 · 待核对';
      state.records.push(makeRecord({ fileId: item.id, source: item.file.name, page: 0, seller: '文件读取失败', status: 'review', included: false, reviewReason: '文件损坏、加密或格式不受支持，未计入金额；请重新导入可打开的文件。' }));
    }
    render();
  }
  state.busy = false;
  reconcileFlightAmounts();
  render();
  fileInput.value = '';
  setProgress(false, 100, `识别完成 · 已保留 ${state.files.length} 个文件`);
  const review = state.records.filter(record => record.status === 'review').length;
  const duplicates = state.duplicatePages;
  const note = `${duplicates ? `，排除 ${duplicates} 张重复发票` : ''}`;
  toast(review ? `本批次共 ${state.files.length} 个文件，${review} 条待核对（按导入顺序）` : `本批次共 ${state.files.length} 个文件，已保持导入顺序${note}`);
}

async function processFile(item, fileIndex, fileCount) {
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  item.contentHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2,'0')).join('');
  const existing = state.files.find(candidate => candidate !== item && candidate.processed && candidate.contentHash === item.contentHash && state.units.some(unit => unit.fileId === candidate.id));
  if (existing) {
    item.pages = existing.pages;
    item.kind = existing.kind;
    item.recognizedPages = 0;
    item.duplicatePages = Math.max(1,state.records.filter(record => record.fileId === existing.id && record.included).length);
    state.duplicatePages += item.duplicatePages;
    return;
  }
  const kind = detectRealFileKind(bytes, item.file);
  item.kind = kind;
  if (kind === 'image') return processImageFile(item, bytes, fileIndex, fileCount);
  if (kind === 'ofd') return processOfdFile(item, bytes, fileIndex, fileCount);
  if (kind !== 'pdf') throw new Error('Unsupported file format');
  return processPdfBytes(item, bytes, fileIndex, fileCount);
}

async function processPdfBytes(item, bytes, fileIndex, fileCount, providedTexts = null) {
  item.pdfBytes = bytes;
  const loadingTask = pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href,
    wasmUrl: new URL('./vendor/wasm/', import.meta.url).href,
    useSystemFonts: true
  });
  const pdf = await withTimeout(loadingTask.promise, 20000, '读取文件超时', () => loadingTask.destroy());
  item.pdfDoc = pdf;
  item.pages = pdf.numPages;
  const pageTexts = [];
  const pageIssues = [];
  item.recognizedPages = 0;
  item.skippedPages = 0;
  item.duplicatePages = 0;
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    try {
      const page = await withTimeout(pdf.getPage(pageNo), 15000, `读取第 ${pageNo} 页超时`);
      const content = providedTexts ? null : await withTimeout(page.getTextContent(), 15000, `读取第 ${pageNo} 页文字超时`);
      let text = providedTexts?.[pageNo - 1] ?? (content ? textInReadingOrder(content.items, page.getViewport({ scale: 1 })) : '');
      const pct = Math.round(((fileIndex + (pageNo / pdf.numPages)) / fileCount) * 88);
      setProgress(true, pct, `识别 ${item.file.name} · 第 ${pageNo}/${pdf.numPages} 页`);
      if (!providedTexts && (text.length < 45 || !hasRecognizableSignal(text))) {
        const ocrText = await ocrPage(page, pct, item.file.name).catch(error => {
          pageIssues[pageNo - 1] = /超时/.test(error.message) ? '识别超时，已继续处理后续页面' : '文字识别失败，已保留原始票面';
          return '';
        });
        text = `${text} ${ocrText}`.replace(/\s+/g, ' ').trim();
      }
      if (!hasRecognizableSignal(text)) {
        item.skippedPages += 1;
        state.skippedPages += 1;
        pageIssues[pageNo - 1] ||= '未识别出票据信息，请对照原图补录';
        pageTexts.push(text);
        continue;
      }
      item.recognizedPages += 1;
      pageTexts.push(text);
    } catch (error) {
      console.warn('page needs review', item.file.name, pageNo, error);
      item.skippedPages += 1;
      state.skippedPages += 1;
      pageTexts.push('');
      pageIssues[pageNo - 1] = '此页读取或识别超时，请预览后手动补录';
    }
  }
  const pageMetas = inferPageOrderMetas(pageTexts);
  item.orderMeta = detectFileOrderMeta(pageTexts);
  const parsedRecords = mergeMultiPageRecords(parsePages(pageTexts, item.file.name, item.id, pageMetas, pageIssues));
  const records = parsedRecords.filter(record => {
    if (!record.included || !Number.isFinite(record.amount)) return true;
    const text = pageTexts[(record.page || 1) - 1] || '';
    const keys = invoiceDedupKeys(record, text);
    const duplicate = keys.some(key => state.invoiceKeys.has(key));
    if (duplicate) {
      item.duplicatePages += 1;
      state.duplicatePages += 1;
      return false;
    }
    keys.forEach(key => state.invoiceKeys.add(key));
    return true;
  });
  item.recognizedPages = records.length;
  state.records.push(...records);
  pageTexts.forEach((text, pageIndex) => {
    const record = records.find(candidate => candidate.pages?.includes(pageIndex + 1) || candidate.page === pageIndex + 1);
    if (!record) {
      return;
    }
    state.units.push({
      id: crypto.randomUUID(), fileId: item.id, page: pageIndex + 1, source: item.file.name,
      recordId: record.id, orderMeta: pageMetas[pageIndex], text,
      importOrder: state.files.indexOf(item) * 1000000 + pageIndex
    });
  });
}

async function processImageFile(item, bytes, fileIndex, fileCount) {
  setProgress(true, Math.round((fileIndex / fileCount) * 88), `正在转换照片 · ${item.file.name}`);
  const bitmap = await createImageBitmap(item.file, { imageOrientation: 'from-image' });
  const maxSide = 2600;
  const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const text = await ocrCanvas(canvas, Math.round(((fileIndex + .5) / fileCount) * 88), item.file.name).catch(() => '');
  const pdfBytes = await canvasToPdf(canvas);
  await processPdfBytes(item, pdfBytes, fileIndex, fileCount, [text]);
}

async function processOfdFile(item, bytes, fileIndex, fileCount) {
  setProgress(true, Math.round((fileIndex / fileCount) * 88), `正在解析 OFD · ${item.file.name}`);
  const ofd = await getOfdDocument(bytes);
  const converted = await window.PDFLib.PDFDocument.create();
  const pageTexts = [];
  for (let pageNo = 1; pageNo <= ofd.numPages; pageNo++) {
    const page = await ofd.getPage(pageNo);
    const textContent = await page.getTextContent();
    let text = textContent.items.map(item => item.text).join(' ').replace(/\s+/g, ' ').trim();
    const viewport = page.getViewport({ scale: 1.7, rotation: 0 });
    const canvas = document.createElement('canvas');
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport, pixelRatio: 1 });
    await task.promise;
    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = canvas.width;
    pageCanvas.height = canvas.height;
    const pageContext = pageCanvas.getContext('2d');
    pageContext.fillStyle = '#fff';
    pageContext.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    pageContext.drawImage(canvas, 0, 0);
    const pct = Math.round(((fileIndex + pageNo / ofd.numPages) / fileCount) * 88);
    if (text.length < 45) text = `${text} ${await ocrCanvas(pageCanvas, pct, item.file.name).catch(() => '')}`.replace(/\s+/g, ' ').trim();
    pageTexts.push(text);
    const jpg = await canvasToJpegBytes(pageCanvas);
    const image = await converted.embedJpg(jpg);
    const width = viewport.width * .75;
    const height = viewport.height * .75;
    const pdfPage = converted.addPage([width, height]);
    pdfPage.drawImage(image, { x: 0, y: 0, width, height });
  }
  ofd.destroy();
  const pdfBytes = new Uint8Array(await converted.save());
  await processPdfBytes(item, pdfBytes, fileIndex, fileCount, pageTexts);
}

function isSupportedFile(file) {
  return /\.(pdf|ofd|jpe?g|png|webp)$/i.test(file.name) || file.type === 'application/pdf' || file.type.startsWith('image/');
}

function detectRealFileKind(bytes, file) {
  const signature = String.fromCharCode(...bytes.slice(0, 8));
  if (signature.startsWith('%PDF-')) return 'pdf';
  if (signature.startsWith('PK')) return 'ofd';
  if (file.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(file.name)) return 'image';
  return '';
}

async function canvasToPdf(canvas) {
  const pdf = await window.PDFLib.PDFDocument.create();
  const jpg = await canvasToJpegBytes(canvas);
  const image = await pdf.embedJpg(jpg);
  const fit = Math.min(1, 842 / Math.max(canvas.width, canvas.height));
  const width = canvas.width * fit;
  const height = canvas.height * fit;
  const page = pdf.addPage([width, height]);
  page.drawImage(image, { x: 0, y: 0, width, height });
  return new Uint8Array(await pdf.save());
}

function canvasToJpegBytes(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(async blob => blob ? resolve(new Uint8Array(await blob.arrayBuffer())) : reject(new Error('图片转换失败')), 'image/jpeg', .94));
}

async function ocrPage(page, pct, fileName) {
  if (!window.Tesseract) return '';
  setProgress(true, pct, `正在 OCR 扫描件 · ${fileName}`);
  const viewport = page.getViewport({ scale: 2.4 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
  await withTimeout(task.promise, 15000, '渲染扫描页超时', () => task.cancel());
  return ocrCanvas(canvas, pct, fileName);
}

async function ocrCanvas(canvas, pct, fileName) {
  if (!window.Tesseract) return '';
  const result = await withTimeout(window.Tesseract.recognize(canvas, 'chi_sim+eng', {
    workerPath: './vendor/worker.min.js',
    corePath: './vendor/tesseract-core-simd-lstm.wasm.js',
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    logger: message => {
      if (message.status === 'recognizing text') setProgress(true, Math.max(pct, Math.round(message.progress * 100)), '正在识别扫描文字…');
    }
  }), 20000, `OCR ${fileName} 超时`);
  return result.data.text.replace(/\s+/g, ' ').trim();
}

function hasRecognizableSignal(text) {
  const compact = String(text || '').replace(/\s+/g, '');
  if (!compact) return false;
  return /电子发票|E-?INVOICE|发票号码|登机凭证|BOARDING|行程校验单|机票总金额|航空|机票|旅客运输电子客票|铁路电子客票|电子客票号|滴滴出行|旅客运输|住宿|酒店|宾馆/.test(compact)
    || /(?:¥|￥|CNY)\s*\d+(?:\.\d{1,2})?/.test(text);
}

function withTimeout(promise, ms, message, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
      try { Promise.resolve(onTimeout?.()).catch(() => {}); } catch {}
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function invoiceDedupKeys(record, text) {
  const normalize = value => String(value || '').toUpperCase().replace(/[^0-9A-Z\u4e00-\u9fff]/g, '');
  const number = normalize(record.number);
  if (number.length >= 10) return [`number:${number}`];
  const content = normalize(text);
  if (content.length >= 60) return [`content:${simpleHash(content)}`];
  const seller = normalize(record.seller);
  if (record.date && seller && Number.isFinite(record.amount)) {
    return [`fields:${record.date}|${seller}|${Number(record.amount).toFixed(2)}|${normalize(record.category)}`];
  }
  return [];
}

function simpleHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function parsePages(pageTexts, source, fileId, pageMetas = [], pageIssues = []) {
  const records = [];
  pageTexts.forEach((text, pageIndex) => {
    const normalized = text.replace(/[，,]/g, '').replace(/￥/g, '¥');
    const compact = normalized.replace(/\s+/g, '');
    const invoiceLike = /电子发票|E-?INVOICE|发票号码/i.test(compact);
    const flightLike = pageMetas[pageIndex]?.type === 'flight-itinerary' || /行程校验单|机票总金额/.test(compact);
    const boardingLike = pageMetas[pageIndex]?.type === 'flight-boarding' || /登机凭证|BOARDING/i.test(compact);
    const tripAttachment = pageMetas[pageIndex]?.type === 'taxi-itinerary' || (/滴滴出行\s*-?\s*行程单/i.test(normalized) && !invoiceLike);
    if (tripAttachment || boardingLike) {
      records.push(makeRecord({ source, fileId, page: pageIndex + 1, date: extractDate(normalized), number: boardingLike ? extractFlightNumberFromText(normalized) : '', category: '附件', seller: boardingLike ? '登机凭证' : '打车行程单', amount: null, included: false, status: 'attachment' }));
      return;
    }
    if (!hasRecognizableSignal(normalized)) {
      records.push(makeRecord({ source, fileId, page: pageIndex + 1, seller: '未识别票据 · 请核对原图', included: false, status: 'review', reviewReason: pageIssues[pageIndex] || '未识别出票据信息，请对照原图补录' }));
      return;
    }

    const invoiceStart = normalized.lastIndexOf('电子发票');
    const followsTripSheet = invoiceStart > 0 && /滴滴出行\s*-?\s*行程单|DIDI\s+TRAVEL/i.test(normalized.slice(0, invoiceStart));
    const recordText = followsTripSheet ? normalized.slice(invoiceStart) : normalized;
    const amount = extractAmount(recordText, flightLike);
    const number = extractNumber(recordText, flightLike);
    const date = extractDate(recordText);
    const category = detectCategory(recordText, flightLike, boardingLike);
    const seller = extractSeller(recordText, category, flightLike, boardingLike);
    const review = amount == null || !seller || seller.includes('待核对') || !date;
    records.push(makeRecord({
      date, number, category, seller: seller || '销售方待核对', amount,
      included: Number.isFinite(amount),
      status: review ? 'review' : 'ready',
      reviewReason: review ? (pageIssues[pageIndex] || '票据信息不完整，请对照原图核对') : '',
      source, fileId, page: pageIndex + 1,
      invoicePage: parseInvoicePageLabel(normalized),
      finalAmount: /小\s*写/.test(recordText) ? amount : null
    }));
  });
  return records;
}

function mergeMultiPageRecords(records) {
  const grouped = [];
  const byInvoice = new Map();
  records.forEach(record => {
    const normalizedNumber = String(record.number || '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
    const groupKey = normalizedNumber.length >= 10 && record.invoicePage?.total > 1
      ? `number:${normalizedNumber}`
      : `page:${record.page}`;
    let group = byInvoice.get(groupKey);
    if (!group) {
      group = { ...record, pages: [record.page], pageCount: 1, amountPages: [record.amount].filter(Number.isFinite) };
      byInvoice.set(groupKey, group);
      grouped.push(group);
      return;
    }
    group.pages.push(record.page);
    group.pageCount = group.pages.length;
    if (Number.isFinite(record.amount)) group.amountPages.push(record.amount);
    group.amount = Number.isFinite(record.finalAmount) ? record.finalAmount : Math.max(...group.amountPages, group.amount ?? 0) || null;
    if (Number.isFinite(record.finalAmount)) group.finalAmount = record.finalAmount;
    if (!group.date && record.date) group.date = record.date;
    if (!group.number && record.number) group.number = record.number;
    if ((!group.seller || group.seller.includes('待核对')) && record.seller) group.seller = record.seller;
    if (group.status !== 'review' && record.status === 'review') group.status = 'review';
    if (!group.reviewReason && record.reviewReason) group.reviewReason = record.reviewReason;
    group.included = Number.isFinite(group.amount);
  });
  return grouped.map(record => ({
    ...record,
    pages: [...new Set(record.pages)].sort((a, b) => a - b),
    page: Math.min(...record.pages),
    pageCount: record.pages.length,
    amountPages: undefined,
    status: record.status === 'attachment' ? 'attachment' : Number.isFinite(record.amount) && record.date && record.seller && !record.seller.includes('待核对') ? 'ready' : 'review',
    reviewReason: Number.isFinite(record.amount) && record.date && record.seller && !record.seller.includes('待核对') ? '' : record.reviewReason
  }));
}

function textInReadingOrder(items, viewport) {
  const orientationWeights = new Map();
  items.filter(item => item.str?.trim() && item.transform).forEach(item => {
    const angle = Math.round(Math.atan2(item.transform[1], item.transform[0]) / (Math.PI / 2)) * 90;
    orientationWeights.set(angle, (orientationWeights.get(angle) || 0) + item.str.trim().length);
  });
  const angle = [...orientationWeights].sort((a,b) => b[1]-a[1])[0]?.[0] || 0;
  const cos = Math.round(Math.cos(angle * Math.PI / 180)), sin = Math.round(Math.sin(angle * Math.PI / 180));
  const tokens = items.filter(item => item.str?.trim() && item.transform).map(item => {
    const tx = item.transform[4], ty = item.transform[5];
    return { text: item.str.trim(), x: cos * tx + sin * ty, y: -sin * tx + cos * ty, width: Math.abs(item.width || 0), height: Math.abs(item.height || item.transform[3] || 9) };
  });
  const lines = [];
  tokens.sort((a, b) => b.y - a.y || a.x - b.x).forEach(token => {
    let line = lines.find(candidate => Math.abs(candidate.y - token.y) <= Math.min(3, token.height * .3));
    if (!line) { line = { y: token.y, tokens: [] }; lines.push(line); }
    line.tokens.push(token);
  });
  return lines.sort((a, b) => b.y - a.y).map(line => {
    const ordered = line.tokens.sort((a, b) => a.x - b.x);
    return ordered.map((token, index) => {
      const previous = ordered[index - 1];
      if (!previous) return token.text;
      // Some PDFs draw every digit separately. Join only adjacent numeric/date
      // fragments; retain spaces across table columns and between ordinary words.
      const numericFragment = /[\d¥￥.年月]$/.test(previous.text) && /^[\d.年月日]/.test(token.text);
      const gap = token.x - (previous.x + previous.width);
      const adjacent = gap <= Math.max(.5, Math.min(previous.height, token.height) * .15);
      return `${numericFragment && adjacent ? '' : ' '}${token.text}`;
    }).join('');
  }).join('\n');
}

function parseInvoicePageLabel(text) {
  const compact = text.replace(/\s/g, '');
  const match = compact.match(/共(\d{1,3})页[，,]?第(\d{1,3})页/) || compact.match(/(\d{1,3})\/(\d{1,3})页/);
  if (!match) return null;
  return /共/.test(match[0]) ? { total: Number(match[1]), current: Number(match[2]) } : { total: Number(match[2]), current: Number(match[1]) };
}

function reconcileFlightAmounts() {
  state.records.filter(record => record.linkedInvoiceId).forEach(record => {
    record.included = record.beforeLinkIncluded;
    record.status = record.beforeLinkStatus;
    record.linkedInvoiceId = '';
    record.reviewReason = '';
  });
  const invoices = state.units.filter(unit => unit.orderMeta?.type === 'flight-invoice');
  state.units.filter(unit => unit.orderMeta?.type === 'flight-itinerary').forEach(unit => {
    const itinerary = state.records.find(record => record.id === unit.recordId);
    if (!itinerary || itinerary.linkOverride || !Number.isFinite(itinerary.amount) || !unit.orderMeta.key) return;
    const matches = invoices.filter(invoiceUnit => {
      const invoice = state.records.find(record => record.id === invoiceUnit.recordId);
      const travelDate = extractDate(invoiceUnit.text.match(/行程信息[^\n]*/)?.[0] || '');
      return invoice?.included && invoiceUnit.orderMeta.key === unit.orderMeta.key
        && Math.round(invoice.amount * 100) === Math.round(itinerary.amount * 100)
        && (travelDate ? travelDate === itinerary.date : invoiceUnit.fileId === unit.fileId);
    });
    if (matches.length === 1) {
      itinerary.beforeLinkIncluded = itinerary.included;
      itinerary.beforeLinkStatus = itinerary.status;
      itinerary.linkedInvoiceId = matches[0].recordId;
      itinerary.included = false;
      itinerary.status = 'attachment';
      itinerary.reviewReason = '同航班、同金额发票已计入；行程校验单保留为附件';
    }
  });
}

function extractAmount(text, flightLike) {
  const airlineInvoice = /航空|航\s*空|旅客运输电子客票|电\s*子\s*发\s*票/.test(text);
  const patterns = flightLike ? [
    /(?:机\s*票\s*)?总\s*金\s*额\s*[¥]?\s*(\d+(?:\.\d{1,2})?)/i,
    /总\s*价\s*[:：]?\s*[¥]?\s*(\d+(?:\.\d{1,2})?)/i,
    /(?:票\s*价|FARE)[\s:：]*[¥]?\s*(\d+(?:\.\d{1,2})?)/i
  ] : [
    /票\s*价\s*[:：]?\s*[¥]\s*(-?\d+\.\d{1,2})/i,
    /[（(]?小\s*写[）)]?\s*[:：]?\s*[¥]?\s*(-?\d+(?:\.\d{1,2})?)(?!\d)/i,
    /TOTAL\s+INCLUDING\s+TAX\s*[¥]?\s*(\d+(?:\.\d{2}))/i,
    /[大壹贰叁肆伍陆柒捌玖拾佰仟万零圆角分整]{3,}\s*¥\s*(\d+(?:\.\d{2}))/i,
    /价\s*税\s*合\s*计[\s\S]{0,45}?[（(]?\s*小\s*写\s*[）)]?[\s:：]*[¥]?\s*(\d+(?:\.\d{2}))/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && isCompleteAmount(text, match)) return Number(match[1]);
  }
  // An unreadable labelled total must stay pending rather than fall back to a
  // line-item amount or tax from elsewhere on the invoice.
  if (/小\s*写/.test(text)) return null;
  if (airlineInvoice) {
    const cnyAmounts = [...text.matchAll(/CNY\s*(\d+(?:\.\d{2}))/gi)].map(match => Number(match[1])).filter(n => n > 0);
    if (cnyAmounts.length) return Math.max(...cnyAmounts);
  }
  const afterSymbol = [...text.matchAll(/[¥]\s*(\d+(?:\.\d{2}))/g)].filter(match => isCompleteAmount(text, match)).map(match => Number(match[1])).filter(n => n > 0);
  if (afterSymbol.length) return Math.max(...afterSymbol);
  const beforeSymbol = [...text.matchAll(/(\d+(?:\.\d{2}))\s*¥/g)].map(match => Number(match[1])).filter(n => n > 0);
  if (beforeSymbol.length) return Math.max(...beforeSymbol);
  return null;
}

function isCompleteAmount(text, match) {
  // A detached following digit or decimal point means this is a prefix, not a total.
  return !/^(?:[\d.]|[ \t]+[\d.])/.test(text.slice(match.index + match[0].length));
}

function extractNumber(text, flightLike) {
  if (flightLike) return extractFlightNumberFromText(text) || text.match(/\b\d{10,14}[A-Z]?\b/)?.[0] || '';
  return text.match(/发\s*票\s*号\s*码\s*[:：]?\s*(\d{8,22})/)?.[1]
    || text.match(/\b(\d{20})\b/)?.[1]
    || text.match(/INVOICE\s+NO\.?\s*[:：]?\s*([A-Z0-9-]+)/i)?.[1]
    || '';
}

function extractDate(text) {
  const match = text.match(/(?:开\s*票\s*日\s*期|DATE|日\s*期)\s*[:：]?\s*(20\d{2})\s*[年\-/\.]\s*(\d{1,2})\s*[月\-/\.]\s*(\d{1,2})\s*日?/i)
    || text.match(/(20\d{2})\s*[年\-/\.]\s*(\d{1,2})\s*[月\-/\.]\s*(\d{1,2})\s*日?/);
  if (!match) return '';
  return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
}

function detectCategory(text, flightLike, boardingLike) {
  if (flightLike) return '机票';
  if (boardingLike) return '附件';
  if (/金融服务|人身保险|保单号|保险服务/.test(text)) return '保险';
  if (/代订附加|服务包/.test(text)) return '其他';
  if (/航\s*空|机\s*票|飞\s*机\s*票|旅\s*客\s*运\s*输\s*电\s*子\s*客\s*票/.test(text)) return '机票';
  if (/铁路电子客票|电子客票号|中国铁路|12306/.test(text)) return '交通';
  if (/住宿|酒店|宾馆|房费/.test(text)) return '住宿';
  if (/旅客运输|交通运输|出租车|客运|出行/.test(text)) return '交通';
  if (/电子元件|电力电子元器件|电阻|电容|电磁阀|气泵|半导体|集成电路|线路板|印制电路|电池|手套|研发耗材/.test(text)) return '研发耗材';
  if (/开发板|电子设备|办公设备/.test(text)) return '办公设备';
  if (/技术服务|SERVICE|Service Tax/i.test(text)) return '技术服务';
  return /电子发票|INVOICE/i.test(text) ? '其他' : '附件';
}

function extractSeller(text, category, flightLike, boardingLike) {
  if (flightLike) return '航空行程校验单';
  if (boardingLike) return '登机凭证';
  if (/铁路电子客票|电子客票号|中国铁路|12306/.test(text)) return '中国铁路网络有限公司';
  // Spatial reading order puts the buyer and seller names on the same row.
  const nameRows = text.split('\n').filter(line => /名\s*称\s*[:：]/.test(line));
  for (const row of nameRows) {
    const names = [...row.matchAll(/名\s*称\s*[:：]\s*(.+?)(?=名\s*称\s*[:：]|统一社会|$)/g)].map(match => match[1].trim());
    if (names.length >= 2) return names[names.length - 1].replace(/\s+(?=[\u4e00-\u9fff])/g, '').trim();
  }
  const known = [
    /名称\s*[:：]\s*(滴滴出行科技有限公司(?:武汉分公司)?)/,
    /(山\s*东\s*航\s*空\s*股\s*份\s*有\s*限\s*公\s*司(?:\s*[（(]\s*网\s*上\s*直\s*营\s*渠\s*道\s*[）)])?)/,
    /(杭州深度求索人工智能基础技术研究有限公司)/,
    /(深圳市乐晓数字技术有限公司)/,
    /(深圳市集芯电子科技有限公司)/,
    /(武汉市洪山区宁宁宾馆)/,
    /(武汉市江汉区[^\s]{2,24}(?:商行|公司|店))/, 
    /(SEA\s+GAMER\s+MALL\s+SDN\s+BHD)/i
  ];
  for (const pattern of known) {
    const match = text.match(pattern);
    if (match) {
      const value = match[1].replace(/\s+/g, ' ').trim();
      return /^[\u4e00-\u9fff（）() ]+$/.test(value) ? value.replace(/\s+/g, '') : value;
    }
  }
  const names = [...text.matchAll(/名称\s*[:：]\s*([^\n]{3,45}?)(?=\s+统一社会信用代码|\s+名称\s*[:：]|\s+项目名称|$)/g)].map(m => m[1].trim());
  const seller = names.find(name => !/元思/.test(name) && !/\.pdf|研发耗材|合并发票|票据/.test(name));
  return seller ? seller.replace(/^名称\s*[:：]\s*/, '').trim() : `${category}票据（销售方待核对）`;
}

function detectFileOrderMeta(pageTexts) {
  const text = pageTexts.join(' ').replace(/\s+/g, ' ');
  const compact = text.replace(/\s+/g, '');
  const flightNumber = extractFlightNumberFromText(text);
  if (/登机凭证|BOARDINGPASS/i.test(compact)) return { type: 'flight-boarding', key: flightNumber };
  if (/行程校验单|机票总金额/.test(compact)) return { type: 'flight-itinerary', key: flightNumber };
  if (/电子发票|发票号码/i.test(compact) && (/航空|机票|旅客运输电子客票/.test(compact) || flightNumber)) return { type: 'flight-invoice', key: flightNumber };
  const didiInvoice = /电子发票/.test(compact) && /滴滴出行|旅客运输服务/.test(compact);
  if (didiInvoice) return { type: 'taxi-invoice', key: '' };
  if (/滴滴出行-?行程单|DIDITRAVEL-?TRIPTABLE/i.test(compact)) return { type: 'taxi-itinerary', key: '' };
  return { type: 'other', key: '' };
}

function inferPageOrderMetas(pageTexts) {
  return pageTexts.map(text => detectFileOrderMeta([text]));
}

function extractFlightNumberFromText(text) {
  const contextMatch = text.match(/(?:航\s*班(?:\s*号)?|FLIGHT)\s*[:：#]?\s*([A-Z0-9]{2})\s*([0-9OQDILZSBG]{3,5})/i);
  const match = contextMatch || text.match(/\b(CA|MU|CZ|HU|SC|MF|ZH|HO|FM|KN|JD|BK|GS|GJ|NS|EU|PN|TV|KY|QW|GX|AQ|LT|JR|RY|FU|UQ|DR|8L|9C|3U)\s*([0-9OQDILZSBG]{3,5})\b/i);
  if (!match) return '';
  const digitMap = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '8' };
  const digits = match[2].toUpperCase().replace(/[OQDILZSBG]/g, character => digitMap[character]);
  return `${match[1].toUpperCase()}${digits}`;
}

function makeRecord(values) {
  return { id: crypto.randomUUID(), date: '', number: '', category: '其他', seller: '', amount: null, included: true, status: 'review', source: '', page: 1, ...values };
}

function switchView(view) {
  state.activeView = view === 'sort' ? 'sort' : 'review';
  el('reviewView').classList.toggle('active', state.activeView === 'review');
  el('sortView').classList.toggle('active', state.activeView === 'sort');
  document.querySelectorAll('[data-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.view === state.activeView);
    button.setAttribute('aria-current', button.dataset.view === state.activeView ? 'page' : 'false');
  });
  if (state.activeView === 'sort') renderSortBoard();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderInvoiceTable() {
  const query = el('reviewSearch').value.trim().toLocaleLowerCase();
  const records = state.records.filter(record => (reviewFilter === 'all' || record.status === reviewFilter)
    && (!query || [record.date, record.number, record.seller, record.source, record.category, record.amount].some(value => String(value ?? '').toLocaleLowerCase().includes(query))));
  document.querySelectorAll('[data-filter]').forEach(button => {
    button.classList.toggle('active', button.dataset.filter === reviewFilter);
    button.setAttribute('aria-pressed', String(button.dataset.filter === reviewFilter));
  });
  document.querySelectorAll('[data-filter-count]').forEach(node => {
    node.textContent = node.dataset.filterCount === 'all' ? state.records.length : state.records.filter(record => record.status === node.dataset.filterCount).length;
  });
  el('reviewResultHint').textContent = query || reviewFilter !== 'all' ? `显示 ${records.length} / ${state.records.length} 条 · 筛选仅影响列表，导出包含本批全部票据` : `共 ${state.records.length} 条明细`;
  const body = el('invoiceBody');
  if (!state.records.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6"><div class="empty-illustration"><span>票</span></div><strong>明细会出现在这里</strong><p>上传 PDF 后，系统会自动拆分票据并提取金额。</p></td></tr>';
  } else if (!records.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6"><strong>没有匹配的票据</strong><p>试试其他关键词或切换识别状态。</p><button id="resetReviewFilters" class="secondary-button" type="button">显示全部票据</button></td></tr>';
    el('resetReviewFilters').addEventListener('click', () => { reviewFilter = 'all'; el('reviewSearch').value = ''; renderInvoiceTable(); el('reviewSearch').focus(); });
  } else {
    body.innerHTML = records.map(record => {
      const status = record.status === 'ready' ? ['已识别', ''] : record.status === 'attachment' ? ['附件', 'attachment'] : ['待核对', 'review'];
      const dateNumber = record.date || '日期待核对';
      const number = record.number || record.source;
      const pageLabel = record.pages?.length > 1 ? `第 ${record.pages.join('、')} 页，共 ${record.pages.length} 页` : (record.page ? `第 ${record.page} 页` : '');
      return `<tr class="invoice-row ${record.status === 'review' ? 'row-needs-review' : ''}">
        <td><span class="status-pill ${status[1]}">${status[0]}</span>${record.reviewReason ? `<span class="review-reason">${escapeHtml(record.reviewReason)}</span>` : ''}</td>
        <td><span class="cell-main">${escapeHtml(dateNumber)}</span><span class="cell-sub">${escapeHtml(number)}</span></td>
        <td><span class="category-chip">${escapeHtml(record.category)}</span></td>
        <td><span class="cell-main" title="${escapeHtml(record.seller)}">${escapeHtml(record.seller)}</span><span class="cell-sub">${escapeHtml(record.source)}${pageLabel ? ` · ${pageLabel}` : ''}</span></td>
        <td class="amount-col">${record.included && record.amount != null ? `¥ ${money.format(record.amount)}` : '—'}</td>
        <td><div class="row-actions"><button class="row-action preview-action" data-edit="${record.id}" aria-label="预览并修改此明细">核对修改</button></div></td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => openEdit(button.dataset.edit)));
  }
}

function render() {
  renderQueue();
  renderInvoiceTable();
  const included = state.records.filter(record => record.included && Number.isFinite(record.amount));
  const total = included.reduce((sum, record) => sum + record.amount, 0);
  const review = state.records.filter(record => record.status === 'review').length;
  const attachments = state.records.filter(record => record.status === 'attachment').length;
  el('totalAmount').textContent = money.format(total);
  el('invoiceCount').textContent = included.length;
  el('reviewCount').textContent = review;
  el('attachmentCount').textContent = attachments;
  el('totalHint').textContent = state.records.length ? (review ? '含待核对项目，请确认' : '已按有效票据汇总') : '等待添加票据';
  el('clearButton').disabled = state.busy || (!state.records.length && !state.files.length);
  el('exportButton').disabled = state.busy || !state.records.length;
  el('mergeButton').disabled = state.busy || !state.units.length;
  el('sortMergeButton').disabled = state.busy || !state.units.length;
  el('autoOrderButton').disabled = state.busy || state.units.length < 2;
  el('sortDateButton').disabled = state.busy || state.units.length < 2;
  el('sortImportButton').disabled = state.busy || state.units.length < 2;
  el('chooseButton').disabled = state.busy;
  fileInput.disabled = state.busy;
  el('demoButton').disabled = state.busy;
  el('openSortButton').disabled = !state.units.length;
  el('sortCount').textContent = state.units.length;
  el('sortExportButton').disabled = state.busy || !state.records.length;
  el('quickExportButton').disabled = state.busy || !state.records.length;
  el('quickMergeButton').disabled = state.busy || !state.units.length;
  el('sortAddButton').disabled = state.busy;
  el('reviewView').setAttribute('aria-busy', String(state.busy));
  el('batchNotice').textContent = state.files.length
    ? `${state.files.length} 个来源文件 · ${state.units.length} 页 · ${included.length} 张计费票据${state.duplicatePages ? ` · 已排除 ${state.duplicatePages} 张重复票据` : ''}${review ? ` · ${review} 条待核对，原图已保留` : ''}。可继续添加到本批。`
    : '可分多次添加文件，同一批票据会一直保留。';
  el('batchNotice').classList.toggle('has-review', review > 0);
  el('exportSummary').textContent = `${included.length} 张票据 · ${state.units.length} 页 · 合计 ¥${money.format(total)}`;
  el('sortSummary').textContent = `${state.units.length} 页 · ${included.length} 张票据 · 合计 ¥${money.format(total)}`;
  el('batchLabel').textContent = state.demo ? '匿名演示批次' : (state.files.length ? `${new Date().toLocaleDateString('zh-CN')} · ${state.files.length} 个文件` : '新建报销批次');
  renderSortBoard();
}

function renderQueue() {
  const queue = el('fileQueue');
  el('chooseButton').textContent = state.files.length ? '继续添加票据' : '选择文件';
  el('queueHeadLabel').textContent = state.files.length ? `已导入 ${state.files.length} 个文件` : '导入文件';
  if (!state.files.length) return queue.innerHTML = '<div class="queue-empty">还没有添加文件</div>';
  queue.innerHTML = state.files.map((item, index) => `<div class="file-item"><span class="drag-handle" aria-hidden="true">${item.kind === 'image' ? '▧' : item.kind === 'ofd' ? '◇' : '▤'}</span><span class="pdf-badge">${index + 1}</span><div><strong title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</strong><span>${formatBytes(item.file.size)}${item.pages ? ` · 拆分为 ${item.pages} 页` : ''}</span></div><b class="file-status">${item.status}</b></div>`).join('');
}

function renderSortBoard() {
  const board = el('sortBoard');
  el('pageDeleteNotice').hidden = !deletedPages.length;
  el('undoPageDeleteButton').disabled = state.busy;
  const lastDeleted = deletedPages[deletedPages.length - 1];
  if (lastDeleted) {
    const hasRemainingPages = state.units.some(unit => unit.recordId === lastDeleted.record.id);
    el('pageDeleteMessage').textContent = `已删除：${lastDeleted.unit.source} · 第 ${lastDeleted.unit.page} 页。此页不会导出。${hasRemainingPages ? '同一发票仍有保留页，金额仍按整张发票计一次。' : ''}`;
  }
  if (!state.units.length) {
    board.innerHTML = '<div class="sort-empty"><strong>还没有可排序的票据</strong><span>返回识别核对页添加文件</span></div>';
    return;
  }
  const typeName = { 'flight-boarding': '登机凭证', 'flight-invoice': '航空发票', 'flight-itinerary': '行程校验单', 'taxi-invoice': '打车发票', 'taxi-itinerary': '打车行程单', other: '票据页面' };
  board.innerHTML = state.units.map((unit, index) => {
    const record = state.records.find(item => item.id === unit.recordId);
    const continuation = record?.pages?.length > 1 && unit.page !== record.pages[0];
    const amount = continuation ? '续页 · 金额仅计一次' : record?.included && Number.isFinite(record.amount) ? `¥${money.format(record.amount)}` : '不计入金额';
    const groupIndices = state.units.map((item, position) => item.recordId === unit.recordId ? position : -1).filter(position => position >= 0);
    const firstInGroup = Math.min(...groupIndices), lastInGroup = Math.max(...groupIndices);
    return `<article class="sort-card ${record?.status === 'review' ? 'needs-review' : ''}" draggable="${!state.busy}" data-unit-id="${unit.id}">
      <header class="sort-card-head"><span class="sort-position">${index + 1}</span><span>${record?.status === 'review' ? '⚠ 待核对 · ' : ''}${escapeHtml(typeName[unit.orderMeta?.type] || '票据页面')} · 第 ${unit.page} 页${record?.pages?.length > 1 ? ` / 共 ${record.pages.length} 页` : ''}</span></header>
      <div class="sort-thumb"><canvas data-thumb="${unit.id}" aria-label="${escapeHtml(unit.source)}第${unit.page}页缩略图"></canvas><button type="button" data-unit-preview="${unit.id}" aria-label="放大预览第${index + 1}个票据">预览</button></div>
      <div class="sort-card-body"><strong title="${escapeHtml(unit.source)}">${escapeHtml(record?.seller || unit.source)}</strong><p><span>${escapeHtml(record?.category || '附件')} · ${escapeHtml(record?.date || '日期待核对')} · ${escapeHtml(unit.orderMeta?.key || '独立页面')}</span><b>${amount}</b></p>${record?.reviewReason ? `<span class="review-reason">${escapeHtml(record.reviewReason)}</span>` : ''}<div class="sort-card-reorder"><span>调整位置</span><button type="button" data-unit-move="${unit.id}" data-direction="-1" aria-label="前移第${index + 1}个票据" ${state.busy || firstInGroup === 0 ? 'disabled' : ''}>前移</button><button type="button" data-unit-move="${unit.id}" data-direction="1" aria-label="后移第${index + 1}个票据" ${state.busy || lastInGroup === state.units.length - 1 ? 'disabled' : ''}>后移</button></div><div class="sort-card-actions"><button class="mini-button" type="button" data-unit-edit="${record?.id}">核对修改</button><button class="mini-button delete-page-button" type="button" data-unit-delete="${unit.id}" aria-label="删除第${index + 1}个票据页面" ${state.busy ? 'disabled' : ''}>删除此页</button></div></div>
    </article>`;
  }).join('');

  board.querySelectorAll('[data-unit-preview]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    openPreview(button.dataset.unitPreview);
  }));
  board.querySelectorAll('[data-unit-edit]').forEach(button => button.addEventListener('click', () => openEdit(button.dataset.unitEdit)));
  board.querySelectorAll('[data-unit-delete]').forEach(button => button.addEventListener('click', () => deletePage(button.dataset.unitDelete)));
  board.querySelectorAll('[data-unit-move]').forEach(button => button.addEventListener('click', () => moveInvoiceGroup(button.dataset.unitMove, Number(button.dataset.direction))));
  let draggedId = '';
  board.querySelectorAll('[data-unit-id]').forEach(card => {
    card.addEventListener('dragstart', event => { draggedId = card.dataset.unitId; card.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; });
    card.addEventListener('dragend', () => { draggedId = ''; board.querySelectorAll('.sort-card').forEach(node => node.classList.remove('dragging', 'drag-over')); });
    card.addEventListener('dragover', event => { event.preventDefault(); if (card.dataset.unitId !== draggedId) card.classList.add('drag-over'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', event => {
      event.preventDefault();
      if (!draggedId || draggedId === card.dataset.unitId) return;
      const from = state.units.findIndex(unit => unit.id === draggedId);
      const to = state.units.findIndex(unit => unit.id === card.dataset.unitId);
      if (from < 0 || to < 0 || state.units[from].recordId === state.units[to].recordId) return;
      const moving = state.units.filter(unit => unit.recordId === state.units[from].recordId);
      const targetId = state.units[to].id;
      state.units = state.units.filter(unit => !moving.includes(unit));
      const targetIndex = state.units.findIndex(unit => unit.id === targetId);
      state.units.splice(targetIndex < 0 ? state.units.length : targetIndex, 0, ...moving);
      syncRecordsToUnits();
      el('sortOrderLabel').textContent = '当前顺序：手动调整';
      render();
      toast('已更新页面导出顺序');
    });
  });
  board.querySelectorAll('[data-thumb]').forEach(canvas => {
    const unit = state.units.find(item => item.id === canvas.dataset.thumb);
    renderUnitThumbnail(unit, canvas).catch(error => console.warn('thumbnail', error));
  });
}

function moveInvoiceGroup(id, direction) {
  if (state.busy) return;
  const unit = state.units.find(unit => unit.id === id);
  if (!unit) return;
  const moving = state.units.filter(item => item.recordId === unit.recordId);
  const edgeIndex = direction < 0 ? state.units.indexOf(moving[0]) : state.units.indexOf(moving[moving.length - 1]);
  const neighbor = state.units[edgeIndex + direction];
  if (!neighbor || neighbor.recordId === unit.recordId) return;
  state.units = state.units.filter(item => item.recordId !== unit.recordId);
  const target = state.units.filter(item => item.recordId === neighbor.recordId);
  const insertAt = direction < 0 ? state.units.indexOf(target[0]) : state.units.indexOf(target[target.length - 1]) + 1;
  state.units.splice(insertAt, 0, ...moving);
  syncRecordsToUnits();
  el('sortOrderLabel').textContent = '当前顺序：手动调整';
  render();
  const controls = [...el('sortBoard').querySelectorAll(`[data-unit-move="${id}"]`)];
  (controls.find(button => !button.disabled && Number(button.dataset.direction) === direction) || controls.find(button => !button.disabled))?.focus();
  toast(moving.length > 1 ? `已整体移动同一发票的 ${moving.length} 页` : '已更新页面导出顺序');
}

function syncRecordPages(record) {
  record.pages = state.units.filter(unit => unit.recordId === record.id).map(unit => unit.page).sort((a, b) => a - b);
  record.page = record.pages[0];
  record.pageCount = record.pages.length;
}

function rebuildInvoiceKeys() {
  state.invoiceKeys.clear();
  state.records.filter(record => (record.included || record.linkedInvoiceId) && Number.isFinite(record.amount)).forEach(record => {
    const unit = state.units.find(unit => unit.recordId === record.id);
    invoiceDedupKeys(record, unit?.text || '').forEach(key => state.invoiceKeys.add(key));
  });
}

function deletePage(id) {
  if (state.busy) return;
  const index = state.units.findIndex(unit => unit.id === id);
  const unit = state.units[index];
  const record = state.records.find(record => record.id === unit?.recordId);
  if (!unit || !record) return;
  deletedPages.push({ unit, record: { ...record, pages: [...(record.pages || [record.page])] }, index,
    previousId: state.units[index - 1]?.id, nextId: state.units[index + 1]?.id });
  state.units.splice(index, 1);
  if (state.units.some(item => item.recordId === record.id)) syncRecordPages(record);
  else state.records = state.records.filter(item => item !== record);
  reconcileFlightAmounts();
  rebuildInvoiceKeys();
  syncRecordsToUnits();
  render();
  const cards = el('sortBoard').querySelectorAll('[data-unit-delete]');
  (cards[Math.min(index, cards.length - 1)] || el('undoPageDeleteButton')).focus({ preventScroll: true });
  toast('已删除此页，可在排序页撤销；原始文件保持完整');
}

function undoPageDelete() {
  if (state.busy || !deletedPages.length) return;
  const deletion = deletedPages[deletedPages.length - 1];
  let record = state.records.find(record => record.id === deletion.record.id);
  if (!record && Number.isFinite(deletion.record.amount)) {
    const keys = invoiceDedupKeys(deletion.record, deletion.unit.text || '');
    if (keys.some(key => state.invoiceKeys.has(key))) return toast('本批已有相同发票，请先移除重复项再撤销');
  }
  deletedPages.pop();
  if (!record) {
    record = { ...deletion.record };
    state.records.push(record);
  }
  const nextIndex = state.units.findIndex(unit => unit.id === deletion.nextId);
  const previousIndex = state.units.findIndex(unit => unit.id === deletion.previousId);
  const index = nextIndex >= 0 ? nextIndex : previousIndex >= 0 ? previousIndex + 1 : Math.min(deletion.index, state.units.length);
  state.units.splice(index, 0, deletion.unit);
  syncRecordPages(record);
  reconcileFlightAmounts();
  rebuildInvoiceKeys();
  syncRecordsToUnits();
  render();
  el('sortBoard').querySelector(`[data-unit-delete="${deletion.unit.id}"]`)?.focus({ preventScroll: true });
  toast('已恢复页面，并同步更新明细和合计');
}

async function renderUnitThumbnail(unit, canvas) {
  const fileItem = state.files.find(item => item.id === unit?.fileId);
  if (!fileItem?.pdfDoc || !canvas.isConnected) return;
  const page = await fileItem.pdfDoc.getPage(unit.page);
  const viewport = page.getViewport({ scale: 1 });
  const scale = Math.min(210 / viewport.width, 225 / viewport.height) * Math.min(1.6, window.devicePixelRatio || 1);
  const renderViewport = page.getViewport({ scale });
  canvas.width = Math.ceil(renderViewport.width);
  canvas.height = Math.ceil(renderViewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderViewport }).promise;
}

function autoArrangeFiles(silent = false) {
  const original = [...state.units];
  const groups = [];
  const flightTypes = ['flight-boarding', 'flight-invoice', 'flight-itinerary'];
  const flightRank = { 'flight-boarding': 0, 'flight-invoice': 1, 'flight-itinerary': 2 };
  const flightKeys = [...new Set(original.map(unit => unit.orderMeta?.key).filter(Boolean))];
  flightKeys.forEach(key => {
    const items = original.filter(unit => unit.orderMeta?.key === key && flightTypes.includes(unit.orderMeta?.type));
    if (new Set(items.map(unit => unit.orderMeta.type)).size >= 2) groups.push(items);
  });
  const unitAmount = unit => state.records.find(record => record.id === unit.recordId)?.amount;
  const knownPrefixes = ['CA','MU','CZ','HU','SC','MF','ZH','HO','FM','KN','JD','BK','GS','GJ','NS','EU','PN','TV','KY','QW','GX','AQ','LT','JR','RY','FU','UQ','DR','8L','9C','3U'];
  const looseInvoices = original.filter(unit => unit.orderMeta?.type === 'flight-invoice' && !knownPrefixes.some(prefix => unit.orderMeta?.key?.startsWith(prefix)));
  looseInvoices.forEach(invoice => {
    const invoiceAmount = unitAmount(invoice);
    const amountMatches = groups.filter(group => group.some(unit => unit.orderMeta.type === 'flight-itinerary' && Number.isFinite(invoiceAmount) && unitAmount(unit) === invoiceAmount));
    const seller = state.records.find(record => record.id === invoice.recordId)?.seller || '';
    const prefix = flightPrefixFromSeller(seller);
    const airlineMatches = prefix ? groups.filter(group => group.some(unit => unit.orderMeta?.key?.startsWith(prefix))) : [];
    const target = amountMatches.length === 1 ? amountMatches[0]
      : airlineMatches.length === 1 ? airlineMatches[0]
      : (groups.length === 1 && !groups[0].some(unit => unit.orderMeta.type === 'flight-invoice') ? groups[0] : null);
    if (target) {
      const matchedKey = target.find(unit => unit.orderMeta?.key)?.orderMeta?.key || '';
      if (matchedKey) invoice.orderMeta.key = matchedKey;
      target.push(invoice);
    }
  });
  groups.forEach(group => group.sort((a, b) => flightRank[a.orderMeta.type] - flightRank[b.orderMeta.type]));
  const taxiInvoices = original.filter(unit => unit.orderMeta?.type === 'taxi-invoice');
  const availableTrips = original.filter(unit => unit.orderMeta?.type === 'taxi-itinerary');
  taxiInvoices.forEach(invoice => {
    const candidates = availableTrips.filter(trip => !trip.__paired).sort((a, b) => {
      const sameFileA = a.fileId === invoice.fileId ? 0 : 1;
      const sameFileB = b.fileId === invoice.fileId ? 0 : 1;
      return sameFileA - sameFileB || Math.abs(a.page - invoice.page) - Math.abs(b.page - invoice.page);
    });
    const trip = candidates[0];
    if (trip) {
      trip.__paired = true;
      groups.push([invoice, trip]);
    }
  });
  availableTrips.forEach(trip => delete trip.__paired);
  if (!groups.length) {
    if (!silent) toast('未从票面识别出可自动配对的凭证，可直接拖动排序');
    return;
  }

  const memberToGroup = new Map();
  groups.forEach((group, index) => group.forEach(unit => memberToGroup.set(unit.id, index)));
  const emitted = new Set();
  const arranged = [];
  original.forEach(unit => {
    const groupIndex = memberToGroup.get(unit.id);
    if (groupIndex == null) arranged.push(unit);
    else if (!emitted.has(groupIndex)) {
      arranged.push(...groups[groupIndex]);
      emitted.add(groupIndex);
    }
  });
  state.units = arranged;
  el('sortOrderLabel').textContent = '当前顺序：凭证配对';
  syncRecordsToUnits();
  if (!silent) {
    render();
    toast('已按票面内容完成凭证配对排序');
  }
}

function restoreImportOrder() {
  if (state.busy) return;
  state.units.sort((a, b) => a.importOrder - b.importOrder);
  el('sortOrderLabel').textContent = '当前顺序：导入顺序';
  syncRecordsToUnits();
  render();
  toast('已恢复文件导入顺序及原始页序');
}

function sortByInvoiceDate(silent = false) {
  if (state.units.length < 2) {
    if (!silent) toast('至少需要两张可识别票据');
    return;
  }
  const flightTypes = ['flight-boarding', 'flight-invoice', 'flight-itinerary'];
  const flightRank = { 'flight-boarding': 0, 'flight-invoice': 1, 'flight-itinerary': 2 };
  const groups = [];
  const consumed = new Set();
  const dateOf = unit => state.records.find(record => record.id === unit.recordId)?.date || '';
  const groupDate = units => {
    const invoices = units.filter(unit => state.records.find(record => record.id === unit.recordId)?.included);
    return (invoices.length ? invoices : units).map(dateOf).filter(Boolean).sort()[0] || '';
  };
  state.units.forEach((unit, index) => {
    if (consumed.has(unit.id)) return;
    let members = [unit];
    const key = unit.orderMeta?.key;
    const record = state.records.find(record => record.id === unit.recordId);
    if (record?.pages?.length > 1) {
      members = state.units.filter(candidate => candidate.recordId === unit.recordId).sort((a,b) => a.page-b.page);
    } else if (key && flightTypes.includes(unit.orderMeta?.type)) {
      members = state.units.filter(candidate => candidate.orderMeta?.key === key && flightTypes.includes(candidate.orderMeta?.type));
    } else if (unit.orderMeta?.type === 'taxi-invoice') {
      const following = state.units[index + 1];
      if (following?.orderMeta?.type === 'taxi-itinerary' && !consumed.has(following.id)) members = [unit, following];
    }
    members.forEach(candidate => consumed.add(candidate.id));
    if (members.some(candidate => flightTypes.includes(candidate.orderMeta?.type))) {
      members.sort((a, b) => (flightRank[a.orderMeta?.type] ?? 9) - (flightRank[b.orderMeta?.type] ?? 9));
    }
    groups.push({ members, date: groupDate(members), index });
  });
  groups.sort((a, b) => {
    if (!a.date && !b.date) return a.index - b.index;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date) || a.index - b.index;
  });
  state.units = groups.flatMap(group => group.members);
  el('sortOrderLabel').textContent = '当前顺序：开票日期从早到晚';
  syncRecordsToUnits();
  if (!silent) {
    render();
    toast('已按开票日期从早到晚排序，无法识别日期的页面放在最后');
  }
}

function syncRecordsToUnits() {
  const rank = new Map();
  state.units.forEach((unit,index) => { if (!rank.has(unit.recordId)) rank.set(unit.recordId,index); });
  state.records.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

function flightPrefixFromSeller(seller) {
  const mapping = [
    [/山东航空/, 'SC'], [/南方航空/, 'CZ'], [/中国国航|国际航空/, 'CA'], [/东方航空/, 'MU'],
    [/海南航空/, 'HU'], [/厦门航空/, 'MF'], [/深圳航空/, 'ZH'], [/吉祥航空/, 'HO'], [/四川航空/, '3U']
  ];
  return mapping.find(([pattern]) => pattern.test(seller))?.[1] || '';
}

function openEdit(id, selectedPage = null) {
  const record = state.records.find(item => item.id === id);
  if (!record) return;
  el('editId').value = id;
  el('editDate').value = record.date;
  el('editCategory').value = ['交通','住宿','机票','保险','研发耗材','技术服务','办公设备','其他','附件'].includes(record.category) ? record.category : '其他';
  el('editSeller').value = record.seller;
  el('editNumber').value = record.number;
  el('editAmount').value = record.amount ?? '';
  el('editIncluded').value = String(record.included);
  el('editPreviewTitle').textContent = `${record.source}${record.page ? ` · 第 ${record.page} 页` : ''}`;
  el('editPreviewLoading').textContent = '正在生成票面…';
  el('editPreviewLoading').hidden = false;
  el('editStatusHint').textContent = record.reviewReason || (record.pages?.length > 1 ? `此发票共 ${record.pages.length} 页，金额只计算一次。` : '对照票面修改信息，保存后更新合计。');
  const pageSelect = el('editPageSelect');
  pageSelect.innerHTML = (record.pages || [record.page]).map(page => `<option value="${page}">第 ${page} 页</option>`).join('');
  pageSelect.value = String(record.pages?.includes(selectedPage) ? selectedPage : record.page);
  pageSelect.hidden = !(record.pages?.length > 1);
  el('editDialog').showModal();
  editPreviewState.rotation = 0;
  resetTransform(editPreviewState, el('editPreviewCanvas'), el('editZoomReset'));
  requestAnimationFrame(() => renderRecordPreview(record));
}

async function openPreview(id) {
  const unit = state.units.find(item => item.id === id);
  const record = state.records.find(item => item.id === unit?.recordId);
  const fileItem = state.files.find(item => item.id === unit?.fileId);
  if (!unit || !fileItem?.pdfDoc) return toast('当前票据暂时无法预览');

  previewState.unitId = unit.id;
  previewState.rotation = 0;
  updatePreviewNavigation();

  el('previewTitle').textContent = unit.source;
  const pageLabel = record?.pages?.length > 1 ? `第 ${unit.page} 页（共 ${record.pages.length} 页）` : `第 ${unit.page} 页`;
  el('previewMeta').textContent = `${pageLabel} · ${record?.category || '附件'} · ${record?.amount == null ? '金额待核对' : `¥${money.format(record.amount)}`}`;
  renderPreviewDetails(record, unit);
  el('previewLoading').hidden = false;
  el('previewLoading').textContent = '正在生成预览…';
  if (!el('previewDialog').open) {
    el('previewDialog').showModal();
    el('closePreviewButton').focus({ preventScroll: true });
  }
  el('previewDetails').parentElement.scrollTop = 0;
  resetPreviewTransform();

  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    await renderPdfPageToCanvas(fileItem, unit.page, el('previewCanvas'), previewStage, el('previewLoading'), previewState.rotation);
  } catch (error) {
    console.error(error);
    el('previewLoading').textContent = '预览生成失败，请关闭后重试';
  }
}

function stepPreview(direction) {
  const currentIndex = state.units.findIndex(unit => unit.id === previewState.unitId);
  if (currentIndex < 0) return;
  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= state.units.length) return;
  openPreview(state.units[nextIndex].id);
}

function renderPreviewDetails(record, unit) {
  const hasAmount = Number.isFinite(record?.amount);
  const included = record?.included && hasAmount;
  const status = record?.status === 'review' ? '待核对' : record?.status === 'attachment' ? '附件' : '已识别';
  const fields = [
    ['开票日期', record?.date || '未识别'],
    ['票据类别', record?.category || '未识别'],
    ['销售方', record?.seller || '未识别'],
    ['发票 / 凭证号码', record?.number || '未识别'],
    ['来源页码', record?.pages?.length > 1 ? `第 ${unit.page} 页 · 同一发票共 ${record.pages.length} 页` : `第 ${unit.page} 页`]
  ];
  el('previewDetails').innerHTML = `<div class="preview-amount"><span>票据金额（元）</span><strong>${hasAmount ? `¥${money.format(record.amount)}` : '未识别'}</strong><p>${included ? '计入本批合计' : '未计入本批合计'}${record?.pages?.length > 1 ? ' · 多页金额仅计一次' : ''}</p></div>
    <div class="preview-record-status ${record?.status === 'review' ? 'needs-review' : ''}"><strong>${status}</strong><p>${escapeHtml(record?.reviewReason || (included ? '请对照原始票面核对以下信息。' : '此票据保留在导出文件中，不计入金额。'))}</p></div>
    <dl class="preview-fields">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
  el('previewEditButton').disabled = !record;
}

function updatePreviewNavigation() {
  const index = state.units.findIndex(unit => unit.id === previewState.unitId);
  const prev = el('previewPrevButton');
  const next = el('previewNextButton');
  prev.disabled = index <= 0;
  next.disabled = index < 0 || index >= state.units.length - 1;
  prev.title = index > 0 ? `上一张（第 ${index} 张）` : '已经是第一张';
  next.title = index >= 0 && index < state.units.length - 1 ? `下一张（第 ${index + 2} 张）` : '已经是最后一张';
  el('previewPosition').textContent = `${index + 1} / ${state.units.length} 页`;
}

async function renderRecordPreview(record) {
  const fileItem = state.files.find(item => item.id === record.fileId);
  const loading = el('editPreviewLoading');
  const canvas = el('editPreviewCanvas');
  const pageNo = Number(el('editPageSelect').value) || record.page || 1;
  el('editPreviewTitle').textContent = `${record.source} · 第 ${pageNo} 页`;
  if (!fileItem?.pdfDoc) {
    canvas.width = 1;
    canvas.height = 1;
    loading.textContent = state.demo ? '演示数据没有原始票面' : '当前明细没有可预览页面';
    loading.hidden = false;
    return;
  }
  try {
    await renderPdfPageToCanvas(fileItem, pageNo, canvas, el('editPreviewStage'), loading, editPreviewState.rotation);
  } catch (error) {
    console.error(error);
    loading.textContent = '票面生成失败，请关闭后重试';
  }
}

async function renderPdfPageToCanvas(fileItem, pageNo, canvas, stage, loading, rotation = 0) {
  const previous = canvasTasks.get(canvas);
  const request = { task: null };
  canvasTasks.set(canvas, request);
  previous?.task?.cancel();
  if (previous?.task) await previous.task.promise.catch(() => {});
  const page = await fileItem.pdfDoc.getPage(pageNo);
  if (canvasTasks.get(canvas) !== request) return;
  const finalRotation = (page.rotate + rotation) % 360;
  const unitViewport = page.getViewport({ scale: 1, rotation: finalRotation });
  const availableWidth = Math.max(1, stage.clientWidth - 32);
  const availableHeight = Math.max(1, stage.clientHeight - 32);
  const fitScale = Math.min(availableWidth / unitViewport.width, availableHeight / unitViewport.height);
  const renderScale = Math.max(1.5, fitScale * Math.min(2.2, window.devicePixelRatio || 1));
  const renderViewport = page.getViewport({ scale: renderScale, rotation: finalRotation });
  canvas.width = Math.ceil(renderViewport.width);
  canvas.height = Math.ceil(renderViewport.height);
  canvas.style.width = `${Math.round(unitViewport.width * fitScale)}px`;
  canvas.style.height = `${Math.round(unitViewport.height * fitScale)}px`;
  request.task = page.render({ canvasContext: canvas.getContext('2d'), viewport: renderViewport });
  try { await request.task.promise; } catch (error) { if (error.name !== 'RenderingCancelledException') throw error; }
  if (canvasTasks.get(canvas) === request) loading.hidden = true;
}

function setPreviewZoom(value) {
  setTransformZoom(previewState, value, el('previewCanvas'), el('zoomResetButton'));
}

function resetPreviewTransform() {
  resetTransform(previewState, el('previewCanvas'), el('zoomResetButton'));
}

async function rotateCurrentPreview() {
  const unit = state.units.find(item => item.id === previewState.unitId);
  const record = state.records.find(item => item.id === unit?.recordId);
  const fileItem = state.files.find(item => item.id === unit?.fileId);
  if (!unit || !record || !fileItem?.pdfDoc) return;
  previewState.rotation = (previewState.rotation + 270) % 360;
  resetPreviewTransform();
  el('previewLoading').hidden = false;
  await renderPdfPageToCanvas(fileItem, unit.page, el('previewCanvas'), previewStage, el('previewLoading'), previewState.rotation);
}

async function rotateEditPreview() {
  const record = state.records.find(item => item.id === el('editId').value);
  const fileItem = state.files.find(item => item.id === record?.fileId);
  if (!record || !fileItem?.pdfDoc) return;
  editPreviewState.rotation = (editPreviewState.rotation + 270) % 360;
  resetTransform(editPreviewState, el('editPreviewCanvas'), el('editZoomReset'));
  el('editPreviewLoading').hidden = false;
  await renderPdfPageToCanvas(fileItem, Number(el('editPageSelect').value) || record.page || 1, el('editPreviewCanvas'), el('editPreviewStage'), el('editPreviewLoading'), editPreviewState.rotation);
}

function applyPreviewTransform() {
  applyTransform(previewState, el('previewCanvas'), el('zoomResetButton'));
}

function setupPanZoom(stage, canvas, transform, label) {
  stage.addEventListener('wheel', event => {
    event.preventDefault();
    setTransformZoom(transform, transform.zoom + (event.deltaY < 0 ? .14 : -.14), canvas, label);
  }, { passive: false });
  stage.addEventListener('dblclick', () => resetTransform(transform, canvas, label));
  stage.addEventListener('pointerdown', event => {
    transform.dragging = true;
    transform.startX = event.clientX;
    transform.startY = event.clientY;
    transform.originX = transform.x;
    transform.originY = transform.y;
    stage.classList.add('dragging');
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (!transform.dragging) return;
    transform.x = transform.originX + event.clientX - transform.startX;
    transform.y = transform.originY + event.clientY - transform.startY;
    applyTransform(transform, canvas, label);
  });
  ['pointerup', 'pointercancel'].forEach(name => stage.addEventListener(name, event => {
    transform.dragging = false;
    stage.classList.remove('dragging');
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  }));
}

function setTransformZoom(transform, value, canvas, label) {
  transform.zoom = Math.min(4, Math.max(.5, value));
  applyTransform(transform, canvas, label);
}

function resetTransform(transform, canvas, label) {
  Object.assign(transform, { zoom: 1, x: 0, y: 0 });
  applyTransform(transform, canvas, label);
}

function applyTransform(transform, canvas, label) {
  canvas.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`;
  label.textContent = `${Math.round(transform.zoom * 100)}%`;
}

function saveEdit(event) {
  event.preventDefault();
  const record = state.records.find(item => item.id === el('editId').value);
  if (!record) return;
  const value = el('editAmount').value;
  if (el('editIncluded').value === 'true' && (value === '' || !Number.isFinite(Number(value)))) return toast('请先输入有效金额，再计入合计');
  const newNumber = el('editNumber').value.trim().replace(/\s/g,'').toUpperCase();
  if (el('editIncluded').value === 'true' && newNumber.length >= 10 && state.records.some(candidate => candidate !== record && candidate.included && candidate.number.replace(/\s/g,'').toUpperCase() === newNumber)) return toast('本批次已有相同票号，请核对后保存，避免重复计算');
  if (record.linkedInvoiceId) record.linkOverride = true;
  Object.assign(record, {
    date: el('editDate').value,
    category: el('editCategory').value,
    seller: el('editSeller').value.trim() || '销售方待核对',
    number: el('editNumber').value.trim(),
    amount: value === '' ? null : Number(value),
    included: el('editIncluded').value === 'true',
    status: el('editIncluded').value === 'false' ? 'attachment' : 'ready',
    reviewReason: ''
  });
  reconcileFlightAmounts();
  el('editDialog').close();
  render();
  toast('已更新，合计金额已重新计算');
}

function exportCsv() {
  const rows = [['序号','开票日期','票据类别','销售方','发票号码或凭证号','金额（元）','是否计入合计','来源文件','识别状态']];
  state.records.forEach((record, index) => rows.push([index + 1, record.date, record.category, record.seller, record.number, record.amount ?? '', record.included ? '是' : '否', record.source, record.status === 'ready' ? '已确认' : record.status === 'attachment' ? '附件' : '待核对']));
  const total = state.records.filter(r => r.included && Number.isFinite(r.amount)).reduce((sum, r) => sum + r.amount, 0);
  rows.push(['','','','','合计', total.toFixed(2),'','','']);
  const csv = '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `报销明细-${dateStamp()}.csv`);
  toast('明细已导出');
}

async function mergePdfs() {
  if (!window.PDFLib || !state.units.length) return;
  const buttons = [el('mergeButton'), el('sortMergeButton'), el('quickMergeButton')];
  buttons.forEach(button => { button.disabled = true; button.dataset.label = button.textContent; button.textContent = '正在合并…'; });
  try {
    const merged = await window.PDFLib.PDFDocument.create();
    const sources = new Map();
    for (const unit of state.units) {
      const item = state.files.find(candidate => candidate.id === unit.fileId);
      if (!item?.pdfBytes) continue;
      if (!sources.has(item.id)) sources.set(item.id, await window.PDFLib.PDFDocument.load(item.pdfBytes));
      const [page] = await merged.copyPages(sources.get(item.id), [unit.page - 1]);
      merged.addPage(page);
    }
    const bytes = await merged.save();
    const included = state.records.filter(record => record.included && Number.isFinite(record.amount));
    const total = included.reduce((sum, record) => sum + record.amount, 0);
    const filename = `${dateTimeStamp()}-${included.length}张-${total.toFixed(2)}元-合并发票.pdf`;
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
    toast(`已按当前顺序合并 ${state.units.length} 个页面`);
  } catch (error) {
    console.error(error);
    toast('合并失败，请检查 PDF 是否加密');
  } finally {
    buttons.forEach(button => { button.textContent = button.dataset.label || '合并 PDF'; button.disabled = false; });
  }
}

function clearAll() {
  reviewFilter = 'all';
  el('reviewSearch').value = '';
  deletedPages.length = 0;
  state.files.forEach(item => item.pdfDoc?.destroy?.());
  state.files = [];
  state.records = [];
  state.units = [];
  state.skippedPages = 0;
  state.duplicatePages = 0;
  state.invoiceKeys.clear();
  state.demo = false;
  el('sortOrderLabel').textContent = '当前顺序：导入顺序';
  fileInput.value = '';
  switchView('review');
  render();
  toast('已清空当前批次');
}

function resetBatch() {
  reviewFilter = 'all';
  el('reviewSearch').value = '';
  deletedPages.length = 0;
  state.files.forEach(item => item.pdfDoc?.destroy?.());
  state.files = [];
  state.records = [];
  state.units = [];
  state.skippedPages = 0;
  state.duplicatePages = 0;
  state.invoiceKeys.clear();
  fileInput.value = '';
}

function setProgress(show, value, label) {
  el('recognitionProgress').setAttribute('aria-valuenow', String(Math.min(100, Math.max(0, value))));
  el('progressWrap').hidden = !show;
  el('progressBar').style.transform = `scaleX(${Math.min(100, value) / 100})`;
  el('progressValue').textContent = `${Math.min(100, value)}%`;
  el('progressText').textContent = label;
}

function csvCell(value) { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function formatBytes(bytes) { return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
function dateStamp() { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
function dateTimeStamp() { const d = new Date(); return `${dateStamp()}-${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`; }
function downloadBlob(blob, name) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function toast(message) { const node = el('toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2600); }

render();
