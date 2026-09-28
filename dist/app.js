import * as pdfjsLib from './vendor/pdf.min.mjs';
import { getDocument as getOfdDocument } from './vendor/ofdjs.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const state = { files: [], records: [], units: [], demo: false, activeView: 'review' };
const previewState = { zoom: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 };
const editPreviewState = { zoom: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 };
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
dropZone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') fileInput.click(); });
fileInput.addEventListener('change', () => addFiles(fileInput.files));
['dragenter', 'dragover'].forEach(name => dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(name => dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', event => addFiles(event.dataTransfer.files));

el('demoButton').addEventListener('click', () => {
  state.demo = true;
  state.records = demoRecords.map(record => ({ ...record }));
  render();
  toast('已载入匿名演示数据；上传文件即可替换');
});
el('clearButton').addEventListener('click', clearAll);
el('exportButton').addEventListener('click', exportCsv);
el('mergeButton').addEventListener('click', mergePdfs);
el('sortMergeButton').addEventListener('click', mergePdfs);
el('autoOrderButton').addEventListener('click', autoArrangeFiles);
el('openSortButton').addEventListener('click', () => switchView('sort'));
el('backReviewButton').addEventListener('click', () => switchView('review'));
el('saveEdit').addEventListener('click', saveEdit);
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
el('closePreviewButton').addEventListener('click', () => el('previewDialog').close());
el('zoomInButton').addEventListener('click', () => setPreviewZoom(previewState.zoom + .2));
el('zoomOutButton').addEventListener('click', () => setPreviewZoom(previewState.zoom - .2));
el('zoomResetButton').addEventListener('click', resetPreviewTransform);

const previewStage = el('previewStage');
setupPanZoom(previewStage, el('previewCanvas'), previewState, el('zoomResetButton'));
setupPanZoom(el('editPreviewStage'), el('editPreviewCanvas'), editPreviewState, el('editZoomReset'));
el('editZoomIn').addEventListener('click', () => setTransformZoom(editPreviewState, editPreviewState.zoom + .2, el('editPreviewCanvas'), el('editZoomReset')));
el('editZoomOut').addEventListener('click', () => setTransformZoom(editPreviewState, editPreviewState.zoom - .2, el('editPreviewCanvas'), el('editZoomReset')));
el('editZoomReset').addEventListener('click', () => resetTransform(editPreviewState, el('editPreviewCanvas'), el('editZoomReset')));

async function addFiles(fileList) {
  const incoming = [...fileList].filter(isSupportedFile);
  if (!incoming.length) return toast('请选择 PDF、OFD 或图片文件');
  state.demo = false;
  state.files.forEach(item => item.pdfDoc?.destroy?.());
  state.files = incoming.map((file, i) => ({ file, id: `${Date.now()}-${i}`, status: '等待识别', pages: 0, kind: '' }));
  state.records = [];
  state.units = [];
  render();
  setProgress(true, 2, '正在检查文件真实格式…');

  for (let i = 0; i < state.files.length; i++) {
    const item = state.files[i];
    item.status = '识别中';
    renderQueue();
    try {
      await processFile(item, i, state.files.length);
      item.status = '已完成';
    } catch (error) {
      console.error(error);
      item.status = '识别失败';
      state.records.push(makeRecord({ seller: '识别失败，请手动核对', category: '附件', status: 'review', source: item.file.name, included: false }));
    }
    render();
  }
  setProgress(false, 100, '识别完成');
  const review = state.records.filter(record => record.status === 'review').length;
  toast(review ? `已拆分 ${state.units.length} 个页面，有 ${review} 条需要核对` : `已拆分 ${state.units.length} 个页面，可进入排序匹配`);
}

async function processFile(item, fileIndex, fileCount) {
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  const kind = detectRealFileKind(bytes, item.file);
  item.kind = kind;
  if (kind === 'image') return processImageFile(item, bytes, fileIndex, fileCount);
  if (kind === 'ofd') return processOfdFile(item, bytes, fileIndex, fileCount);
  if (kind !== 'pdf') throw new Error('Unsupported file format');
  return processPdfBytes(item, bytes, fileIndex, fileCount);
}

async function processPdfBytes(item, bytes, fileIndex, fileCount, providedTexts = null) {
  item.pdfBytes = bytes;
  const pdf = await pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: './cmaps/',
    cMapPacked: true,
    standardFontDataUrl: './standard_fonts/',
    wasmUrl: './wasm/',
    useSystemFonts: true
  }).promise;
  item.pdfDoc = pdf;
  item.pages = pdf.numPages;
  const pageTexts = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = providedTexts ? null : await page.getTextContent();
    let text = providedTexts?.[pageNo - 1] || content?.items.map(token => token.str).join(' ').replace(/\s+/g, ' ').trim() || '';
    const pct = Math.round(((fileIndex + (pageNo / pdf.numPages)) / fileCount) * 88);
    setProgress(true, pct, `识别 ${item.file.name} · 第 ${pageNo}/${pdf.numPages} 页`);
    if (text.length < 45 || (!providedTexts && /\.ofd$/i.test(item.file.name))) {
      const ocrText = await ocrPage(page, pct, item.file.name).catch(() => '');
      text = `${text} ${ocrText}`.replace(/\s+/g, ' ').trim();
    }
    pageTexts.push(text);
  }
  const pageMetas = inferPageOrderMetas(pageTexts);
  item.orderMeta = detectFileOrderMeta(pageTexts);
  const records = parsePages(pageTexts, item.file.name, item.id, pageMetas);
  if (!records.length) records.push(makeRecord({ seller: '未识别到金额，请核对', category: '附件', status: 'review', source: item.file.name, included: false }));
  state.records.push(...records);
  pageTexts.forEach((text, pageIndex) => {
    const record = records.find(candidate => candidate.page === pageIndex + 1);
    state.units.push({
      id: crypto.randomUUID(), fileId: item.id, page: pageIndex + 1, source: item.file.name,
      recordId: record?.id || '', orderMeta: pageMetas[pageIndex], text
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
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return ocrCanvas(canvas, pct, fileName);
}

async function ocrCanvas(canvas, pct, fileName) {
  if (!window.Tesseract) return '';
  const result = await window.Tesseract.recognize(canvas, 'chi_sim+eng', {
    workerPath: './vendor/worker.min.js',
    corePath: './vendor/tesseract-core-simd-lstm.wasm.js',
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    logger: message => {
      if (message.status === 'recognizing text') setProgress(true, Math.max(pct, Math.round(message.progress * 100)), '正在识别扫描文字…');
    }
  });
  return result.data.text.replace(/\s+/g, ' ').trim();
}

function parsePages(pageTexts, source, fileId, pageMetas = []) {
  const records = [];
  pageTexts.forEach((text, pageIndex) => {
    const normalized = text.replace(/[，,]/g, '').replace(/￥/g, '¥');
    const compact = normalized.replace(/\s+/g, '');
    const invoiceLike = /电子发票|E-?INVOICE|发票号码/i.test(compact);
    const flightLike = pageMetas[pageIndex]?.type === 'flight-itinerary' || /行程校验单|机票总金额/.test(compact);
    const boardingLike = pageMetas[pageIndex]?.type === 'flight-boarding' || /登机凭证|BOARDING/i.test(compact);
    const tripAttachment = /滴滴出行\s*-?\s*行程单/i.test(normalized) && !invoiceLike;
    if (tripAttachment) return;
    if (!invoiceLike && !flightLike && !boardingLike && normalized.length > 45 && pageTexts.length > 1) return;

    const invoiceStart = normalized.lastIndexOf('电子发票');
    const followsTripSheet = invoiceStart > 0 && /滴滴出行\s*-?\s*行程单|DIDI\s+TRAVEL/i.test(normalized.slice(0, invoiceStart));
    const recordText = followsTripSheet ? normalized.slice(invoiceStart) : normalized;
    const amount = extractAmount(recordText, flightLike);
    const number = extractNumber(recordText, flightLike);
    const date = extractDate(recordText);
    const category = detectCategory(recordText, flightLike, boardingLike);
    const seller = extractSeller(recordText, category, flightLike, boardingLike);
    const attachment = boardingLike || (!amount && category === '附件');
    const review = !attachment && (!amount || !seller || seller.includes('待核对'));
    records.push(makeRecord({
      date, number, category, seller: seller || '销售方待核对', amount,
      included: Boolean(amount) && !attachment,
      status: attachment ? 'attachment' : (review ? 'review' : 'ready'),
      source, fileId, page: pageIndex + 1
    }));
  });
  return dedupeRecords(records);
}

function extractAmount(text, flightLike) {
  const airlineInvoice = /航空|航\s*空|旅客运输电子客票|电\s*子\s*发\s*票/.test(text);
  const patterns = flightLike ? [
    /(?:机\s*票\s*)?总\s*金\s*额\s*[¥]?\s*(\d+(?:\.\d{1,2})?)/i,
    /总\s*价\s*[:：]?\s*[¥]?\s*(\d+(?:\.\d{1,2})?)/i,
    /(?:票\s*价|FARE)[\s:：]*[¥]?\s*(\d+(?:\.\d{1,2})?)/i
  ] : [
    /TOTAL\s+INCLUDING\s+TAX\s*[¥]?\s*(\d+(?:\.\d{2}))/i,
    /[大壹贰叁肆伍陆柒捌玖拾佰仟万零圆角分整]{3,}\s*¥\s*(\d+(?:\.\d{2}))/i,
    /价\s*税\s*合\s*计[\s\S]{0,45}?[（(]?\s*小\s*写\s*[）)]?[\s:：]*[¥]?\s*(\d+(?:\.\d{2}))/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  if (airlineInvoice) {
    const cnyAmounts = [...text.matchAll(/CNY\s*(\d+(?:\.\d{2}))/gi)].map(match => Number(match[1])).filter(n => n > 0);
    if (cnyAmounts.length) return Math.max(...cnyAmounts);
  }
  const afterSymbol = [...text.matchAll(/[¥]\s*(\d+(?:\.\d{2}))/g)].map(match => Number(match[1])).filter(n => n > 0);
  if (afterSymbol.length) return Math.max(...afterSymbol);
  const beforeSymbol = [...text.matchAll(/(\d+(?:\.\d{2}))\s*¥/g)].map(match => Number(match[1])).filter(n => n > 0);
  if (beforeSymbol.length) return Math.max(...beforeSymbol);
  return null;
}

function extractNumber(text, flightLike) {
  if (flightLike) return extractFlightNumberFromText(text) || text.match(/\b\d{10,14}[A-Z]?\b/)?.[0] || '';
  return text.match(/发票号码\s*[:：]?\s*(\d{18,22})/)?.[1]
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
  if (/航\s*空|机\s*票|飞\s*机\s*票|旅\s*客\s*运\s*输\s*电\s*子\s*客\s*票/.test(text)) return '机票';
  if (/铁路电子客票|电子客票号|中国铁路|12306/.test(text)) return '交通';
  if (/住宿|酒店|宾馆|房费/.test(text)) return '住宿';
  if (/旅客运输|交通运输|出租车|客运|出行/.test(text)) return '交通';
  if (/开发板|电子设备|办公设备/.test(text)) return '办公设备';
  if (/技术服务|SERVICE|Service Tax/i.test(text)) return '技术服务';
  return /电子发票|INVOICE/i.test(text) ? '其他' : '附件';
}

function extractSeller(text, category, flightLike, boardingLike) {
  if (flightLike) return '航空行程校验单';
  if (boardingLike) return '登机凭证';
  if (/铁路电子客票|电子客票号|中国铁路|12306/.test(text)) return '中国铁路网络有限公司';
  const known = [
    /名称\s*[:：]\s*(滴滴出行科技有限公司(?:武汉分公司)?)/,
    /(山\s*东\s*航\s*空\s*股\s*份\s*有\s*限\s*公\s*司(?:\s*[（(]\s*网\s*上\s*直\s*营\s*渠\s*道\s*[）)])?)/,
    /(杭州深度求索人工智能基础技术研究有限公司)/,
    /(深圳市乐晓数字技术有限公司)/,
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
  return names.find(name => !/元思/.test(name)) || `${category}票据（销售方待核对）`;
}

function detectFileOrderMeta(pageTexts) {
  const text = pageTexts.join(' ').replace(/\s+/g, ' ');
  const compact = text.replace(/\s+/g, '');
  const flightNumber = extractFlightNumberFromText(text);
  if (/登机凭证|BOARDINGPASS/i.test(compact)) return { type: 'flight-boarding', key: flightNumber };
  if (/行程校验单|机票总金额/.test(compact)) return { type: 'flight-itinerary', key: flightNumber };
  if (/电子发票|发票号码/i.test(compact) && /航空|机票|旅客运输电子客票/.test(compact)) return { type: 'flight-invoice', key: flightNumber };
  const didiInvoice = /电子发票/.test(compact) && /滴滴出行|旅客运输服务/.test(compact);
  if (didiInvoice) return { type: 'taxi-invoice', key: '' };
  if (/滴滴出行-?行程单|DIDITRAVEL-?TRIPTABLE/i.test(compact)) return { type: 'taxi-itinerary', key: '' };
  return { type: 'other', key: '' };
}

function inferPageOrderMetas(pageTexts) {
  const metas = pageTexts.map(text => detectFileOrderMeta([text]));
  for (let index = 0; index < metas.length - 1; index++) {
    const current = metas[index];
    const next = metas[index + 1];
    if (current.type === 'flight-boarding' && current.key && next.type === 'other') {
      metas[index + 1] = { type: 'flight-itinerary', key: current.key, inferred: true };
    }
  }
  return metas;
}

function extractFlightNumberFromText(text) {
  const contextMatch = text.match(/(?:航\s*班(?:\s*号)?|FLIGHT)\s*[:：#]?\s*([A-Z0-9]{2})\s*([0-9OQDILZSBG]{3,5})/i);
  const match = contextMatch || text.match(/\b(CA|MU|CZ|HU|SC|MF|ZH|HO|FM|KN|JD|BK|GS|GJ|NS|EU|PN|TV|KY|QW|GX|AQ|LT|JR|RY|FU|UQ|DR|8L|9C|3U)\s*([0-9OQDILZSBG]{3,5})\b/i);
  if (!match) return '';
  const digitMap = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '8' };
  const digits = match[2].toUpperCase().replace(/[OQDILZSBG]/g, character => digitMap[character]);
  return `${match[1].toUpperCase()}${digits}`;
}

function dedupeRecords(records) {
  const seen = new Set();
  return records.filter(record => {
    const key = record.number || `${record.source}-${record.page}-${record.amount ?? 'x'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeRecord(values) {
  return { id: crypto.randomUUID(), date: '', number: '', category: '其他', seller: '', amount: null, included: true, status: 'review', source: '', page: 1, ...values };
}

function switchView(view) {
  state.activeView = view === 'sort' ? 'sort' : 'review';
  el('reviewView').classList.toggle('active', state.activeView === 'review');
  el('sortView').classList.toggle('active', state.activeView === 'sort');
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === state.activeView));
  if (state.activeView === 'sort') renderSortBoard();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  renderQueue();
  const body = el('invoiceBody');
  if (!state.records.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6"><div class="empty-illustration"><span>票</span></div><strong>明细会出现在这里</strong><p>上传 PDF 后，系统会自动拆分票据并提取金额。</p></td></tr>';
  } else {
    body.innerHTML = state.records.map(record => {
      const status = record.status === 'ready' ? ['已识别', ''] : record.status === 'attachment' ? ['附件', 'attachment'] : ['待核对', 'review'];
      const dateNumber = record.date || '日期待核对';
      const number = record.number || record.source;
      return `<tr>
        <td><span class="status-pill ${status[1]}">${status[0]}</span></td>
        <td><span class="cell-main">${escapeHtml(dateNumber)}</span><span class="cell-sub">${escapeHtml(number)}</span></td>
        <td><span class="category-chip">${escapeHtml(record.category)}</span></td>
        <td><span class="cell-main" title="${escapeHtml(record.seller)}">${escapeHtml(record.seller)}</span><span class="cell-sub">${escapeHtml(record.source)}${record.page ? ` · 第 ${record.page} 页` : ''}</span></td>
        <td class="amount-col">${record.included && record.amount != null ? `¥ ${money.format(record.amount)}` : '—'}</td>
        <td><div class="row-actions"><button class="row-action preview-action" data-edit="${record.id}" aria-label="预览并修改此明细">修改</button></div></td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => openEdit(button.dataset.edit)));
  }
  const included = state.records.filter(record => record.included && Number.isFinite(record.amount));
  const total = included.reduce((sum, record) => sum + record.amount, 0);
  const review = state.records.filter(record => record.status === 'review').length;
  const attachments = state.records.filter(record => !record.included || record.status === 'attachment').length;
  el('totalAmount').textContent = money.format(total);
  el('invoiceCount').textContent = included.length;
  el('reviewCount').textContent = review;
  el('attachmentCount').textContent = attachments;
  el('totalHint').textContent = state.records.length ? (review ? '含待核对项目，请确认' : '已按有效票据汇总') : '等待添加票据';
  el('clearButton').disabled = !state.records.length && !state.files.length;
  el('exportButton').disabled = !state.records.length;
  el('mergeButton').disabled = !state.units.length;
  el('sortMergeButton').disabled = !state.units.length;
  el('autoOrderButton').disabled = state.units.length < 2;
  el('openSortButton').disabled = !state.units.length;
  el('sortCount').textContent = state.units.length;
  el('batchLabel').textContent = state.demo ? '匿名演示批次' : (state.files.length ? `${new Date().toLocaleDateString('zh-CN')} · ${state.files.length} 个文件` : '新建报销批次');
  renderSortBoard();
}

function renderQueue() {
  const queue = el('fileQueue');
  if (!state.files.length) return queue.innerHTML = '<div class="queue-empty">还没有添加文件</div>';
  queue.innerHTML = state.files.map((item, index) => `<div class="file-item"><span class="drag-handle" aria-hidden="true">${item.kind === 'image' ? '▧' : item.kind === 'ofd' ? '◇' : '▤'}</span><span class="pdf-badge">${index + 1}</span><div><strong title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</strong><span>${formatBytes(item.file.size)}${item.pages ? ` · 拆分为 ${item.pages} 页` : ''}</span></div><b class="file-status">${item.status}</b></div>`).join('');
}

function renderSortBoard() {
  const board = el('sortBoard');
  if (!state.units.length) {
    board.innerHTML = '<div class="sort-empty"><strong>还没有可排序的票据</strong><span>返回识别核对页添加文件</span></div>';
    return;
  }
  const typeName = { 'flight-boarding': '登机凭证', 'flight-invoice': '航空发票', 'flight-itinerary': '行程校验单', 'taxi-invoice': '打车发票', 'taxi-itinerary': '打车行程单', other: '票据页面' };
  board.innerHTML = state.units.map((unit, index) => {
    const record = state.records.find(item => item.id === unit.recordId);
    const amount = record?.included && Number.isFinite(record.amount) ? `¥${money.format(record.amount)}` : '附件/待核对';
    return `<article class="sort-card" draggable="true" data-unit-id="${unit.id}">
      <header class="sort-card-head"><span class="sort-position">${index + 1}</span><span>${escapeHtml(typeName[unit.orderMeta?.type] || '票据页面')} · 第 ${unit.page} 页</span></header>
      <div class="sort-thumb"><canvas data-thumb="${unit.id}" aria-label="${escapeHtml(unit.source)}第${unit.page}页缩略图"></canvas><button type="button" data-unit-preview="${unit.id}" aria-label="放大预览第${index + 1}个票据">预览</button></div>
      <div class="sort-card-body"><strong title="${escapeHtml(unit.source)}">${escapeHtml(record?.seller || unit.source)}</strong><p><span>${escapeHtml(record?.category || '附件')} · ${escapeHtml(unit.orderMeta?.key || '独立页面')}</span><b>${amount}</b></p></div>
    </article>`;
  }).join('');

  board.querySelectorAll('[data-unit-preview]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    openPreview(button.dataset.unitPreview);
  }));
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
      const [moved] = state.units.splice(from, 1);
      state.units.splice(to, 0, moved);
      syncRecordsToUnits();
      render();
      toast('已更新页面导出顺序');
    });
  });
  board.querySelectorAll('[data-thumb]').forEach(canvas => {
    const unit = state.units.find(item => item.id === canvas.dataset.thumb);
    renderUnitThumbnail(unit, canvas).catch(error => console.warn('thumbnail', error));
  });
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

