import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const state = { files: [], records: [], demo: false };
const previewState = { zoom: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 };
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
el('autoOrderButton').addEventListener('click', autoArrangeFiles);
el('saveEdit').addEventListener('click', saveEdit);
el('closePreviewButton').addEventListener('click', () => el('previewDialog').close());
el('zoomInButton').addEventListener('click', () => setPreviewZoom(previewState.zoom + .2));
el('zoomOutButton').addEventListener('click', () => setPreviewZoom(previewState.zoom - .2));
el('zoomResetButton').addEventListener('click', resetPreviewTransform);

const previewStage = el('previewStage');
previewStage.addEventListener('wheel', event => {
  event.preventDefault();
  setPreviewZoom(previewState.zoom + (event.deltaY < 0 ? .14 : -.14));
}, { passive: false });
previewStage.addEventListener('dblclick', resetPreviewTransform);
previewStage.addEventListener('pointerdown', event => {
  previewState.dragging = true;
  previewState.startX = event.clientX;
  previewState.startY = event.clientY;
  previewState.originX = previewState.x;
  previewState.originY = previewState.y;
  previewStage.classList.add('dragging');
  previewStage.setPointerCapture(event.pointerId);
});
previewStage.addEventListener('pointermove', event => {
  if (!previewState.dragging) return;
  previewState.x = previewState.originX + event.clientX - previewState.startX;
  previewState.y = previewState.originY + event.clientY - previewState.startY;
  applyPreviewTransform();
});
['pointerup', 'pointercancel'].forEach(name => previewStage.addEventListener(name, event => {
  previewState.dragging = false;
  previewStage.classList.remove('dragging');
  if (previewStage.hasPointerCapture(event.pointerId)) previewStage.releasePointerCapture(event.pointerId);
}));