function autoArrangeFiles() {
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
    if (target) target.push(invoice);
  });
  groups.forEach(group => group.sort((a, b) => flightRank[a.orderMeta.type] - flightRank[b.orderMeta.type]));
  const taxi = original.filter(unit => ['taxi-invoice', 'taxi-itinerary'].includes(unit.orderMeta?.type));
  if (taxi.length > 1) groups.push(taxi.sort((a, b) => (a.orderMeta.type === 'taxi-invoice' ? 0 : 1) - (b.orderMeta.type === 'taxi-invoice' ? 0 : 1)));
  if (!groups.length) return toast('未从票面识别出可自动配对的凭证，可直接拖动排序');

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
  syncRecordsToUnits();
  render();
  toast('已按票面内容完成凭证配对排序');
}

function syncRecordsToUnits() {
  const rank = new Map(state.units.map((unit, index) => [unit.recordId, index]));
  state.records.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

function flightPrefixFromSeller(seller) {
  const mapping = [
    [/山东航空/, 'SC'], [/南方航空/, 'CZ'], [/中国国航|国际航空/, 'CA'], [/东方航空/, 'MU'],
    [/海南航空/, 'HU'], [/厦门航空/, 'MF'], [/深圳航空/, 'ZH'], [/吉祥航空/, 'HO'], [/四川航空/, '3U']
  ];
  return mapping.find(([pattern]) => pattern.test(seller))?.[1] || '';
}

function openEdit(id) {
  const record = state.records.find(item => item.id === id);
  if (!record) return;
  el('editId').value = id;
  el('editDate').value = record.date;
  el('editCategory').value = ['交通','住宿','机票','技术服务','办公设备','其他','附件'].includes(record.category) ? record.category : '其他';
  el('editSeller').value = record.seller;
  el('editNumber').value = record.number;
  el('editAmount').value = record.amount ?? '';
  el('editIncluded').value = String(record.included);
  el('editPreviewTitle').textContent = `${record.source}${record.page ? ` · 第 ${record.page} 页` : ''}`;
  el('editPreviewLoading').textContent = '正在生成票面…';
  el('editPreviewLoading').hidden = false;
  el('editDialog').showModal();
  resetTransform(editPreviewState, el('editPreviewCanvas'), el('editZoomReset'));
  requestAnimationFrame(() => renderRecordPreview(record));
}

async function openPreview(id) {
  const unit = state.units.find(item => item.id === id);
  const record = state.records.find(item => item.id === unit?.recordId);
  const fileItem = state.files.find(item => item.id === unit?.fileId);
  if (!unit || !fileItem?.pdfDoc) return toast('当前票据暂时无法预览');

  el('previewTitle').textContent = unit.source;
  el('previewMeta').textContent = `第 ${unit.page} 页 · ${record?.category || '附件'} · ${record?.amount == null ? '金额待核对' : `¥${money.format(record.amount)}`}`;
  el('previewLoading').hidden = false;
  el('previewLoading').textContent = '正在生成预览…';
  el('previewDialog').showModal();
  resetPreviewTransform();

  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    await renderPdfPageToCanvas(fileItem, unit.page, el('previewCanvas'), previewStage, el('previewLoading'));
  } catch (error) {
    console.error(error);
    el('previewLoading').textContent = '预览生成失败，请关闭后重试';
  }
}

async function renderRecordPreview(record) {
  const fileItem = state.files.find(item => item.id === record.fileId);
  const loading = el('editPreviewLoading');
  const canvas = el('editPreviewCanvas');
  if (!fileItem?.pdfDoc) {
    canvas.width = 1;
    canvas.height = 1;
    loading.textContent = state.demo ? '演示数据没有原始票面' : '当前明细没有可预览页面';
    loading.hidden = false;
    return;
  }
  try {
    await renderPdfPageToCanvas(fileItem, record.page || 1, canvas, el('editPreviewStage'), loading);
  } catch (error) {
    console.error(error);
    loading.textContent = '票面生成失败，请关闭后重试';
  }
}

async function renderPdfPageToCanvas(fileItem, pageNo, canvas, stage, loading) {
  const page = await fileItem.pdfDoc.getPage(pageNo);
  const unitViewport = page.getViewport({ scale: 1 });
  const availableWidth = Math.max(240, stage.clientWidth - 44);
  const availableHeight = Math.max(240, stage.clientHeight - 44);
  const fitScale = Math.min(availableWidth / unitViewport.width, availableHeight / unitViewport.height);
  const renderScale = Math.max(1.5, fitScale * Math.min(2.2, window.devicePixelRatio || 1));
  const renderViewport = page.getViewport({ scale: renderScale });
  canvas.width = Math.ceil(renderViewport.width);
  canvas.height = Math.ceil(renderViewport.height);
  canvas.style.width = `${Math.round(unitViewport.width * fitScale)}px`;
  canvas.style.height = `${Math.round(unitViewport.height * fitScale)}px`;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderViewport }).promise;
  loading.hidden = true;
}

function setPreviewZoom(value) {
  setTransformZoom(previewState, value, el('previewCanvas'), el('zoomResetButton'));
}

function resetPreviewTransform() {
  resetTransform(previewState, el('previewCanvas'), el('zoomResetButton'));
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
  Object.assign(record, {
    date: el('editDate').value,
    category: el('editCategory').value,
    seller: el('editSeller').value.trim() || '销售方待核对',
    number: el('editNumber').value.trim(),
    amount: value === '' ? null : Number(value),
    included: el('editIncluded').value === 'true',
    status: el('editIncluded').value === 'false' ? 'attachment' : 'ready'
  });
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
  const buttons = [el('mergeButton'), el('sortMergeButton')];
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
  state.files.forEach(item => item.pdfDoc?.destroy?.());
  state.files = [];
  state.records = [];
  state.units = [];
  state.demo = false;
  fileInput.value = '';
  switchView('review');
  render();
  toast('已清空当前批次');
}

function setProgress(show, value, label) {
  el('progressWrap').hidden = !show;
  el('progressBar').style.width = `${Math.min(100, value)}%`;
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