async function addFiles(fileList) {
  const incoming = [...fileList].filter(file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
  if (!incoming.length) return toast('请选择 PDF 文件');
  state.demo = false;
  state.files = incoming.map((file, i) => ({ file, id: `${Date.now()}-${i}`, status: '等待识别', pages: 0 }));
  state.records = [];
  render();
  setProgress(true, 2, '正在读取 PDF…');

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
  toast(review ? `识别完成，有 ${review} 条需要核对` : '识别完成，可以导出明细');
}

async function processFile(item, fileIndex, fileCount) {
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({
    data: bytes,
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
    const content = await page.getTextContent();
    let text = content.items.map(token => token.str).join(' ').replace(/\s+/g, ' ').trim();
    const pct = Math.round(((fileIndex + (pageNo / pdf.numPages)) / fileCount) * 88);
    setProgress(true, pct, `识别 ${item.file.name} · 第 ${pageNo}/${pdf.numPages} 页`);
    if (text.length < 45) {
      const ocrText = await ocrPage(page, pct, item.file.name).catch(() => '');
      text = `${text} ${ocrText}`.replace(/\s+/g, ' ').trim();
    }
    pageTexts.push(text);
  }
  item.orderMeta = detectFileOrderMeta(pageTexts);
  const records = parsePages(pageTexts, item.file.name, item.id);
  if (!records.length) records.push(makeRecord({ seller: '未识别到金额，请核对', category: '附件', status: 'review', source: item.file.name, included: false }));
  state.records.push(...records);
}

async function ocrPage(page, pct, fileName) {
  if (!window.Tesseract) return '';
  setProgress(true, pct, `正在 OCR 扫描件 · ${fileName}`);
  const viewport = page.getViewport({ scale: 2.4 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
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

function parsePages(pageTexts, source, fileId) {
  const records = [];
  pageTexts.forEach((text, pageIndex) => {
    const normalized = text.replace(/[，,]/g, '').replace(/￥/g, '¥');
    const compact = normalized.replace(/\s+/g, '');
    const invoiceLike = /电子发票|E-?INVOICE|发票号码/i.test(compact);
    const flightLike = /行程校验单|机票总金额/.test(compact);
    const boardingLike = /登机凭证|BOARDING/i.test(compact);
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
  const patterns = flightLike ? [
    /(?:机票\s*)?总金额\s*[¥]?\s*(\d+(?:\.\d{1,2})?)/i,
    /总价\s*[:：]?\s*[¥]?\s*(\d+(?:\.\d{1,2})?)/i
  ] : [
    /TOTAL\s+INCLUDING\s+TAX\s*[¥]?\s*(\d+(?:\.\d{2}))/i,
    /[大壹贰叁肆伍陆柒捌玖拾佰仟万零圆角分整]{3,}\s*¥\s*(\d+(?:\.\d{2}))/i,
    /价\s*税\s*合\s*计[\s\S]{0,45}?[（(]?\s*小\s*写\s*[）)]?[\s:：]*[¥]?\s*(\d+(?:\.\d{2}))/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  const afterSymbol = [...text.matchAll(/[¥]\s*(\d+(?:\.\d{2}))/g)].map(match => Number(match[1])).filter(n => n > 0);
  if (afterSymbol.length) return Math.max(...afterSymbol);
  const beforeSymbol = [...text.matchAll(/(\d+(?:\.\d{2}))\s*¥/g)].map(match => Number(match[1])).filter(n => n > 0);
  return beforeSymbol.length ? Math.max(...beforeSymbol) : null;
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
    /(杭州深度求索人工智能基础技术研究有限公司)/,
    /(深圳市乐晓数字技术有限公司)/,
    /(武汉市洪山区宁宁宾馆)/,
    /(武汉市江汉区[^\s]{2,24}(?:商行|公司|店))/, 
    /(SEA\s+GAMER\s+MALL\s+SDN\s+BHD)/i
  ];
  for (const pattern of known) {
    const match = text.match(pattern);
    if (match) return match[1].replace(/\s+/g, ' ').trim();
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
  const didiInvoice = /电子发票/.test(compact) && /滴滴出行|旅客运输服务/.test(compact);
  if (didiInvoice) return { type: 'taxi-invoice', key: '' };
  if (/滴滴出行-?行程单|DIDITRAVEL-?TRIPTABLE/i.test(compact)) return { type: 'taxi-itinerary', key: '' };
  return { type: 'other', key: '' };
}

function extractFlightNumberFromText(text) {
  const match = text.match(/\b([A-Z]{2})\s*([0-9OQDILZSBG]{3,5})\b/i);
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
        <td><div class="row-actions">${record.fileId ? `<button class="row-action preview-action" data-preview="${record.id}" aria-label="预览此票据">预览</button>` : ''}<button class="row-action" data-edit="${record.id}" aria-label="编辑此明细">···</button></div></td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => openEdit(button.dataset.edit)));
    body.querySelectorAll('[data-preview]').forEach(button => button.addEventListener('click', () => openPreview(button.dataset.preview)));
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
  el('mergeButton').disabled = !state.files.length;
  el('autoOrderButton').disabled = state.files.length < 2;
  el('batchLabel').textContent = state.demo ? '匿名演示批次' : (state.files.length ? `${new Date().toLocaleDateString('zh-CN')} · ${state.files.length} 个文件` : '新建报销批次');
}

function renderQueue() {
  const queue = el('fileQueue');
  if (!state.files.length) return queue.innerHTML = '<div class="queue-empty">还没有添加文件</div>';
  queue.innerHTML = state.files.map((item, index) => `<div class="file-item" draggable="true" data-file-id="${item.id}" data-order-type="${item.orderMeta?.type || ''}" data-order-key="${item.orderMeta?.key || ''}"><span class="drag-handle" aria-hidden="true">⠿</span><span class="pdf-badge">${index + 1}</span><div><strong title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</strong><span>${formatBytes(item.file.size)}${item.pages ? ` · ${item.pages} 页` : ''}</span></div><b class="file-status">${item.status}</b></div>`).join('');
  let draggedId = null;
  queue.querySelectorAll('[data-file-id]').forEach(row => {
    row.addEventListener('dragstart', event => {
      draggedId = row.dataset.fileId;
      event.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      draggedId = null;
      queue.querySelectorAll('.file-item').forEach(item => item.classList.remove('dragging', 'drag-over'));
    });
    row.addEventListener('dragover', event => { event.preventDefault(); if (row.dataset.fileId !== draggedId) row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', event => {
      event.preventDefault();
      row.classList.remove('drag-over');
      if (!draggedId || draggedId === row.dataset.fileId) return;
      const from = state.files.findIndex(item => item.id === draggedId);
      const to = state.files.findIndex(item => item.id === row.dataset.fileId);
      const [moved] = state.files.splice(from, 1);
      state.files.splice(to, 0, moved);
      renderQueue();
      toast('已更新 PDF 导出顺序');
    });
  });
}

function autoArrangeFiles() {
  const original = [...state.files];
  const flightGroups = new Map();
  const other = [];
  original.forEach((item, index) => {
    const type = item.orderMeta?.type;
    const key = item.orderMeta?.key;
    if ((type === 'flight-boarding' || type === 'flight-itinerary') && key) {
      if (!flightGroups.has(key)) flightGroups.set(key, { first: index, items: [] });
      flightGroups.get(key).items.push({ item, rank: type === 'flight-boarding' ? 0 : 1 });
    } else {
      other.push({ item, index });
    }
  });
  for (const [key, group] of flightGroups) {
    const ranks = new Set(group.items.map(entry => entry.rank));
    if (ranks.size < 2) {
      group.items.forEach(entry => other.push({ item: entry.item, index: original.indexOf(entry.item) }));
      flightGroups.delete(key);
    }
  }
  other.sort((a, b) => a.index - b.index);
  const groups = [...flightGroups.values()].sort((a, b) => a.first - b.first);
  const taxiItems = other.filter(entry => ['taxi-invoice', 'taxi-itinerary'].includes(entry.item.orderMeta?.type));
  if (!groups.length && taxiItems.length < 2) return toast('未从票面识别出可自动配对的凭证，可直接拖动排序');
  if (!groups.length) {
    state.files = [...other].sort((a, b) => {
      const rank = entry => entry.item.orderMeta?.type === 'taxi-invoice' ? 0 : entry.item.orderMeta?.type === 'taxi-itinerary' ? 1 : 2;
      return rank(a) - rank(b) || a.index - b.index;
    }).map(entry => entry.item);
    renderQueue();
    return toast('已按票面内容完成“打车发票 → 行程单”排序');
  }
  const firstFlightIndex = Math.min(...groups.map(group => group.first));
  const before = other.filter(entry => entry.index < firstFlightIndex).map(entry => entry.item);
  const after = other.filter(entry => entry.index >= firstFlightIndex).map(entry => entry.item);
  const paired = groups.flatMap(group => group.items.sort((a, b) => a.rank - b.rank).map(entry => entry.item));
  state.files = [...before, ...paired, ...after];
  renderQueue();
  toast('已按票面航班号完成“登机凭证 → 行程校验单”配对排序');
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
  el('editDialog').showModal();
}

async function openPreview(id) {
  const record = state.records.find(item => item.id === id);
  const fileItem = state.files.find(item => item.id === record?.fileId);
  if (!record || !fileItem?.pdfDoc) return toast('当前票据暂时无法预览');

  el('previewTitle').textContent = record.source;
  el('previewMeta').textContent = `第 ${record.page || 1} 页 · ${record.category} · ${record.amount == null ? '金额待核对' : `¥${money.format(record.amount)}`}`;
  el('previewLoading').hidden = false;
  el('previewDialog').showModal();
  resetPreviewTransform();

  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    const page = await fileItem.pdfDoc.getPage(record.page || 1);
    const unitViewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(260, previewStage.clientWidth - 54);
    const availableHeight = Math.max(260, previewStage.clientHeight - 54);
    const fitScale = Math.min(availableWidth / unitViewport.width, availableHeight / unitViewport.height);
    const renderScale = Math.max(1.6, fitScale * Math.min(2.2, window.devicePixelRatio || 1));
    const renderViewport = page.getViewport({ scale: renderScale });
    const canvas = el('previewCanvas');
    canvas.width = Math.ceil(renderViewport.width);
    canvas.height = Math.ceil(renderViewport.height);
    canvas.style.width = `${Math.round(unitViewport.width * fitScale)}px`;
    canvas.style.height = `${Math.round(unitViewport.height * fitScale)}px`;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderViewport }).promise;
    el('previewLoading').hidden = true;
  } catch (error) {
    console.error(error);
    el('previewLoading').textContent = '预览生成失败，请关闭后重试';
  }
}

function setPreviewZoom(value) {
  previewState.zoom = Math.min(4, Math.max(.5, value));
  applyPreviewTransform();
}

function resetPreviewTransform() {
  previewState.zoom = 1;
  previewState.x = 0;
  previewState.y = 0;
  applyPreviewTransform();
}

function applyPreviewTransform() {
  el('previewCanvas').style.transform = `translate(${previewState.x}px, ${previewState.y}px) scale(${previewState.zoom})`;
  el('zoomResetButton').textContent = `${Math.round(previewState.zoom * 100)}%`;
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
  if (!window.PDFLib || !state.files.length) return;
  const button = el('mergeButton');
  button.disabled = true;
  button.textContent = '正在合并…';
  try {
    const merged = await window.PDFLib.PDFDocument.create();
    for (const item of state.files) {
      const source = await window.PDFLib.PDFDocument.load(await item.file.arrayBuffer());
      const pages = await merged.copyPages(source, source.getPageIndices());
      pages.forEach(page => merged.addPage(page));
    }
    const bytes = await merged.save();
    const included = state.records.filter(record => record.included && Number.isFinite(record.amount));
    const total = included.reduce((sum, record) => sum + record.amount, 0);
    const filename = `${dateTimeStamp()}-${included.length}张-${total.toFixed(2)}元-合并发票.pdf`;
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
    toast(`已合并 ${state.files.length} 个文件`);
  } catch (error) {
    console.error(error);
    toast('合并失败，请检查 PDF 是否加密');
  } finally {
    button.textContent = '合并 PDF';
    button.disabled = false;
  }
}

function clearAll() {
  state.files.forEach(item => item.pdfDoc?.destroy?.());
  state.files = [];
  state.records = [];
  state.demo = false;
  fileInput.value = '';
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
