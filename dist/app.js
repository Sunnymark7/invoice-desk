import * as pdfjsLib from './vendor/pdf.min.mjs';
import { getDocument as getOfdDocument } from './vendor/ofdjs.js';
import { loadDraft, saveDraft, deleteDraft } from './draft-store.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const state = { files: [], records: [], units: [], skippedPages: 0, duplicatePages: 0, invoiceKeys: new Set(), busy: false, exporting: false, exportKind: '', restoring: false, demo: false, activeView: 'review' };
const canvasTasks = new WeakMap();
const thumbnailCache = new Map();
let thumbnailObserver;
let thumbnailQueue = Promise.resolve();
const deletedPages = [];
let reviewFilter = 'all';
let orderMode = 'import';
let secondarySort = 'none';
let layoutMode = 'grid';
const viewScaleStorageKey = 'invoice-desk.view-scale';
let preferredViewScale = readStoredViewScale();
let viewScale = preferredViewScale ?? 80;
const invoiceFieldStorageKey = 'invoice-desk.hidden-invoice-fields';
const invoiceFieldLabels = { title: 'PDF 标题', company: '公司名称', date: '开票时间' };
const hiddenInvoiceFields = readStoredHiddenInvoiceFields();
const selectedRecords = new Set();
let selectionAnchor = '';
let previewDirty = false;
let previewRecordScope = null;
let replacementTargetId = '';
let previewRenderRevision = 0;
let draftDirty = false;
let draftTimer;
let draftRevision = 0;
let draftWrites = Promise.resolve();
let resizeTimer;
const previewState = { zoom: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, originX: 0, originY: 0, unitId: '', rotation: 0 };
const editPreviewState = { zoom: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, originX: 0, originY: 0, rotation: 0 };
const el = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isLocked = () => state.busy || state.exporting || state.restoring;
const dropZone = el('dropZone');
const fileInput = el('fileInput');
dropZone.addEventListener('click', event => { if (!isLocked() && event.target !== fileInput) fileInput.click(); });
el('reviewSearch').addEventListener('input', () => { renderInvoiceTable(); el('searchToggleButton').classList.toggle('has-query', Boolean(el('reviewSearch').value.trim())); });
let searchExpanded = false;
let searchCloseTimer;
function updateSearchGeometry() {
  const control = el('searchControl');
  const button = el('searchToggleButton').getBoundingClientRect();
  control.style.setProperty('--search-open-width', `${Math.max(button.width, Math.min(320, button.right - 16))}px`);
}
function setSearchExpanded(open) {
  clearTimeout(searchCloseTimer);
  searchExpanded = open;
  const control = el('searchControl'), popover = el('searchPopover');
  el('searchToggleButton').setAttribute('aria-expanded', String(open));
  if (open) {
    updateSearchGeometry();
    popover.hidden = false;
    popover.inert = false;
    void popover.offsetWidth;
    control.classList.add('is-expanded');
    el('reviewSearch').focus({ preventScroll: true });
  } else {
    control.classList.remove('is-expanded');
    popover.inert = true;
    searchCloseTimer = setTimeout(() => { if (!searchExpanded) popover.hidden = true; }, 380);
  }
}
el('searchToggleButton').addEventListener('click', () => setSearchExpanded(!searchExpanded));
el('clearSearchButton').addEventListener('click', () => { el('reviewSearch').value = ''; renderInvoiceTable(); el('searchToggleButton').classList.remove('has-query'); el('reviewSearch').focus(); });
document.addEventListener('pointerdown', event => { if (searchExpanded && !event.target.closest?.('#searchControl')) setSearchExpanded(false); });
el('searchControl').addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !searchExpanded) return;
  event.preventDefault();
  event.stopPropagation();
  setSearchExpanded(false);
  el('searchToggleButton').focus({ preventScroll: true });
});
el('searchControl').addEventListener('focusout', event => {
  if (searchExpanded && !event.relatedTarget?.closest?.('#searchControl')) setSearchExpanded(false);
});
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  reviewFilter = button.dataset.filter;
  renderInvoiceTable();
}));
fileInput.addEventListener('change', () => addFiles(fileInput.files));
['replacementInput', 'previewReplacementInput'].forEach(id => el(id).addEventListener('change', event => {
  const file = event.target.files?.[0];
  const targetId = replacementTargetId;
  event.target.value = '';
  replacementTargetId = '';
  if (file && targetId) replaceInvoice(targetId, file);
}));
el('previewReplaceButton').addEventListener('click', () => {
  const unit = state.units.find(unit => unit.id === previewState.unitId);
  if (unit) requestInvoiceReplacement(unit.recordId);
});
el('previewUndoReplaceButton').addEventListener('click', undoPageDelete);
let fileDragDepth = 0;
function setWindowFileHover(active) { el('windowDropHint').hidden = !active; }
function isFileDrag(event) { return [...(event.dataTransfer?.types || [])].includes('Files'); }
document.addEventListener('dragenter', event => {
  if (!isFileDrag(event) || window.invoiceDesktop?.nativeDrops) return;
  event.preventDefault(); fileDragDepth += 1; setWindowFileHover(true);
});
document.addEventListener('dragover', event => {
  if (!isFileDrag(event) || window.invoiceDesktop?.nativeDrops) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', event => {
  if (!isFileDrag(event) || window.invoiceDesktop?.nativeDrops) return;
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (!fileDragDepth) setWindowFileHover(false);
});
document.addEventListener('drop', event => {
  if (!isFileDrag(event) || window.invoiceDesktop?.nativeDrops) return;
  event.preventDefault(); fileDragDepth = 0; setWindowFileHover(false);
  addFiles(event.dataTransfer.files);
});
window.addEventListener('blur', () => { fileDragDepth = 0; setWindowFileHover(false); });
if (window.invoiceDesktop?.onFilesDropped) {
  window.invoiceDesktop.onFilesDropped(files => addFiles(files), setWindowFileHover,
    error => toast(`拖入文件失败：${error.message || error}`)).catch(error => {
      console.warn('native file drop', error);
      toast('窗口拖入暂不可用，可点击导入区域选择文件');
    });
}

let scaleCloseTimer;
let scaleDragging = false;
let scaleExpanded = false;
function setScaleExpanded(open) {
  const control = el('cardScaleControl'), panel = el('viewScalePopover');
  clearTimeout(scaleCloseTimer);
  scaleExpanded = open;
  el('viewScaleButton').setAttribute('aria-expanded', String(open));
  if (open) {
    panel.hidden = false;
    panel.inert = false;
    void panel.offsetHeight;
    control.classList.add('is-expanded');
  } else {
    panel.inert = true;
    control.classList.remove('is-expanded');
    control.classList.remove('thumb-hover');
    scaleCloseTimer = setTimeout(() => { if (!scaleExpanded) panel.hidden = true; }, 380);
  }
}
function isWithinScaleControl(event) {
  const boxes = [el('cardScaleControl').getBoundingClientRect(), el('viewScalePopover').getBoundingClientRect(), el('resetViewScaleButton').getBoundingClientRect()];
  return boxes.some(box => event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom);
}
el('viewScaleButton').addEventListener('pointerenter', () => setScaleExpanded(true));
el('viewScaleButton').addEventListener('click', event => {
  // Hover already opens it for a mouse; keyboard activation can toggle it.
  setScaleExpanded(event.detail === 0 ? !scaleExpanded : true);
});
el('cardScaleControl').addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !scaleExpanded) return;
  event.preventDefault();
  event.stopPropagation();
  setScaleExpanded(false);
  el('viewScaleButton').focus({ preventScroll: true });
});
el('viewScaleRange').addEventListener('input', event => applyViewScale(event.target.value));
function updateScaleThumbHover(event) {
  const panel = el('viewScalePopover').getBoundingClientRect();
  const thumbY = panel.top + (160 - viewScale) * 1.42 + 30;
  el('cardScaleControl').classList.toggle('thumb-hover', scaleExpanded && Math.hypot(event.clientX - panel.left - 35, event.clientY - thumbY) <= 14);
}
el('viewScaleRange').addEventListener('pointerenter', updateScaleThumbHover);
el('viewScaleRange').addEventListener('pointermove', updateScaleThumbHover);
el('viewScaleRange').addEventListener('pointerleave', () => el('cardScaleControl').classList.remove('thumb-hover'));
el('viewScaleRange').addEventListener('pointerdown', () => { scaleDragging = true; el('cardScaleControl').classList.add('is-scale-dragging'); });
el('resetViewScaleButton').addEventListener('click', () => applyViewScale(100));
el('scaleMaxButton').addEventListener('click', () => applyViewScale(160));
el('scaleMinButton').addEventListener('click', () => applyViewScale(60));
document.querySelectorAll('[data-invoice-field-toggle]').forEach(button => button.addEventListener('click', () => {
  const field = button.dataset.invoiceFieldToggle;
  if (hiddenInvoiceFields.has(field)) hiddenInvoiceFields.delete(field);
  else hiddenInvoiceFields.add(field);
  applyInvoiceFieldVisibility(true);
}));
document.addEventListener('pointermove', event => { if (scaleExpanded && !scaleDragging && !isWithinScaleControl(event)) setScaleExpanded(false); });
document.addEventListener('pointerup', event => { if (scaleDragging) { scaleDragging = false; el('cardScaleControl').classList.remove('is-scale-dragging'); updateScaleThumbHover(event); if (!isWithinScaleControl(event)) setScaleExpanded(false); } });
document.addEventListener('pointercancel', () => { scaleDragging = false; el('cardScaleControl').classList.remove('is-scale-dragging'); setScaleExpanded(false); });
document.addEventListener('pointerdown', event => { if (!event.target.closest?.('#cardScaleControl') && scaleExpanded) setScaleExpanded(false); });

el('selectAllButton').addEventListener('click', toggleAllVisibleInvoices);
el('clearSelectionButton').addEventListener('click', clearSelection);
el('revealSelectionButton').addEventListener('click', revealSelection);
el('mergeSelectedButton').addEventListener('click', () => mergePdfs(true));
el('deleteSelectedButton').addEventListener('click', deleteSelectedInvoices);
el('undoEmptyDeleteButton').addEventListener('click', undoPageDelete);
el('dismissDeleteNoticeButton').addEventListener('click', () => { renderDeleteNotice.dismissedEntry = deletedPages.at(-1); el('pageDeleteNotice').hidden = true; });
el('dismissUndoEmptyToastButton').addEventListener('click', () => { el('undoEmptyDeleteToast').hidden = true; clearTimeout(renderDeleteNotice.undoTimer); });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.target?.closest?.('input,select,textarea,dialog') && deletedPages.length) { event.preventDefault(); undoPageDelete(); } });
el('addMoreButton').addEventListener('click', () => { if (!isLocked()) fileInput.click(); });
el('continueImportButton').addEventListener('click', () => { if (!isLocked()) fileInput.click(); });
el('reviewPendingButton').addEventListener('click', focusPendingReviews);
document.addEventListener('pointerdown', event => { if (!event.target.closest?.('#batchTools')) closeSortPanel(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSortPanel(); });
function closeSortPanel() {}
el('copyTotalButton').addEventListener('click', copyTotalAmount);
el('copyTotalButton').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); copyTotalAmount(); } });
el('exportButton').addEventListener('click', exportCsv);
el('clearBatchButton').addEventListener('click', clearAll);
el('mergeButton').addEventListener('click', () => mergePdfs());
el('saveEdit').addEventListener('click', saveEdit);
document.querySelectorAll('[data-layout]').forEach(button => button.addEventListener('click', () => { layoutMode = button.dataset.layout === 'grid' ? 'grid' : 'list'; renderInvoiceTable(); if (!isLocked() && state.files.length) scheduleDraftSave(); }));
el('secondarySortSelect').addEventListener('change', event => {
  secondarySort = event.target.value;
  const primary = getSortDefinition(orderMode);
  if (primary) sortInvoiceGroups(primary.field, primary.descending);
});
el('sortModeSelect').addEventListener('change', event => {
  if (event.target.value === 'date') sortByInvoiceDate();
  else if (event.target.value === 'date-desc') sortByInvoiceDate(false, true);
  else if (event.target.value === 'company') sortByCompanyName();
  else if (event.target.value === 'company-desc') sortByCompanyName(false, true);
  else if (event.target.value === 'amount') sortByPrice();
  else if (event.target.value === 'amount-desc') sortByPrice(false, true);
  else if (event.target.value === 'paired') { autoArrangeFiles(); setOrderMode(orderMode); }
  else restoreImportOrder();
  closeSortPanel();
});
dropZone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!isLocked()) fileInput.click(); } });
el('closePreviewButton').addEventListener('click', closePreview);
el('previewDialog').addEventListener('cancel', event => { if (previewDirty) { event.preventDefault(); toast('有未保存的核对内容，请先保存或重置修改'); } });
el('previewPrevButton').addEventListener('click', () => stepPreview(-1));
el('previewNextButton').addEventListener('click', () => stepPreview(1));
el('previewPageForm').addEventListener('submit', event => { event.preventDefault(); jumpPreviewPage(); });
el('previewPageInput').addEventListener('change', jumpPreviewPage);
el('previewPageInput').addEventListener('focus', event => event.target.select());
el('previewPageInput').addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  updatePreviewNavigation();
  event.target.blur();
});
el('previewDialog').addEventListener('close', () => {
  previewRecordScope = null;
  previewRenderRevision += 1;
  const canvas = el('previewCanvas');
  canvasTasks.get(canvas)?.task?.cancel();
  canvasTasks.delete(canvas);
  previewStage.classList.remove('is-loading');
  previewStage.setAttribute('aria-busy', 'false');
  const focusTarget = state.records.length
    ? document.querySelector(`[data-unit-preview="${previewState.unitId}"]`) || document.querySelector(`[data-filter="${reviewFilter}"]`) || el('continueImportButton')
    : dropZone;
  focusTarget.focus({ preventScroll: true });
});
el('zoomInButton').addEventListener('click', () => setPreviewZoom(previewState.zoom + .2));
el('zoomOutButton').addEventListener('click', () => setPreviewZoom(previewState.zoom - .2));
el('zoomResetButton').addEventListener('click', resetPreviewTransform);
el('rotatePreviewButton').addEventListener('click', rotateCurrentPreview);
el('undoPageDeleteButton').addEventListener('click', undoPageDelete);
el('previewForm').addEventListener('submit', event => { event.preventDefault(); savePreview(false); });
el('previewSaveNext').addEventListener('click', () => savePreview(true));
el('previewResetButton').addEventListener('click', resetPreviewForm);
function markPreviewDirty(event) {
  if (!event.target.closest('.preview-form-fields')) return;
  previewDirty = true;
  el('previewSaveHint').textContent = '有修改未保存';
}
el('previewForm').addEventListener('input', markPreviewDirty);
el('previewForm').addEventListener('change', markPreviewDirty);
window.addEventListener('beforeunload', event => {
  if (previewDirty || ((draftDirty || isLocked()) && state.files.length)) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('resize', () => {
  if (searchExpanded) updateSearchGeometry();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(refitOpenPreview, 160);
});

const previewStage = el('previewStage');
setupPanZoom(previewStage, el('previewCanvas'), previewState, el('zoomResetButton'), { wheelZoom: false });
setupPreviewWheelNavigation(previewStage.closest('.preview-viewer'));
setupPanZoom(el('editPreviewStage'), el('editPreviewCanvas'), editPreviewState, el('editZoomReset'));
document.addEventListener('keydown', event => {
  if (!el('previewDialog').open) return;
  if (event.target?.closest?.('input, select, textarea')) return;
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
  if (isLocked()) return toast('正在处理当前批次，请稍候再添加');
  if (previewDirty) return toast('请先保存或重置核对修改，再添加票据');
  const incoming = [...fileList].filter(isSupportedFile);
  if (!incoming.length) return toast('请选择 PDF、OFD 或图片文件');
  if (state.demo) resetBatch();
  state.demo = false;
  state.busy = true;
  const startIndex = state.files.length;
  const previousOrderMode = startIndex ? orderMode : 'date';
  state.files.push(...incoming.map((file, i) => ({ file, id: `${Date.now()}-${startIndex + i}`, status: '等待识别', pages: 0, kind: '' })));
  render();
  setProgress(true, 2, '正在检查文件真实格式…');

  for (let i = startIndex; i < state.files.length; i++) {
    const item = state.files[i];
    item.status = '识别中';
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
  const sort = getSortDefinition(previousOrderMode);
  if (sort) sortInvoiceGroups(sort.field, sort.descending, true);
  else if (previousOrderMode === 'paired') autoArrangeFiles(true);
  else if (previousOrderMode === 'import') state.units.sort((a, b) => a.importOrder - b.importOrder);
  syncRecordsToUnits();
  render();
  fileInput.value = '';
  setProgress(false, 100, `识别完成 · 已保留 ${state.files.length} 个文件`);
  const review = state.records.filter(record => record.status === 'review').length;
  const duplicates = state.duplicatePages;
  const note = `${duplicates ? `，排除 ${duplicates} 张重复发票` : ''}`;
  toast(`本批次共 ${state.files.length} 个文件${review ? `，${review} 条待核对` : ''}${note}；已沿用当前排序`);
}

function requestInvoiceReplacement(recordId) {
  if (isLocked()) return toast('正在处理批次，请稍后替换');
  if (previewDirty) return toast('请先保存或重置核对修改，再替换发票');
  if (!state.records.some(record => record.id === recordId)) return;
  replacementTargetId = recordId;
  const input = el(el('previewDialog').open ? 'previewReplacementInput' : 'replacementInput');
  input.value = '';
  input.click();
}

async function replaceInvoice(recordId, file) {
  if (isLocked()) return toast('正在处理批次，请稍后替换');
  if (previewDirty) return toast('请先保存或重置核对修改，再替换发票');
  if (!isSupportedFile(file)) return toast('替换文件须为 PDF、OFD、JPG、PNG 或 WebP');
  const original = state.records.find(record => record.id === recordId);
  if (!original) return;
  // Parse into an isolated batch. The current invoice survives every failed attempt.
  const item = { file, id: crypto.randomUUID(), status: '正在替换', pages: 0, kind: '' };
  const batch = { files: [...state.files, item], records: state.records.filter(record => record.id !== recordId),
    units: state.units.filter(unit => unit.recordId !== recordId), invoiceKeys: new Set(), skippedPages: 0, duplicatePages: 0 };
  const existingIds = new Set(batch.records.map(record => record.id));
  let committed = false;
  let failureMessage = '';
  state.busy = true;
  render();
  setProgress(true, 2, `正在识别替换文件 · ${file.name}`);
  try {
    await processFile(item, 0, 1, batch);
    const records = batch.records.filter(record => !existingIds.has(record.id));
    const units = batch.units.filter(unit => unit.fileId === item.id);
    if (item.duplicatePages) throw new Error('替换文件与本批其他发票重复，请选择不同文件');
    if (records.length !== 1 || !units.length || units.length !== item.pages) throw new Error('请选择一张发票的完整文件；合并了多张发票的文件请先拆分再替换');
    const replacement = records[0];
    const entries = state.units.map((unit, index) => ({ unit: { ...unit }, index,
      previousId: state.units[index - 1]?.id, nextId: state.units[index + 1]?.id })).filter(entry => entry.unit.recordId === recordId);
    const recordIndex = state.records.indexOf(original);
    const at = entries[0]?.index ?? state.units.length;
    const baseOrder = entries.length ? Math.min(...entries.map(entry => entry.unit.importOrder)) : state.files.indexOf(state.files.find(file => file.id === original.fileId)) * 1000000;
    const nextOrder = Math.min(...batch.units.filter(unit => unit.importOrder > baseOrder).map(unit => unit.importOrder), baseOrder + 1000000);
    const token = crypto.randomUUID();
    Object.assign(replacement, { id: recordId, confirmed: false, replacementToken: token });
    units.forEach((unit, index) => Object.assign(unit, { recordId, importOrder: baseOrder + (nextOrder - baseOrder) * index / (units.length + 1) }));
    const history = { kind: 'replace', records: [{ record: cloneHistoryRecord(original), index: recordIndex }], entries,
      replacementId: recordId, replacementToken: token, replacementFileId: item.id, source: original.source };
    state.files.push(item);
    item.processed = true;
    item.status = replacement.status === 'review' ? '替换完成 · 待核对' : '替换完成';
    state.records.splice(recordIndex, 1, replacement);
    state.units = state.units.filter(unit => unit.recordId !== recordId);
    state.units.splice(at, 0, ...units);
    deletedPages.push(history);
    state.skippedPages += batch.skippedPages;
    reconcileFlightAmounts();
    rebuildInvoiceKeys();
    syncRecordsToUnits();
    // Keep the exact position; changing date/company/amount never silently reorders a replacement.
    setOrderMode('manual');
    if (el('previewDialog').open) previewState.unitId = units[0].id;
    committed = true;
  } catch (error) {
    console.warn('invoice replacement', error);
    failureMessage = `替换未完成，原发票已保留：${error.message || '请重新选择可读取的文件'}`;
  } finally {
    if (!committed) item.pdfDoc?.destroy?.();
    state.busy = false;
    setProgress(false, 100, '替换处理结束');
    render();
  }
  if (committed) {
    if (el('previewDialog').open) await openPreview(previewState.unitId);
    toast('已替换整张发票并保留位置，请重新核对；可撤销替换');
  } else toast(failureMessage);
}

async function processFile(item, fileIndex, fileCount, batch = state) {
  const bytes = new Uint8Array(await withTimeout(item.file.arrayBuffer(), 20000, '读取原文件超时'));
  item.contentHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2,'0')).join('');
  const existing = batch.files.find(candidate => candidate !== item && candidate.processed && candidate.contentHash === item.contentHash && batch.units.some(unit => unit.fileId === candidate.id));
  if (existing) {
    item.pages = existing.pages;
    item.kind = existing.kind;
    item.recognizedPages = 0;
    item.duplicatePages = Math.max(1,batch.records.filter(record => record.fileId === existing.id && record.included).length);
    batch.duplicatePages += item.duplicatePages;
    return;
  }
  const kind = detectRealFileKind(bytes, item.file);
  item.kind = kind;
  if (kind === 'image') return processImageFile(item, bytes, fileIndex, fileCount, batch);
  if (kind === 'ofd') return processOfdFile(item, bytes, fileIndex, fileCount, batch);
  if (kind !== 'pdf') throw new Error('Unsupported file format');
  return processPdfBytes(item, bytes, fileIndex, fileCount, null, batch);
}

async function processPdfBytes(item, bytes, fileIndex, fileCount, providedTexts = null, batch = state, providedFallbackTexts = []) {
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
  const pageOcrTexts = [...providedFallbackTexts];
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
      if (!providedTexts && needsOcrRecognition(text)) {
        const ocrText = await ocrPage(page, pct, item.file.name).catch(error => {
          pageIssues[pageNo - 1] = /超时/.test(error.message) ? '识别超时，已继续处理后续页面' : '文字识别失败，已保留原始票面';
          return '';
        });
        pageOcrTexts[pageNo - 1] = ocrText;
      }
      if (!hasRecognizableSignal(text) && !hasRecognizableSignal(pageOcrTexts[pageNo - 1])) {
        item.skippedPages += 1;
        batch.skippedPages += 1;
        pageIssues[pageNo - 1] ||= '未识别出票据信息，请对照原图补录';
        pageTexts.push(text);
        continue;
      }
      item.recognizedPages += 1;
      pageTexts.push(text);
    } catch (error) {
      console.warn('page needs review', item.file.name, pageNo, error);
      item.skippedPages += 1;
      batch.skippedPages += 1;
      pageTexts.push('');
      pageIssues[pageNo - 1] = '此页读取或识别超时，请预览后手动补录';
    }
  }
  const combinedTexts = pageTexts.map((text, index) => [text, pageOcrTexts[index]].filter(Boolean).join('\n'));
  const pageMetas = inferPageOrderMetas(combinedTexts);
  item.orderMeta = detectFileOrderMeta(combinedTexts);
  const parsedRecords = mergeMultiPageRecords(parsePages(pageTexts, item.file.name, item.id, pageMetas, pageIssues, pageOcrTexts));
  rebuildInvoiceKeys(batch);
  const records = parsedRecords.filter(record => {
    if (!record.included || !Number.isFinite(record.amount)) return true;
    const text = combinedTexts[(record.page || 1) - 1] || '';
    const keys = invoiceDedupKeys(record, text);
    const duplicate = keys.some(key => batch.invoiceKeys.has(key));
    if (duplicate) {
      item.duplicatePages += 1;
      batch.duplicatePages += 1;
      return false;
    }
    keys.forEach(key => batch.invoiceKeys.add(key));
    return true;
  });
  item.recognizedPages = records.length;
  batch.records.push(...records);
  combinedTexts.forEach((text, pageIndex) => {
    const record = records.find(candidate => candidate.pages?.includes(pageIndex + 1) || candidate.page === pageIndex + 1);
    if (!record) {
      return;
    }
    batch.units.push({
      id: crypto.randomUUID(), fileId: item.id, page: pageIndex + 1, source: item.file.name,
      recordId: record.id, orderMeta: pageMetas[pageIndex], text,
      importOrder: batch.files.indexOf(item) * 1000000 + pageIndex
    });
  });
}

async function processImageFile(item, bytes, fileIndex, fileCount, batch = state) {
  setProgress(true, Math.round((fileIndex / fileCount) * 88), `正在转换照片 · ${item.file.name}`);
  const decoding = createImageBitmap(item.file, { imageOrientation: 'from-image' });
  let expired = false;
  decoding.then(bitmap => { if (expired) bitmap.close?.(); }).catch(() => {});
  const bitmap = await withTimeout(decoding, 20000, '图片解码超时', () => { expired = true; });
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
  await processPdfBytes(item, pdfBytes, fileIndex, fileCount, [text], batch);
}

async function processOfdFile(item, bytes, fileIndex, fileCount, batch = state) {
  setProgress(true, Math.round((fileIndex / fileCount) * 88), `正在解析 OFD · ${item.file.name}`);
  let expired = false;
  const opening = getOfdDocument(bytes);
  opening.then(doc => { if (expired) doc.destroy?.(); }).catch(() => {});
  const ofd = await withTimeout(opening, 20000, 'OFD 解析超时', () => { expired = true; });
  try {
    const converted = await window.PDFLib.PDFDocument.create();
    const pageTexts = [];
    const fallbackTexts = [];
    for (let pageNo = 1; pageNo <= ofd.numPages; pageNo++) {
      const page = await withTimeout(ofd.getPage(pageNo), 15000, `OFD 第 ${pageNo} 页读取超时`);
      const textContent = await withTimeout(page.getTextContent(), 15000, `OFD 第 ${pageNo} 页文字读取超时`);
      const text = textContent.items.map(item => item.text).join(' ').replace(/[ \t]+/g, ' ').trim();
      const viewport = page.getViewport({ scale: 1.7, rotation: 0 });
      const canvas = document.createElement('canvas');
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport, pixelRatio: 1 });
      await withTimeout(task.promise, 15000, `OFD 第 ${pageNo} 页渲染超时`, () => task.cancel?.());
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = canvas.width;
      pageCanvas.height = canvas.height;
      const pageContext = pageCanvas.getContext('2d');
      pageContext.fillStyle = '#fff';
      pageContext.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      pageContext.drawImage(canvas, 0, 0);
      const pct = Math.round(((fileIndex + pageNo / ofd.numPages) / fileCount) * 88);
      fallbackTexts.push(needsOcrRecognition(text) ? await ocrCanvas(pageCanvas, pct, item.file.name).catch(() => '') : '');
      pageTexts.push(text);
      const jpg = await canvasToJpegBytes(pageCanvas);
      const image = await converted.embedJpg(jpg);
      const width = viewport.width * .75;
      const height = viewport.height * .75;
      const pdfPage = converted.addPage([width, height]);
      pdfPage.drawImage(image, { x: 0, y: 0, width, height });
    }
    const pdfBytes = new Uint8Array(await converted.save());
    await processPdfBytes(item, pdfBytes, fileIndex, fileCount, pageTexts, batch, fallbackTexts);
  } finally { ofd.destroy?.(); }
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
  let active = true;
  let worker;
  let terminated = false;
  const terminate = async () => { if (worker && !terminated) { terminated = true; await worker.terminate(); } };
  try {
    const opening = window.Tesseract.createWorker('chi_sim+eng', 1, {
      workerPath: './vendor/worker.min.js',
      corePath: './vendor/tesseract-core-simd-lstm.wasm.js',
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      logger: message => {
        if (active && state.busy && message.status === 'recognizing text') setProgress(true, Math.max(pct, Math.round(message.progress * 100)), '正在识别扫描文字…');
      }
    });
    opening.then(created => { if (!active) created.terminate().catch(() => {}); }).catch(() => {});
    worker = await withTimeout(opening, 20000, `OCR ${fileName} 初始化超时`);
    const result = await withTimeout(worker.recognize(canvas), 20000, `OCR ${fileName} 超时`, terminate);
    return result.data.text.replace(/[ \t]+/g, ' ').trim();
  } finally { active = false; await terminate().catch(() => {}); }
}

function hasRecognizableSignal(text) {
  const compact = String(text || '').replace(/\s+/g, '');
  if (!compact) return false;
  return /电子发票|E-?INVOICE|发票号码|登机凭证|BOARDING|行程校验单|机票总金额|航空|机票|旅客运输电子客票|铁路电子客票|电子客票号|滴滴出行|旅客运输|住宿|酒店|宾馆/.test(compact)
    || /(?:¥|￥|CNY)\s*\d+(?:\.\d{1,2})?/.test(text);
}

function normalizeInvoiceText(text) {
  return String(text || '').normalize('NFKC').replace(/[，,]/g, '').replace(/￥/g, '¥').replace(/[\u200b-\u200d\ufeff]/g, '');
}

function needsOcrRecognition(text) {
  if (!hasRecognizableSignal(text)) return true;
  const normalized = normalizeInvoiceText(text);
  const compact = normalized.replace(/\s/g, '');
  // Attachments do not require invoice amounts or invoice numbers.
  if (/登机凭证|BOARDING|滴滴出行-?行程单|DIDITRAVEL-?TRIPTABLE/i.test(compact) && !/电子发票|发票号码/.test(compact)) return false;
  const flightLike = /行程校验单|机票总金额/.test(compact);
  const invoiceLike = /电子发票|发票号码|增值税.*发票|INVOICE/i.test(compact);
  return (invoiceLike || flightLike) && (extractAmount(normalized, flightLike) == null || !extractDate(normalized)
    || (invoiceLike && (!extractNumber(normalized, false) || extractSeller(normalized, detectCategory(normalized, flightLike, false), flightLike, false).includes('待核对'))));
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

function parsePages(pageTexts, source, fileId, pageMetas = [], pageIssues = [], fallbackTexts = []) {
  const records = [];
  pageTexts.forEach((text, pageIndex) => {
    const primary = normalizeInvoiceText(text);
    const fallback = normalizeInvoiceText(fallbackTexts[pageIndex]);
    const normalized = [primary, fallback].filter(Boolean).join('\n');
    const compact = normalized.replace(/\s+/g, '');
    const invoiceLike = /电子发票|E-?INVOICE|发票(?:号码|编号|号)|增值税.*发票/i.test(compact);
    const flightLike = pageMetas[pageIndex]?.type === 'flight-itinerary' || /行程校验单|机票总金额/.test(compact);
    const boardingLike = pageMetas[pageIndex]?.type === 'flight-boarding' || /登机凭证|BOARDING/i.test(compact);
    const tripAttachment = pageMetas[pageIndex]?.type === 'taxi-itinerary' || (/滴滴出行\s*-?\s*行程单/i.test(normalized) && !invoiceLike);
    if (tripAttachment || boardingLike) {
      records.push(makeRecord({ source, fileId, page: pageIndex + 1, date: extractDate(normalized), number: boardingLike ? extractFlightNumberFromText(normalized) : '', category: '附件', seller: boardingLike ? '登机凭证' : '打车行程单', amount: null, included: false, status: 'attachment' }));
      return;
    }
    const billableSignal = invoiceLike || flightLike || /铁路电子客票|电子客票号|票据号码/.test(compact);
    if (!hasRecognizableSignal(normalized) || !billableSignal) {
      records.push(makeRecord({ source, fileId, page: pageIndex + 1, seller: '未识别票据 · 请核对原图', included: false, status: 'review', reviewReason: pageIssues[pageIndex] || '未识别出票据信息，请对照原图补录' }));
      return;
    }

    const invoiceStart = normalized.lastIndexOf('电子发票');
    const followsTripSheet = invoiceStart > 0 && /滴滴出行\s*-?\s*行程单|DIDI\s+TRAVEL/i.test(normalized.slice(0, invoiceStart));
    const recordText = followsTripSheet ? normalized.slice(invoiceStart) : normalized;
    // Native text remains authoritative per field. OCR only fills missing fields.
    const primaryStart = primary.lastIndexOf('电子发票');
    const primaryText = followsTripSheet ? (primaryStart >= 0 ? primary.slice(primaryStart) : '') : primary;
    const primaryAmount = extractAmount(primaryText, flightLike);
    const fallbackAmount = extractAmount(fallback, flightLike);
    const amount = primaryAmount ?? fallbackAmount;
    const number = extractNumber(primaryText, flightLike) || extractNumber(fallback, flightLike);
    const date = extractDate(primaryText) || extractDate(fallback);
    const category = detectCategory(recordText, flightLike, boardingLike);
    const nativeSeller = extractSeller(primaryText, category, flightLike, boardingLike);
    const seller = nativeSeller && !nativeSeller.includes('待核对') ? nativeSeller : extractSeller(fallback || recordText, category, flightLike, boardingLike);
    const requiresNumber = invoiceLike && !flightLike;
    const review = amount == null || !seller || seller.includes('待核对') || !date || (requiresNumber && !number);
    records.push(makeRecord({
      date, number, category, seller: seller || '销售方待核对', amount,
      included: Number.isFinite(amount),
      status: review ? 'review' : 'ready',
      reviewReason: review ? (pageIssues[pageIndex] || '信息未识别完整，请核对') : '',
      amountSource: Number.isFinite(primaryAmount) ? '票面自动提取' : Number.isFinite(fallbackAmount) ? 'OCR 补充识别' : '',
      requiresNumber,
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
    status: record.status === 'attachment' ? 'attachment' : Number.isFinite(record.amount) && record.date && record.seller && !record.seller.includes('待核对') && (!record.requiresNumber || record.number) ? 'ready' : 'review',
    reviewReason: Number.isFinite(record.amount) && record.date && record.seller && !record.seller.includes('待核对') && (!record.requiresNumber || record.number) ? '' : record.reviewReason
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
  text = normalizeInvoiceText(text);
  const capital = extractCapitalTotal(text);
  const airlineInvoice = /航空|航\s*空|旅客运输电子客票|电\s*子\s*发\s*票/.test(text);
  const patterns = flightLike ? [
    /(?:机\s*票\s*)?总\s*金\s*额\s*[¥]?\s*(\d+(?:\.\d{1,2})?)/i,
    /总\s*价\s*[:：]?\s*[¥]?\s*(\d+(?:\.\d{1,2})?)/i,
    ...(!/总\s*金\s*额|总\s*价/.test(text) ? [/(?:票\s*价|FARE)[\s:：]*[¥]?\s*(\d+(?:\.\d{1,2})?)/i] : [])
  ] : [
    /[（(]?小\s*写[）)]?\s*[:：]?\s*[¥]?\s*(-?\d+(?:\.\d{1,2})?)(?!\d)/i,
    /TOTAL\s+INCLUDING\s+TAX\s*[¥]?\s*(\d+(?:\.\d{2}))/i,
    /[大壹贰叁肆伍陆柒捌玖拾佰仟万零圆角分整]{3,}\s*¥\s*(\d+(?:\.\d{2}))/i,
    /价\s*税\s*合\s*计[\s\S]{0,45}?[（(]?\s*小\s*写\s*[）)]?[\s:：]*[¥]?\s*(\d+(?:\.\d{2}))/i,
    ...(!/小\s*写/.test(text) ? [/票\s*价\s*[:：]?\s*[¥]\s*(-?\d+\.\d{1,2})/i] : [])
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && isCompleteAmount(text, match)) {
      const value = Number(match[1]);
      return capital == null || Math.round(value * 100) === Math.round(capital * 100) ? value : null;
    }
  }
  if (capital != null) return capital;
  // An unreadable labelled total must stay pending rather than fall back to a
  // line-item amount or tax from elsewhere on the invoice.
  if (/小\s*写/.test(text)) return null;
  if (flightLike && /总\s*金\s*额|总\s*价/.test(text)) return null;
  if (/价\s*税\s*合\s*计|增\s*值\s*税/.test(text)) return null;
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

function extractCapitalTotal(text) {
  const match = text.match(/价\s*税\s*合\s*计\s*[（(]?\s*大\s*写\s*[）)]?[^壹贰叁肆伍陆陸柒捌玖拾佰仟万萬亿億零〇负\d]{0,10}([负壹贰叁肆伍陆陸柒捌玖拾佰仟万萬亿億零〇圆元角分整正\s]+)/);
  if (!match) return null;
  const value = match[1].replace(/\s/g, '');
  const parts = value.match(/^(负?)([壹贰叁肆伍陆陸柒捌玖拾佰仟万萬亿億零〇]+)[圆元](?:(整|正)|(?:零?([壹贰叁肆伍陆陸柒捌玖])角)?(?:零?([壹贰叁肆伍陆陸柒捌玖])分)?)$/);
  if (!parts) return null;
  const digits = { 零:0, 〇:0, 壹:1, 贰:2, 叁:3, 肆:4, 伍:5, 陆:6, 陸:6, 柒:7, 捌:8, 玖:9 };
  const units = { 拾:10, 佰:100, 仟:1000, 万:10000, 萬:10000, 亿:100000000, 億:100000000 };
  let total = 0, section = 0, digit = 0, lastSmallUnit = 10000;
  for (const character of parts[2]) {
    if (Object.hasOwn(digits, character)) {
      if (digit) return null;
      digit = digits[character];
    }
    else {
      const unit = units[character];
      if (unit < 10000) {
        if (unit >= lastSmallUnit || (!digit && (unit !== 10 || section))) return null;
        section += (digit || 1) * unit;
        lastSmallUnit = unit;
      }
      else if (unit === 10000) { total += (section + digit) * unit; section = 0; lastSmallUnit = 10000; }
      else { total = (total + section + digit) * unit; section = 0; lastSmallUnit = 10000; }
      digit = 0;
    }
  }
  const cents = (total + section + digit) * 100 + (digits[parts[4]] || 0) * 10 + (digits[parts[5]] || 0);
  return Number.isSafeInteger(cents) ? cents / 100 * (parts[1] ? -1 : 1) : null;
}

function isCompleteAmount(text, match) {
  // A detached following digit or decimal point means this is a prefix, not a total.
  return !/^(?:[\d.]|[ \t]+[\d.])/.test(text.slice(match.index + match[0].length));
}

function extractNumber(text, flightLike) {
  text = normalizeInvoiceText(text);
  if (flightLike) return extractFlightNumberFromText(text) || text.match(/\b\d{10,14}[A-Z]?\b/)?.[0] || '';
  return text.match(/(?:发\s*票\s*(?:号\s*码|编\s*号|号)|电\s*子\s*客\s*票\s*号|票\s*据\s*号\s*码)\s*[:：]?\s*(\d{8,22})(?!\d)/)?.[1]
    || text.match(/\b(\d{20})\b/)?.[1]
    || text.match(/INVOICE\s+NO\.?\s*[:：]?\s*([A-Z0-9-]+)/i)?.[1]
    || '';
}

function extractDate(text) {
  text = normalizeInvoiceText(text);
  const date = '(20\\d{2})\\s*[年\\-/\\.]\\s*(\\d{1,2})\\s*[月\\-/\\.]\\s*(\\d{1,2})\\s*日?';
  const match = text.match(new RegExp('(?:开\\s*票\\s*日\\s*期|开\\s*具\\s*日\\s*期|出\\s*票\\s*日\\s*期|INVOICE\\s*DATE|DATE\\s*OF\\s*ISSUE)\\s*[:：]?\\s*' + date, 'i'))
    || text.match(new RegExp('(?:DATE|日\\s*期)\\s*[:：]?\\s*' + date, 'i'))
    || text.match(new RegExp(date));
  if (!match) return '';
  const value = `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : '';
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
  return { id: crypto.randomUUID(), date: '', number: '', category: '其他', seller: '', amount: null, included: true, status: 'review', confirmed: false, source: '', page: 1, ...values };
}

function hasExportablePage(record) {
  if (state.demo) return true;
  return state.units.some(unit => unit.recordId === record.id && unit.page > 0 && state.files.some(file => file.id === unit.fileId && file.pdfDoc && file.pdfBytes));
}

function countedRecords(records = state.records) {
  return records.filter(record => record.included && Number.isFinite(record.amount) && hasExportablePage(record));
}

function totalAmount(records) {
  return records.reduce((sum, record) => sum + Math.round(record.amount * 100), 0) / 100;
}

function matchesReviewFilter(record, filter) {
  if (filter === 'all') return true;
  if (filter === 'confirmed') return record.status === 'ready' && record.confirmed;
  if (filter === 'ready') return record.status === 'ready' && !record.confirmed;
  return record.status === filter;
}

function applyViewScale(value, persist = true) {
  viewScale = Math.min(160, Math.max(60, Math.round(Number(value) || 100)));
  document.documentElement?.style.setProperty('--view-scale', String(viewScale / 100));
  document.documentElement?.style.setProperty('--list-text-compensation', String(Math.max(1, 100 / viewScale)));
  el('viewScalePopover').style.setProperty('--thumb-y', ((160 - viewScale) * 1.42 + 30) + 'px');
  el('viewScaleRange').value = String(viewScale);
  el('viewScaleValue').textContent = viewScale + '%';
  el('viewScaleRange').setAttribute('aria-valuetext', viewScale + '%');
  if (persist) {
    preferredViewScale = viewScale;
    try { window.localStorage.setItem(viewScaleStorageKey, String(viewScale)); }
    catch { toast('比例已调整，但本地设置未能保存'); }
  }
  if (persist && !isLocked() && state.files.length) scheduleDraftSave();
}

function readStoredViewScale() {
  try {
    const value = Number(window.localStorage.getItem(viewScaleStorageKey));
    return Number.isInteger(value) && value >= 60 && value <= 160 ? value : null;
  } catch { return null; }
}

function readStoredHiddenInvoiceFields() {
  try {
    const fields = JSON.parse(window.localStorage.getItem(invoiceFieldStorageKey));
    return new Set(Array.isArray(fields) ? fields.filter(field => Object.hasOwn(invoiceFieldLabels, field)) : []);
  } catch { return new Set(); }
}

function applyInvoiceFieldVisibility(persist = false) {
  const collection = el('invoiceCollection');
  document.querySelectorAll('[data-invoice-field-toggle]').forEach(button => {
    const field = button.dataset.invoiceFieldToggle;
    const hidden = hiddenInvoiceFields.has(field);
    collection.classList.toggle(`hide-card-${field}`, hidden);
    button.setAttribute('aria-pressed', String(hidden));
    button.title = `${hidden ? '显示' : '隐藏'}${invoiceFieldLabels[field]}${hidden ? '（当前已隐藏）' : ''}`;
  });
  collection.querySelectorAll('.invoice-item-info').forEach(info => {
    info.hidden = hiddenInvoiceFields.size === 3 && !info.querySelector('.invoice-issue');
  });
  if (persist) {
    try { window.localStorage.setItem(invoiceFieldStorageKey, JSON.stringify([...hiddenInvoiceFields])); }
    catch { toast('显示设置已调整，但本地设置未能保存'); }
  }
}

function setOrderMode(mode) {
  orderMode = ['import', 'date', 'date-desc', 'company', 'company-desc', 'amount', 'amount-desc', 'paired', 'manual'].includes(mode) ? mode : 'import';
  el('sortModeSelect').value = orderMode;
  const primary = getSortDefinition(orderMode);
  if (primary && getSortDefinition(secondarySort)?.field === primary.field) secondarySort = 'none';
  el('secondarySortSelect').value = secondarySort;
  el('secondarySortSelect').querySelectorAll('option').forEach(option => { option.disabled = Boolean(primary && getSortDefinition(option.value)?.field === primary.field); });
}

function renderInvoiceTable() {
  const records = visibleInvoiceRecords();
  const unitsByRecord = new Map();
  state.units.forEach(unit => {
    if (!unitsByRecord.has(unit.recordId)) unitsByRecord.set(unit.recordId, []);
    unitsByRecord.get(unit.recordId).push(unit);
  });
  const recordPositions = new Map(state.records.map((record, index) => [record.id, index + 1]));
  const existingIds = new Set(state.records.map(record => record.id));
  selectedRecords.forEach(id => { if (!existingIds.has(id)) selectedRecords.delete(id); });
  document.querySelectorAll('[data-filter]').forEach(button => {
    button.classList.toggle('active', button.dataset.filter === reviewFilter);
    button.setAttribute('aria-pressed', String(button.dataset.filter === reviewFilter));
  });
  document.querySelectorAll('[data-filter-count]').forEach(node => { node.textContent = state.records.filter(record => matchesReviewFilter(record, node.dataset.filterCount)).length; });
  document.querySelectorAll('[data-layout]').forEach(button => {
    button.classList.toggle('active', button.dataset.layout === layoutMode);
    button.setAttribute('aria-pressed', String(button.dataset.layout === layoutMode));
  });
  el('invoiceCollection').dataset.layout = layoutMode;
  const body = el('invoiceBody');
  thumbnailObserver?.disconnect();
  if (!state.records.length) {
    body.innerHTML = '<div class="collection-empty"><div class="empty-illustration"><span>票</span></div><strong>将 PDF 拖进窗口，开始整理</strong><p>也可以点击上方导入区域选择文件。</p></div>';
  } else if (!records.length) {
    body.innerHTML = '<div class="collection-empty"><strong>没有匹配的票据</strong><p>试试其他关键词或切换识别状态。</p><button id="resetReviewFilters" class="secondary-button" type="button">显示全部票据</button></div>';
    el('resetReviewFilters').addEventListener('click', () => { reviewFilter = 'all'; el('reviewSearch').value = ''; renderInvoiceTable(); el('reviewSearch').focus(); });
  } else {
    body.innerHTML = records.map(record => {
      const units = unitsByRecord.get(record.id) || [];
      const first = units[0];
      const position = recordPositions.get(record.id);
      const status = record.status === 'review' ? '待核对' : record.status === 'attachment' ? '附件，不计金额' : record.confirmed ? '已人工核对' : '已识别，尚未人工核对';
      const statusLabel = record.status === 'review' ? '待核对' : record.status === 'attachment' ? '附件' : record.confirmed ? '已核对' : '已识别';
      const statusClass = record.status === 'review' ? 'review' : record.status === 'attachment' ? 'attachment' : record.confirmed ? 'confirmed' : 'recognized';
      const disabled = isLocked() ? 'disabled' : '';
      const thumbs = units.map(unit => `<div class="invoice-page"><button class="invoice-page-preview" type="button" data-unit-preview="${unit.id}" aria-label="放大查看${escapeHtml(record.source)}第${unit.page}页${record.confirmed ? '，已人工核对' : ''}"><canvas data-thumb="${unit.id}" aria-hidden="true"></canvas>${record.confirmed ? '<span class="page-confirmed" role="img" aria-label="已人工核对" title="已人工核对"><img src="./vendor/icons/check2.svg" alt=""></span>' : ''}<span class="page-magnifier" aria-hidden="true"><img src="./vendor/icons/search.svg" alt=""></span></button><button class="invoice-page-delete" type="button" data-unit-delete="${unit.id}" aria-label="删除${escapeHtml(record.source)}第${unit.page}页" ${disabled}><img src="./vendor/icons/x-lg.svg" alt=""></button></div>`).join('');
      return `<div class="invoice-entry" role="listitem"><div class="invoice-sequence"><span class="position-marker" aria-label="第${position}条票据">${position}</span><span class="recognition-dot ${record.status === 'review' ? 'is-red' : 'is-green'}" role="img" aria-label="${status}" title="${status}"></span><button type="button" class="item-select" data-select-record="${record.id}" aria-label="选择第${position}条票据" aria-pressed="${selectedRecords.has(record.id)}" ${disabled}><img src="./vendor/icons/check2.svg" alt=""></button></div><article class="invoice-item ${selectedRecords.has(record.id) ? 'is-selected' : ''}" data-record-id="${record.id}" data-unit-id="${first?.id || ''}">
        
        <div class="invoice-item-pages">${thumbs || '<span class="no-page">暂无票面，请重试读取</span>'}</div>
        <div class="invoice-item-info"><strong class="invoice-filename" title="${escapeHtml(record.source)}">${escapeHtml(record.source)}</strong><div class="invoice-facts"><span>${escapeHtml(record.date || '日期待核对')}</span></div><span class="invoice-company" title="${escapeHtml(record.seller)}">${escapeHtml(record.seller || '销售方待核对')}</span>${record.reviewReason ? `<p class="invoice-issue">${escapeHtml(record.reviewReason)}</p>` : ''}</div>
        <footer class="invoice-item-footer"><div class="invoice-item-amount">${record.included && Number.isFinite(record.amount) ? `¥ ${money.format(record.amount)}` : '<span>不计入金额</span>'}</div><span class="invoice-status is-${statusClass}" title="${status}">${statusLabel}</span><span class="invoice-category">${escapeHtml(record.category)}</span><div class="invoice-item-controls"><button class="row-action card-select" type="button" data-select-record="${record.id}" aria-pressed="${selectedRecords.has(record.id)}" aria-label="选择${escapeHtml(record.source)}" ${disabled}>${selectedRecords.has(record.id) ? '已选择' : '选择'}</button><button class="row-action invoice-replace" type="button" data-replace-record="${record.id}" aria-label="替换${escapeHtml(record.source)}整张发票" title="替换整张发票，保留当前位置，可撤销" ${disabled}>替换整票</button>${!hasExportablePage(record) ? `<button class="row-action" data-retry="${record.fileId}" ${disabled}>重试读取</button><button class="row-action" data-remove-failed="${record.fileId}" ${disabled}>移除</button>` : ''}</div></footer>
      </article></div>`;
    }).join('');
    body.querySelectorAll('[data-retry]').forEach(button => button.addEventListener('click', () => retryFailedFile(button.dataset.retry)));
    body.querySelectorAll('[data-remove-failed]').forEach(button => button.addEventListener('click', () => removeFailedFile(button.dataset.removeFailed)));
    body.querySelectorAll('[data-replace-record]').forEach(button => button.addEventListener('click', () => requestInvoiceReplacement(button.dataset.replaceRecord)));
    body.querySelectorAll('[data-unit-preview]').forEach(button => button.addEventListener('click', () => openPreview(button.dataset.unitPreview)));
    body.querySelectorAll('[data-unit-delete]').forEach(button => button.addEventListener('click', () => deletePage(button.dataset.unitDelete)));
    body.querySelectorAll('[data-unit-move]').forEach(button => button.addEventListener('click', () => moveInvoiceGroup(button.dataset.unitMove, Number(button.dataset.direction))));
    setupListReordering(body);
    observeListThumbnails(body);
  }
  renderDeleteNotice();
  applyInvoiceFieldVisibility();
  updateSelectionVisuals();
}


function renderBatchSurface() {
  const hasFiles = state.records.length > 0 || (state.busy && state.files.length > 0);
  el('uploadPanel').hidden = hasFiles;
  el('resultsPanel').hidden = !hasFiles;
  el('batchTools').hidden = !hasFiles;
  const header = el('appHeader');
  if (header) header.hidden = !hasFiles;
  el('sideFileCount').textContent = state.files.length;
  el('addMoreButton').disabled = isLocked();
  el('continueImportButton').disabled = isLocked();
  document.body?.classList.toggle('has-files', hasFiles);
  if (!hasFiles) closeSortPanel();
}

function render() {
  renderBatchSurface();
  renderInvoiceTable();
  const included = countedRecords();
  const total = totalAmount(included);
  const locked = isLocked();
  const review = state.records.filter(record => record.status === 'review').length;
  const attachments = state.records.filter(record => record.status === 'attachment').length;
  el('totalAmount').textContent = money.format(total);
  el('invoiceCount').textContent = included.length;
  el('reviewCount').textContent = review;
  el('attachmentCount').textContent = attachments;
  const hasPendingAmount = included.some(record => record.status === 'review');
  el('totalHint').textContent = hasPendingAmount ? '含待核对金额' : '';
  el('totalHint').hidden = !hasPendingAmount;
  el('reviewPendingButton').disabled = locked || !review;
  el('reviewPendingButton').classList.toggle('has-pending', review > 0);
  el('reviewPendingButton').setAttribute('aria-label', review ? `${review} 条待核对，点击筛选` : '暂无待核对票据');
  el('exportButton').disabled = locked || !state.records.length;
  el('clearBatchButton').disabled = locked || !state.files.length;
  el('mergeButton').disabled = locked || !state.units.length;
  dropZone.setAttribute('aria-disabled', String(locked));
  fileInput.disabled = locked;
  el('replacementInput').disabled = locked;
  el('previewReplacementInput').disabled = locked;
  el('reviewView').setAttribute('aria-busy', String(locked));
  el('mergeButton').textContent = state.exporting && state.exportKind === 'pdf' ? '正在导出…' : '导出整批 PDF';
  el('exportButton').textContent = state.exporting && state.exportKind === 'csv' ? '正在保存…' : '导出明细 CSV';
  el('sortModeSelect').disabled = locked || state.units.length < 2;
  el('secondarySortSelect').disabled = locked || state.units.length < 2 || !getSortDefinition(orderMode);
  el('uploadPanel').classList.toggle('has-files', state.files.length > 0);
  el('searchToggleButton').classList.toggle('has-query', Boolean(el('reviewSearch').value.trim()));
  if (el('previewDialog').open && !previewDirty) {
    if (state.units.some(unit => unit.id === previewState.unitId)) resetPreviewForm();
    else el('previewDialog').close();
  }
  if (!locked && !state.demo && state.files.length) scheduleDraftSave();
}

function focusPendingReviews() {
  if (isLocked() || !state.records.some(record => record.status === 'review')) return;
  reviewFilter = 'review';
  el('reviewSearch').value = '';
  el('searchToggleButton').classList.remove('has-query');
  renderInvoiceTable();
  el('invoiceCollection').scrollIntoView?.({ block: 'start' });
  el('invoiceBody').querySelector('[data-unit-preview], [data-retry], [data-replace-record]')?.focus({ preventScroll: true });
}

function removeFailedFile(fileId) {
  if (isLocked() || state.units.some(unit => unit.fileId === fileId)) return;
  state.files = state.files.filter(file => file.id !== fileId);
  state.records = state.records.filter(record => record.fileId !== fileId);
  rebuildInvoiceKeys();
  render();
  if (!state.files.length) clearLocalDraft();
}

function retryFailedFile(fileId) {
  if (isLocked()) return;
  const file = state.files.find(file => file.id === fileId)?.file;
  if (!file || state.units.some(unit => unit.fileId === fileId)) return;
  removeFailedFile(fileId);
  addFiles([file]);
}

function toggleAllVisibleInvoices() {
  if (isLocked()) return;
  const ids = visibleInvoiceRecords().map(record => record.id);
  const all = ids.length && ids.every(id => selectedRecords.has(id));
  ids.forEach(id => { if (all) selectedRecords.delete(id); else selectedRecords.add(id); });
  selectionAnchor = all ? '' : ids[0] || '';
  updateSelectionVisuals();
}

function clearSelection() {
  if (isLocked()) return;
  selectedRecords.clear();
  selectionAnchor = '';
  updateSelectionVisuals();
}

function revealSelection() {
  if (isLocked()) return;
  reviewFilter = 'all';
  el('reviewSearch').value = '';
  el('searchToggleButton').classList.remove('has-query');
  renderInvoiceTable();
}

function cloneHistoryRecord(record) { return { ...record, pages: record.pages ? [...record.pages] : undefined }; }
function cloneDeletionHistory(deletion) {
  if (deletion.kind === 'batch' || deletion.kind === 'replace') return { ...deletion,
    records: deletion.records.map(item => ({ ...item, record: cloneHistoryRecord(item.record) })),
    entries: deletion.entries.map(item => ({ ...item, unit: { ...item.unit } })) };
  return { ...deletion, unit: { ...deletion.unit }, record: cloneHistoryRecord(deletion.record) };
}
function deletionUsesFile(deletion, fileId) {
  return deletion.kind === 'batch' || deletion.kind === 'replace'
    ? deletion.replacementFileId === fileId || deletion.entries.some(item => item.unit.fileId === fileId)
    : deletion.unit?.fileId === fileId;
}

function deleteSelectedInvoices() {
  if (isLocked() || !selectedRecords.size) return;
  const records = state.records.map((record, index) => ({ record: cloneHistoryRecord(record), index })).filter(item => selectedRecords.has(item.record.id));
  if (!records.length) return;
  const entries = state.units.map((unit, index) => ({ unit: { ...unit }, index,
    previousId: state.units[index - 1]?.id, nextId: state.units[index + 1]?.id })).filter(item => selectedRecords.has(item.unit.recordId));
  deletedPages.push({ kind: 'batch', records, entries });
  state.units = state.units.filter(unit => !selectedRecords.has(unit.recordId));
  state.records = state.records.filter(record => !selectedRecords.has(record.id));
  selectedRecords.clear(); selectionAnchor = '';
  reconcileFlightAmounts(); rebuildInvoiceKeys(); syncRecordsToUnits(); render();
  toast(`已删除 ${records.length} 条票据，可撤销`);
}

function undoBatchDelete() {
  if (isLocked() || !['batch', 'replace'].includes(deletedPages.at(-1)?.kind)) return;
  const last = deletedPages.at(-1);
  const previewUnit = state.units.find(unit => unit.id === previewState.unitId);
  const restorePreview = el('previewDialog').open && last.kind === 'replace' && previewUnit?.recordId === last.replacementId;
  if (last.kind === 'replace') {
    const current = state.records.find(record => record.id === last.replacementId);
    if (!current || current.replacementToken !== last.replacementToken) return toast('请先撤销后续操作，再撤销此替换');
    const source = state.files.find(file => file.id === last.records[0]?.record.fileId);
    if (last.entries.length && !source?.pdfDoc) return toast('原发票票面未能恢复，已保留当前替换文件');
    state.records = state.records.filter(record => record.id !== last.replacementId);
    state.units = state.units.filter(unit => unit.recordId !== last.replacementId);
    rebuildInvoiceKeys();
  }
  const batch = deletedPages.pop();
  batch.records.forEach(item => {
    if (state.records.some(record => record.id === item.record.id)) return;
    const record = cloneHistoryRecord(item.record);
    const text = batch.entries.find(entry => entry.unit.recordId === record.id)?.unit.text || '';
    if (record.included && invoiceDedupKeys(record, text).some(key => state.invoiceKeys.has(key))) {
      Object.assign(record, { included: false, confirmed: false, status: 'review', reviewReason: '已恢复票面，本批有相同票号，请核对后再计入金额。' });
    }
    state.records.splice(Math.min(item.index, state.records.length), 0, record);
  });
  batch.entries.forEach(entry => {
    if (state.units.some(unit => unit.id === entry.unit.id)) return;
    const next = state.units.findIndex(unit => unit.id === entry.nextId);
    const previous = state.units.findIndex(unit => unit.id === entry.previousId);
    const at = next >= 0 ? next : previous >= 0 ? previous + 1 : Math.min(entry.index, state.units.length);
    state.units.splice(at, 0, { ...entry.unit });
  });
  batch.records.forEach(item => {
    const record = state.records.find(candidate => candidate.id === item.record.id);
    if (record && state.units.some(unit => unit.recordId === record.id)) syncRecordPages(record);
  });
  reconcileFlightAmounts(); rebuildInvoiceKeys(); syncRecordsToUnits();
  if (restorePreview && batch.entries.length) previewState.unitId = batch.entries[0].unit.id;
  render();
  if (restorePreview && batch.entries.length) openPreview(previewState.unitId);
  toast(batch.kind === 'replace' ? '已撤销替换，原发票及金额已恢复' : `已恢复 ${batch.records.length} 条票据`);
}

function renderDeleteNotice() {
  el('pageDeleteNotice').hidden = !deletedPages.length || renderDeleteNotice.dismissedEntry === deletedPages.at(-1);
  el('undoPageDeleteButton').disabled = isLocked();
  const last = deletedPages.at(-1);
  el('undoPageDeleteButton').textContent = last?.kind === 'replace' ? '撤销替换' : '撤销删除';
  if (last) el('pageDeleteMessage').textContent = last.kind === 'replace'
    ? `已替换 ${last.source}，保留原位置，可撤销。` : last.kind === 'batch'
    ? `已删除 ${last.records.length} 条票据，原始文件不变。`
    : `已移除 ${last.unit.source}，原始文件不变。`;
  if (last && !state.records.length && renderDeleteNotice.lastEmptyEntry !== last) {
    renderDeleteNotice.lastEmptyEntry = last;
    el('undoEmptyDeleteToast').hidden = false;
    clearTimeout(renderDeleteNotice.undoTimer);
    renderDeleteNotice.undoTimer = setTimeout(() => { el('undoEmptyDeleteToast').hidden = true; }, 8000);
  } else if (!last || state.records.length) el('undoEmptyDeleteToast').hidden = true;
}


function matchesInvoiceSearch(record, query) {
  if (!query) return true;
  if ([record.date, record.number, record.seller, record.source, record.category].some(value => String(value ?? '').toLocaleLowerCase().includes(query))) return true;
  if (!Number.isFinite(record.amount)) return false;
  const priceQuery = query.replace(/[¥￥元,，\s]/g, '');
  if (!/^-?\d+(?:\.\d*)?$/.test(priceQuery)) return false;
  return [String(record.amount), record.amount.toFixed(2), money.format(record.amount)].some(value => value.replace(/,/g, '').includes(priceQuery));
}

function visibleInvoiceRecords() {
  const query = el('reviewSearch').value.trim().toLocaleLowerCase();
  return state.records.filter(record => matchesReviewFilter(record, reviewFilter) && matchesInvoiceSearch(record, query));
}

function selectInvoice(recordId, modifiers = {}) {
  if (isLocked()) return;
  const ids = visibleInvoiceRecords().map(record => record.id);
  if (!ids.includes(recordId)) return;
  const additive = modifiers.ctrlKey || modifiers.metaKey;
  if (modifiers.shiftKey && selectionAnchor && ids.includes(selectionAnchor)) {
    if (!additive) selectedRecords.clear();
    const a = ids.indexOf(selectionAnchor), b = ids.indexOf(recordId);
    ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(id => selectedRecords.add(id));
  } else if (additive) {
    if (selectedRecords.has(recordId)) selectedRecords.delete(recordId); else selectedRecords.add(recordId);
    selectionAnchor = recordId;
  } else {
    selectedRecords.clear(); selectedRecords.add(recordId); selectionAnchor = recordId;
  }
  updateSelectionVisuals();
}

function selectInvoicesInRect(rectangle, boxes, additiveIds = []) {
  if (isLocked()) return;
  selectedRecords.clear();
  additiveIds.forEach(id => selectedRecords.add(id));
  boxes.filter(box => box.left < rectangle.right && box.right > rectangle.left && box.top < rectangle.bottom && box.bottom > rectangle.top)
    .forEach(box => selectedRecords.add(box.id));
  updateSelectionVisuals();
}

function updateSelectionVisuals() {
  const visibleIds = visibleInvoiceRecords().map(record => record.id);
  const all = visibleIds.length > 0 && visibleIds.every(id => selectedRecords.has(id));
  el('selectionStrip').hidden = !selectedRecords.size;
  el('selectAllButton').hidden = !selectedRecords.size;
  el('mergeSelectedButton').hidden = !selectedRecords.size;
  el('mergeSelectedButton').disabled = isLocked() || !state.units.some(unit => selectedRecords.has(unit.recordId));
  el('mergeSelectedButton').textContent = state.exporting && state.exportKind === 'pdf' ? '正在导出…' : `合并选中（${selectedRecords.size}）`;
  el('deleteSelectedButton').hidden = !selectedRecords.size;
  el('selectAllButton').textContent = all ? '取消当前全选' : '全选当前';
  el('selectAllButton').disabled = isLocked() || !visibleIds.length;
  el('selectAllButton').setAttribute('aria-pressed', String(all));
  el('deleteSelectedButton').disabled = isLocked();
  const visibleSet = new Set(visibleIds);
  const hiddenCount = [...selectedRecords].filter(id => !visibleSet.has(id)).length;
  el('clearSelectionButton').hidden = !selectedRecords.size;
  el('clearSelectionButton').disabled = isLocked();
  el('revealSelectionButton').hidden = !hiddenCount;
  el('revealSelectionButton').disabled = isLocked();
  el('deleteSelectedButton').title = `删除全部已选 ${selectedRecords.size} 条票据${hiddenCount ? `，含隐藏的 ${hiddenCount} 条` : ''}，可撤销`;
  el('invoiceCollection').classList.toggle('has-selection', selectedRecords.size > 0);
  el('invoiceBody').querySelectorAll('[data-record-id]').forEach(item => {
    const selected = selectedRecords.has(item.dataset.recordId);
    item.classList.toggle('is-selected', selected);
    (item.closest('.invoice-entry') || item).querySelectorAll('[data-select-record]').forEach(button => {
      button.setAttribute('aria-pressed', String(selected));
      if (button.classList.contains('card-select')) button.textContent = selected ? '已选择' : '选择';
    });
  });
  el('selectionSummary').hidden = !selectedRecords.size;
  el('selectionSummary').textContent = selectedRecords.size ? `已选 ${selectedRecords.size} 条${hiddenCount ? `（隐藏 ${hiddenCount} 条）` : ''}` : '';
}

function moveSelectedRecordsToTarget(recordId, targetId) {
  if (isLocked() || recordId === targetId) return false;
  const ids = selectedRecords.has(recordId) ? selectedRecords : new Set([recordId]);
  if (ids.has(targetId)) return false;
  const sourceIndex = state.records.findIndex(record => record.id === recordId);
  const targetIndex = state.records.findIndex(record => record.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return false;
  const moving = state.records.filter(record => ids.has(record.id));
  const remaining = state.records.filter(record => !ids.has(record.id));
  const insertAt = remaining.findIndex(record => record.id === targetId) + (sourceIndex < targetIndex ? 1 : 0);
  remaining.splice(insertAt, 0, ...moving);
  state.records = remaining;
  const groups = new Map();
  state.units.forEach(unit => { if (!groups.has(unit.recordId)) groups.set(unit.recordId, []); groups.get(unit.recordId).push(unit); });
  state.units = state.records.flatMap(record => groups.get(record.id) || []);
  setOrderMode('manual');
  return true;
}

function moveSelectedRecordsAtGap(recordId, targetId, after) {
  if (isLocked()) return false;
  const ids = selectedRecords.has(recordId) ? selectedRecords : new Set([recordId]);
  if (ids.has(targetId)) return false;
  const moving = state.records.filter(record => ids.has(record.id));
  const remaining = state.records.filter(record => !ids.has(record.id));
  const targetIndex = remaining.findIndex(record => record.id === targetId);
  if (!moving.length || targetIndex < 0) return false;
  remaining.splice(targetIndex + (after ? 1 : 0), 0, ...moving);
  if (remaining.every((record, index) => record.id === state.records[index].id)) return false;
  state.records = remaining;
  const groups = new Map();
  state.units.forEach(unit => { if (!groups.has(unit.recordId)) groups.set(unit.recordId, []); groups.get(unit.recordId).push(unit); });
  state.units = state.records.flatMap(record => groups.get(record.id) || []);
  setOrderMode('manual');
  return true;
}

function createDragCardPreview(drag, body) {
  const source = drag.capture;
  const rect = source.getBoundingClientRect();
  const scale = Math.min(1, 410 / rect.width);
  const viewZoom = viewScale / 100;
  const sourceWidth = rect.width / viewZoom;
  const ghost = document.createElement('div');
  ghost.className = `drag-card-preview ${el('invoiceCollection').className}`;
  ghost.dataset.layout = layoutMode;
  ghost.setAttribute('aria-hidden', 'true');
  const layer = document.createElement('div');
  layer.className = 'drag-card-layer';
  layer.style.width = `${sourceWidth}px`;
  layer.style.zoom = String(viewZoom);
  layer.style.transform = `scale(${scale})`;
  const selected = [...body.querySelectorAll('[data-record-id]')].filter(item => selectedRecords.has(item.dataset.recordId) && item !== source);
  const cards = [source, ...selected].slice(0, 3);
  cards.reverse().forEach((card, index) => {
    const clone = card.cloneNode(true);
    clone.classList.remove('is-moving', 'is-drop-target', 'gap-left', 'gap-right', 'gap-up', 'gap-down');
    clone.classList.add('drag-card-copy');
    clone.style.width = `${sourceWidth}px`;
    clone.style.left = `${(cards.length - index - 1) * 6}px`;
    clone.style.top = `${(cards.length - index - 1) * 6}px`;
    clone.style.zIndex = String(index);
    const originalCanvases = card.querySelectorAll('canvas');
    clone.querySelectorAll('canvas').forEach((canvas, i) => {
      if (!originalCanvases[i]) return;
      canvas.width = originalCanvases[i].width; canvas.height = originalCanvases[i].height;
      if (canvas.width && canvas.height) canvas.getContext('2d').drawImage(originalCanvases[i], 0, 0);
    });
    layer.append(clone);
  });
  ghost.append(layer); document.body.append(ghost);
  drag.preview = ghost;
  drag.offsetX = (drag.x - rect.left) * scale;
  drag.offsetY = (drag.y - rect.top) * scale;
  drag.dropBoxes = [...body.querySelectorAll('[data-record-id]')].filter(item => !selectedRecords.has(item.dataset.recordId)).map(node => {
    const box = node.getBoundingClientRect();
    return { node, id: node.dataset.recordId, left: box.left + window.scrollX, right: box.right + window.scrollX, top: box.top + window.scrollY, bottom: box.bottom + window.scrollY };
  });
}

function showDragInsertion(drag, body, clientX, clientY) {
  drag.preview.style.transform = `translate3d(${clientX - drag.offsetX}px,${clientY - drag.offsetY}px,0)`;
  body.querySelectorAll('.invoice-item').forEach(item => {
    item.classList.remove('gap-left', 'gap-right', 'gap-up', 'gap-down', 'is-drop-target');
    item.classList.toggle('is-moving', selectedRecords.has(item.dataset.recordId));
  });
  const x = clientX + window.scrollX, y = clientY + window.scrollY;
  const boxes = drag.dropBoxes;
  let target, distance = Infinity;
  boxes.forEach(box => {
    const dx = Math.max(box.left - x, 0, x - box.right), dy = Math.max(box.top - y, 0, y - box.bottom);
    const nextDistance = dx * dx + dy * dy;
    if (nextDistance < distance) { target = box; distance = nextDistance; }
  });
  const marker = el('dragInsertMarker');
  if (!target || distance > 14400) { marker.hidden = true; drag.gap = null; return; }
  const grid = layoutMode === 'grid';
  const after = grid ? x >= (target.left + target.right) / 2 : y >= (target.top + target.bottom) / 2;
  drag.gap = { targetId: target.id, after };
  const boundary = boxes.indexOf(target) + (after ? 1 : 0);
  const left = boxes[boundary - 1], right = boxes[boundary];
  left?.node.classList.add(grid ? 'gap-left' : 'gap-up');
  right?.node.classList.add(grid ? 'gap-right' : 'gap-down');
  marker.hidden = false;
  marker.classList.toggle('is-horizontal', !grid);
  if (grid) {
    const sameRow = left && right && Math.abs(left.top - right.top) < 10;
    const markerX = sameRow ? (left.right + right.left) / 2 : after ? target.right + 9 : target.left - 9;
    Object.assign(marker.style, { left: `${markerX - window.scrollX - 2}px`, top: `${target.top - window.scrollY}px`, width: '4px', height: `${target.bottom - target.top}px` });
  } else {
    const markerY = left && right ? (left.bottom + right.top) / 2 : after ? target.bottom + 8 : target.top - 8;
    Object.assign(marker.style, { left: `${target.left - window.scrollX}px`, top: `${markerY - window.scrollY - 2}px`, width: `${target.right - target.left}px`, height: '4px' });
  }
}


let selectionHandlersInstalled = false;
function setupListReordering(body) {
  if (selectionHandlersInstalled) return;
  selectionHandlersInstalled = true;
  let drag;
  let suppressClickUntil = 0;
  const region = el('invoiceCollection');
  const clean = () => {
    body.querySelectorAll('.invoice-item').forEach(item => item.classList.remove('is-moving', 'is-drop-target', 'gap-left', 'gap-right', 'gap-up', 'gap-down'));
    drag?.preview?.remove();
    el('dragInsertMarker').hidden = true;
    el('selectionRect').hidden = true;
    el('dragSelectionBadge').hidden = true;
    if (drag?.capture?.hasPointerCapture?.(drag.pointerId)) drag.capture.releasePointerCapture(drag.pointerId);
    drag = null;
  };
  document.addEventListener('pointerdown', event => {
    if (isLocked() || event.button !== 0 || !state.records.length) return;
    if (event.target.closest?.('dialog,.topbar,.workspace-toolbar,.summary-grid,.batch-tools,.selection-actions,.page-delete-notice,.undo-empty-toast,.toast')) return;
    if (!event.target.closest?.('[data-record-id]') && event.clientY < region.getBoundingClientRect().top - 18) return;
    const item = event.target.closest('[data-record-id]');
    const interactive = event.target.closest('input, select, a, button');
    if (interactive && !interactive.matches('.reorder-handle,.invoice-page-preview')) return;
    if (event.pointerType === 'touch' && !event.target.closest('.reorder-handle')) return;
    if (item) {
      const recordId = item.dataset.recordId;
      if (event.ctrlKey || event.metaKey || event.shiftKey || !selectedRecords.has(recordId)) selectInvoice(recordId, event);
      drag = { kind: 'items', recordId, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, targetId: '', capture: item };
    } else {
      event.preventDefault();
      drag = { kind: 'rect', pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false,
        additive: event.ctrlKey || event.metaKey || event.shiftKey ? [...selectedRecords] : [],
        boxes: [...body.querySelectorAll('[data-record-id]')].map(node => { const box = node.getBoundingClientRect(); return { id: node.dataset.recordId, left: box.left, top: box.top, right: box.right, bottom: box.bottom }; }), capture: region };
    }
  });
  document.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    event.preventDefault();
    if (!drag.moved) { drag.moved = true; drag.capture.setPointerCapture?.(event.pointerId); }
    if (drag.kind === 'rect') {
      const rect = { left: Math.min(drag.x, event.clientX), top: Math.min(drag.y, event.clientY), right: Math.max(drag.x, event.clientX), bottom: Math.max(drag.y, event.clientY) };
      Object.assign(el('selectionRect').style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px` });
      el('selectionRect').hidden = false;
      selectInvoicesInRect(rect, drag.boxes, drag.additive);
      return;
    }
    if (!drag.preview) {
      if (!selectedRecords.has(drag.recordId)) selectInvoice(drag.recordId);
      createDragCardPreview(drag, body);
    }
    showDragInsertion(drag, body, event.clientX, event.clientY);
    const badge = el('dragSelectionBadge');
    badge.hidden = false; badge.textContent = `移动 ${selectedRecords.size || 1} 条票据`;
    Object.assign(badge.style, { left: `${event.clientX + 16}px`, top: `${event.clientY + 14}px` });
    if (event.clientY < 100) window.scrollBy({ top: -12 });
    if (event.clientY > window.innerHeight - 70) window.scrollBy({ top: 12 });
  });
  document.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { kind, moved, recordId, gap, additive } = drag;
    clean();
    if (kind === 'items' && moved && gap && moveSelectedRecordsAtGap(recordId, gap.targetId, gap.after)) {
      render(); toast('已更新所选票据与导出顺序');
    } else if (kind === 'rect' && !moved && !additive.length) {
      selectedRecords.clear(); selectionAnchor = ''; updateSelectionVisuals();
    }
    if (moved) suppressClickUntil = Date.now() + 300;
  });
  document.addEventListener('pointercancel', clean);
  body.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil || ((event.ctrlKey || event.metaKey || event.shiftKey) && event.target.closest('.invoice-page-preview'))) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  body.addEventListener('click', event => {
    const button = event.target.closest('[data-select-record]');
    if (button) selectInvoice(button.dataset.selectRecord, { ctrlKey: true });
  });
  document.addEventListener('keydown', event => {
    if (event.target?.closest?.('input,select,textarea') || el('previewDialog').open || el('editDialog').open) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault(); visibleInvoiceRecords().forEach(record => selectedRecords.add(record.id)); updateSelectionVisuals();
    } else if (event.key === 'Escape') { clean(); selectedRecords.clear(); selectionAnchor = ''; updateSelectionVisuals(); }
  });
}


function moveRecordToPosition(recordId, position) {
  if (isLocked()) return false;
  const from = state.records.findIndex(record => record.id === recordId);
  if (from < 0 || !Number.isInteger(position) || position < 1 || position > state.records.length) {
    toast(`请输入 1 到 ${state.records.length} 的顺序编号`);
    return false;
  }
  if (from === position - 1) return false;
  const [record] = state.records.splice(from, 1);
  state.records.splice(position - 1, 0, record);
  const groups = new Map();
  state.units.forEach(unit => { if (!groups.has(unit.recordId)) groups.set(unit.recordId, []); groups.get(unit.recordId).push(unit); });
  state.units = state.records.flatMap(item => groups.get(item.id) || []);
  setOrderMode('manual');
  return true;
}

function moveGroupBefore(fromId, toId) {
  const source = state.units.find(unit => unit.id === fromId), target = state.units.find(unit => unit.id === toId);
  if (!source || !target || source.recordId === target.recordId) return false;
  const from = state.records.findIndex(record => record.id === source.recordId);
  const to = state.records.findIndex(record => record.id === target.recordId);
  return moveRecordToPosition(source.recordId, to + 1 - (from < to ? 1 : 0));
}


function observeListThumbnails(body) {
  const draw = canvas => { const unit = state.units.find(item => item.id === canvas.dataset.thumb); if (unit) renderUnitThumbnail(unit, canvas).catch(error => console.warn('thumbnail', error)); };
  if (typeof IntersectionObserver !== 'undefined') {
    thumbnailObserver = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { thumbnailObserver.unobserve(entry.target); draw(entry.target); } }), { rootMargin: '180px' });
    body.querySelectorAll('[data-thumb]').forEach(canvas => thumbnailObserver.observe(canvas));
  } else body.querySelectorAll('[data-thumb]').forEach(draw);
}

function moveInvoiceGroup(id, direction) {
  if (isLocked()) return;
  const unit = state.units.find(item => item.id === id);
  if (!unit) return;
  const position = state.records.findIndex(record => record.id === unit.recordId) + 1;
  if (!moveRecordToPosition(unit.recordId, position + direction)) return;
  render();
  const buttons = [...el('invoiceBody').querySelectorAll('[data-unit-move]')];
  buttons.find(button => button.dataset.unitMove === id && Number(button.dataset.direction) === direction && !button.disabled)?.focus();
  toast('已更新顺序，导出将使用此顺序');
}

function syncRecordPages(record) {
  record.pages = state.units.filter(unit => unit.recordId === record.id).map(unit => unit.page).sort((a, b) => a - b);
  record.page = record.pages[0];
  record.pageCount = record.pages.length;
}

function rebuildInvoiceKeys(batch = state) {
  batch.invoiceKeys.clear();
  batch.records.filter(record => (record.included || record.linkedInvoiceId) && Number.isFinite(record.amount)).forEach(record => {
    const unit = batch.units.find(unit => unit.recordId === record.id);
    invoiceDedupKeys(record, unit?.text || '').forEach(key => batch.invoiceKeys.add(key));
  });
}

function deletePage(id) {
  if (isLocked()) return;
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
  const cards = el('invoiceBody').querySelectorAll('[data-unit-delete]');
  (cards[Math.min(index, cards.length - 1)] || el('undoPageDeleteButton')).focus({ preventScroll: true });
  toast('已删除此页，可在列表上方撤销；原始文件保持完整');
}

function undoPageDelete() {
  if (isLocked() || !deletedPages.length) return;
  if (previewDirty) return toast('请先保存或重置核对修改，再撤销操作');
  if (['batch', 'replace'].includes(deletedPages.at(-1).kind)) return undoBatchDelete();
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
  el('invoiceBody').querySelector(`[data-unit-delete="${deletion.unit.id}"]`)?.focus({ preventScroll: true });
  toast('已恢复页面，并同步更新明细和合计');
}

async function renderUnitThumbnail(unit, canvas) {
  const fileItem = state.files.find(item => item.id === unit?.fileId);
  if (!fileItem?.pdfDoc || !canvas.isConnected) return;
  const key = `${unit.fileId}:${unit.page}`;
  if (!thumbnailCache.has(key)) {
    const job = thumbnailQueue.then(async () => {
      const page = await fileItem.pdfDoc.getPage(unit.page);
      const viewport = page.getViewport({ scale: 1 });
      const scale = Math.min(340 / viewport.width, 330 / viewport.height) * Math.min(2, window.devicePixelRatio || 1);
      const renderViewport = page.getViewport({ scale });
      const cached = document.createElement('canvas');
      cached.width = Math.ceil(renderViewport.width);
      cached.height = Math.ceil(renderViewport.height);
      await page.render({ canvasContext: cached.getContext('2d'), viewport: renderViewport }).promise;
      return cached;
    });
    thumbnailCache.set(key, job);
    thumbnailQueue = job.catch(() => {});
    job.catch(() => thumbnailCache.delete(key));
  }
  const cached = await thumbnailCache.get(key);
  if (!canvas.isConnected) return;
  canvas.width = cached.width;
  canvas.height = cached.height;
  canvas.getContext('2d').drawImage(cached, 0, 0);
}

function autoArrangeFiles(silent = false) {
  if (isLocked()) return;
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
  setOrderMode('paired');
  syncRecordsToUnits();
  if (!silent) {
    render();
    toast('已按票面内容完成凭证配对排序');
  }
}

function restoreImportOrder() {
  if (isLocked()) return;
  state.units.sort((a, b) => a.importOrder - b.importOrder);
  setOrderMode('import');
  syncRecordsToUnits();
  render();
  toast('已恢复文件导入顺序及原始页序');
}

function invoiceSortGroups() {
  const flightTypes = ['flight-boarding', 'flight-invoice', 'flight-itinerary'];
  const flightRank = { 'flight-boarding': 0, 'flight-invoice': 1, 'flight-itinerary': 2 };
  const groups = [], consumed = new Set();
  const records = new Map(state.records.map(record => [record.id, record]));
  state.units.forEach((unit, index) => {
    if (consumed.has(unit.id)) return;
    let members = state.units.filter(candidate => candidate.recordId === unit.recordId);
    const key = unit.orderMeta?.key;
    if (members.length === 1 && key && flightTypes.includes(unit.orderMeta?.type)) {
      members = state.units.filter(candidate => candidate.orderMeta?.key === key && flightTypes.includes(candidate.orderMeta?.type) && !consumed.has(candidate.id));
    } else if (members.length === 1 && unit.orderMeta?.type === 'taxi-invoice') {
      const following = state.units[index + 1];
      if (following?.orderMeta?.type === 'taxi-itinerary' && !consumed.has(following.id)) members.push(following);
    }
    members.forEach(candidate => consumed.add(candidate.id));
    members.sort((a, b) => (flightRank[a.orderMeta?.type] ?? 9) - (flightRank[b.orderMeta?.type] ?? 9));
    const billable = members.map(member => records.get(member.recordId)).filter(record => record?.included);
    const relevant = billable.length ? billable : members.map(member => records.get(member.recordId)).filter(Boolean);
    const date = relevant.map(record => record.date).filter(Boolean).sort()[0] || '';
    const company = relevant.map(record => record.seller?.trim()).find(seller => seller && !/待核对|未识别|文件读取失败/.test(seller)) || '';
    const priced = [...new Map(relevant.filter(record => Number.isFinite(record.amount)).map(record => [record.id, record])).values()];
    const amount = priced.length ? priced.reduce((sum, record) => sum + Math.round(record.amount * 100), 0) / 100 : null;
    groups.push({ members, date, company, amount, index });
  });
  return groups;
}

function getSortDefinition(mode) {
  const modes = {
    date: { field: 'date', descending: false }, 'date-desc': { field: 'date', descending: true },
    company: { field: 'company', descending: false }, 'company-desc': { field: 'company', descending: true },
    amount: { field: 'amount', descending: false }, 'amount-desc': { field: 'amount', descending: true }
  };
  return modes[mode] || null;
}

function sortInvoiceGroups(field, descending = false, silent = false) {
  if (isLocked()) return;
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const secondary = getSortDefinition(secondarySort);
  const groups = invoiceSortGroups();
  const compareField = (a, b, key, reverse) => {
    const validA = key === 'amount' ? Number.isFinite(a[key]) : Boolean(a[key]);
    const validB = key === 'amount' ? Number.isFinite(b[key]) : Boolean(b[key]);
    if (!validA && !validB) return 0;
    if (!validA) return 1;
    if (!validB) return -1;
    const comparison = key === 'amount' ? a[key] - b[key] : collator.compare(a[key], b[key]);
    return comparison * (reverse ? -1 : 1);
  };
  groups.sort((a, b) => compareField(a, b, field, descending)
    || (secondary && secondary.field !== field ? compareField(a, b, secondary.field, secondary.descending) : 0)
    || a.index - b.index);
  state.units = groups.flatMap(group => group.members);
  setOrderMode(field + (descending ? '-desc' : ''));
  syncRecordsToUnits();
  if (!silent) { render(); toast('已按主排列和副排列更新顺序'); }
}

function sortByInvoiceDate(silent = false, descending = false) { sortInvoiceGroups('date', descending, silent); }
function sortByCompanyName(silent = false, descending = false) { sortInvoiceGroups('company', descending, silent); }
function sortByPrice(silent = false, descending = false) { sortInvoiceGroups('amount', descending, silent); }


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
  const unit = state.units.find(item => item.recordId === id && (!selectedPage || item.page === selectedPage)) || state.units.find(item => item.recordId === id);
  if (unit) return openPreview(unit.id);
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

function capturePreviewScope(id) {
  const recordId = state.units.find(unit => unit.id === id)?.recordId;
  const visibleIds = new Set(visibleInvoiceRecords().map(record => record.id));
  previewRecordScope = visibleIds.has(recordId) && visibleIds.size < state.records.length ? visibleIds : null;
}

function previewUnits() {
  return previewRecordScope ? state.units.filter(unit => previewRecordScope.has(unit.recordId)) : state.units;
}

async function openPreview(id) {
  if (previewDirty) return toast('有未保存的核对内容，请先保存或重置修改');
  const unit = state.units.find(item => item.id === id);
  const record = state.records.find(item => item.id === unit?.recordId);
  const fileItem = state.files.find(item => item.id === unit?.fileId);
  if (!unit || !fileItem?.pdfDoc) return toast('当前票据暂时无法预览');
  if (!el('previewDialog').open) capturePreviewScope(id);

  previewState.unitId = unit.id;
  previewState.rotation = 0;
  updatePreviewNavigation();

  renderPreviewDetails(record, unit);
  if (!el('previewDialog').open) {
    el('previewCanvas').width = 1;
    el('previewCanvas').height = 1;
    el('previewDialog').showModal();
    el('closePreviewButton').focus({ preventScroll: true });
  }
  el('previewDetails').parentElement.scrollTop = 0;
  resetPreviewTransform();
  await renderCurrentPreview();
}

async function renderCurrentPreview() {
  const revision = ++previewRenderRevision;
  const unit = state.units.find(item => item.id === previewState.unitId);
  const fileItem = state.files.find(item => item.id === unit?.fileId);
  if (!unit || !fileItem?.pdfDoc || !el('previewDialog').open) return;
  const canvas = el('previewCanvas');
  const loading = el('previewLoading');
  const rotation = previewState.rotation;
  canvasTasks.get(canvas)?.task?.cancel();
  canvasTasks.delete(canvas);
  previewStage.classList.add('is-loading');
  previewStage.setAttribute('aria-busy', 'true');
  loading.hidden = false;
  loading.textContent = '正在生成预览…';
  await new Promise(resolve => requestAnimationFrame(resolve));
  if (revision !== previewRenderRevision) return;
  try {
    await renderPdfPageToCanvas(fileItem, unit.page, canvas, previewStage, loading, rotation);
  } catch (error) {
    if (revision !== previewRenderRevision) return;
    console.error(error);
    loading.textContent = '预览生成失败，请重新切换页面';
  } finally {
    if (revision === previewRenderRevision) {
      previewStage.classList.remove('is-loading');
      previewStage.setAttribute('aria-busy', 'false');
    }
  }
}

function stepPreview(direction) {
  const units = previewUnits();
  const currentIndex = units.findIndex(unit => unit.id === previewState.unitId);
  if (currentIndex < 0) return;
  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= units.length) return;
  return openPreview(units[nextIndex].id);
}

function jumpPreviewPage() {
  const units = previewUnits();
  const value = el('previewPageInput').value.trim();
  const page = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(page) || page < 1 || page > units.length) {
    updatePreviewNavigation();
    return toast(`请输入 1–${units.length} 之间的整数页码`);
  }
  const unit = units[page - 1];
  if (unit.id === previewState.unitId) return;
  if (previewDirty) {
    updatePreviewNavigation();
    return toast('有未保存的核对内容，请先保存或重置修改');
  }
  return openPreview(unit.id);
}

function renderPreviewDetails(record, unit) {
  const hasAmount = Number.isFinite(record?.amount);
  const included = record?.included && hasAmount;
  const status = record?.status === 'review' ? '待核对' : record?.status === 'attachment' ? '附件' : record?.confirmed ? '已人工核对' : '已识别 · 尚未人工核对';
  el('previewDetails').innerHTML = `<div class="preview-amount"><span>票据金额（元）</span><strong>${hasAmount ? `¥${money.format(record.amount)}` : '未识别'}</strong><p>${included ? '计入本批合计' : '未计入本批合计'}${record?.pages?.length > 1 ? ' · 多页金额仅计一次' : ''}</p></div>
    <div class="preview-record-status ${record?.status === 'review' ? 'needs-review' : ''}"><span class="recognition-dot ${record?.status === 'review' ? 'is-red' : 'is-green'}" aria-hidden="true"></span><div><strong>${status}</strong><p>金额来源：${escapeHtml(record?.amountSource || (hasAmount ? '票面自动提取' : '尚未识别'))}</p></div></div>`;
  el('previewStatusHint').textContent = record?.reviewReason || '';
  el('previewDetailsTitle').textContent = unit.source;
  el('previewDetailsTitle').title = unit.source;
  el('previewPageHint').textContent = record?.pages?.length > 1 ? `原文件第 ${unit.page} 页 · 此发票保留 ${record.pages.length} 页，金额仅计一次` : `原文件第 ${unit.page} 页`;
  el('previewDate').value = record?.date || '';
  el('previewSeller').value = record?.seller || '';
  el('previewNumber').value = record?.number || '';
  el('previewAmount').value = record?.amount ?? '';
  el('previewCategory').value = record?.category || '其他';
  el('previewIncluded').value = String(Boolean(record?.included));
  el('previewForm').querySelectorAll('input, select').forEach(input => { input.disabled = isLocked(); input.removeAttribute('aria-invalid'); });
  el('previewEditButton').disabled = !record || isLocked();
  el('previewReplaceButton').disabled = !record || isLocked();
  const lastAction = deletedPages.at(-1);
  el('previewUndoReplaceButton').hidden = lastAction?.kind !== 'replace' || lastAction.replacementId !== record?.id;
  el('previewUndoReplaceButton').disabled = isLocked();
  const units = previewUnits();
  const index = units.findIndex(item => item.id === unit.id);
  el('previewSaveNext').disabled = isLocked() || !units.slice(index + 1).some(item => item.recordId !== record?.id);
  el('previewSaveHint').textContent = isLocked() ? '正在处理…' : '';
  previewDirty = false;
}

function resetPreviewForm() {
  const unit = state.units.find(item => item.id === previewState.unitId);
  const record = state.records.find(item => item.id === unit?.recordId);
  if (record) renderPreviewDetails(record, unit);
}

function closePreview() {
  if (previewDirty) return toast('有未保存的核对内容，请先保存或重置修改');
  el('previewDialog').close();
}

function savePreview(next) {
  const unit = state.units.find(item => item.id === previewState.unitId);
  const record = state.records.find(item => item.id === unit?.recordId);
  const result = commitRecordChanges(record, readReviewValues('preview'));
  if (!result.ok) return showReviewError('preview', result);
  previewDirty = false;
  render();
  renderPreviewDetails(record, unit);
  if (next) {
    const units = previewUnits();
    const index = units.findIndex(item => item.id === unit.id);
    const nextUnit = units.slice(index + 1).find(item => item.recordId !== record.id);
    if (nextUnit) return openPreview(nextUnit.id);
  }
  toast('已保存人工核对结果，合计已更新');
}

async function refitOpenPreview() {
  if (!el('previewDialog').open) return;
  resetPreviewTransform();
  await renderCurrentPreview();
}

function updatePreviewNavigation() {
  const units = previewUnits();
  const index = units.findIndex(unit => unit.id === previewState.unitId);
  const prev = el('previewPrevButton');
  const next = el('previewNextButton');
  prev.disabled = index <= 0;
  next.disabled = index < 0 || index >= units.length - 1;
  prev.title = index > 0 ? `上一张（第 ${index} 张）` : '已经是第一张';
  next.title = index >= 0 && index < units.length - 1 ? `下一张（第 ${index + 2} 张）` : '已经是最后一张';
  el('previewPageInput').value = String(index + 1);
  el('previewPageInput').max = String(units.length);
  el('previewPageInput').disabled = !units.length;
  el('previewPageTotal').textContent = `/ ${units.length} 页`;
  el('previewScopeBadge').hidden = !previewRecordScope;
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
  // Keep the current page visible until the replacement has finished rendering.
  const buffer = document.createElement('canvas');
  buffer.width = Math.ceil(renderViewport.width);
  buffer.height = Math.ceil(renderViewport.height);
  request.task = page.render({ canvasContext: buffer.getContext('2d'), viewport: renderViewport });
  try { await request.task.promise; } catch (error) {
    if (error.name === 'RenderingCancelledException' || canvasTasks.get(canvas) !== request) return;
    throw error;
  }
  if (canvasTasks.get(canvas) !== request) return;
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  canvas.getContext('2d').drawImage(buffer, 0, 0);
  canvas.style.width = `${Math.round(unitViewport.width * fitScale)}px`;
  canvas.style.height = `${Math.round(unitViewport.height * fitScale)}px`;
  loading.hidden = true;
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
  await renderCurrentPreview();
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

// Accumulate light gestures, pace continuous wheel input, and ignore decaying touchpad momentum.
function setupPreviewWheelNavigation(viewer) {
  let lastWheelTime = -Infinity;
  let lastTurnTime = -Infinity;
  let accumulated = 0;
  let direction = 0;
  let lastTurnMagnitude = 0;
  viewer.addEventListener('wheel', event => {
    if (event.ctrlKey || event.metaKey || event.target.closest('button, input, form')) return;
    event.preventDefault();
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.deltaY === 0) return;
    const now = performance.now();
    const nextDirection = Math.sign(event.deltaY);
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewer.clientHeight : 1);
    if (now - lastWheelTime > 160 || nextDirection !== direction) {
      accumulated = 0;
      lastTurnTime = -Infinity;
      lastTurnMagnitude = 0;
    }
    lastWheelTime = now;
    direction = nextDirection;
    if (previewDirty || previewState.dragging) { accumulated = 0; return; }
    if (now - lastTurnTime < 220 || (event.deltaMode === 0 && Math.abs(delta) < lastTurnMagnitude * .65)) {
      accumulated = 0;
      return;
    }
    accumulated += delta;
    if (Math.abs(accumulated) < 40) return;
    accumulated = 0;
    lastTurnTime = now;
    lastTurnMagnitude = Math.abs(delta);
    stepPreview(nextDirection);
  }, { passive: false });
  el('previewPageForm').addEventListener('wheel', event => event.preventDefault(), { passive: false });
}

function setupPanZoom(stage, canvas, transform, label, { wheelZoom = true } = {}) {
  const pointers = new Map();
  let pinchDistance = 0;
  let pinchZoom = 1;
  const distance = () => { const [a, b] = [...pointers.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
  stage.addEventListener('wheel', event => {
    if (!wheelZoom && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (event.deltaY === 0) return;
    setTransformZoom(transform, transform.zoom + (event.deltaY < 0 ? .14 : -.14), canvas, label);
  }, { passive: false });
  stage.addEventListener('dblclick', () => resetTransform(transform, canvas, label));
  stage.addEventListener('pointerdown', event => {
    if (event.button > 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) { pinchDistance = distance(); pinchZoom = transform.zoom; }
    transform.dragging = true;
    transform.startX = event.clientX;
    transform.startY = event.clientY;
    transform.originX = transform.x;
    transform.originY = transform.y;
    stage.classList.add('dragging');
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2 && pinchDistance > 0) {
      setTransformZoom(transform, pinchZoom * distance() / pinchDistance, canvas, label);
      return;
    }
    if (!transform.dragging) return;
    transform.x = transform.originX + event.clientX - transform.startX;
    transform.y = transform.originY + event.clientY - transform.startY;
    applyTransform(transform, canvas, label);
  });
  ['pointerup', 'pointercancel'].forEach(name => stage.addEventListener(name, event => {
    pointers.delete(event.pointerId);
    transform.dragging = pointers.size > 0;
    if (!transform.dragging) stage.classList.remove('dragging');
    const remaining = [...pointers.values()][0];
    if (remaining) { transform.startX = remaining.x; transform.startY = remaining.y; transform.originX = transform.x; transform.originY = transform.y; }
    pinchDistance = 0;
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
  label.textContent = transform.zoom === 1 ? '适应页面' : `${Math.round(transform.zoom * 100)}%`;
}

function readReviewValues(prefix) {
  return { date: el(`${prefix}Date`).value, seller: el(`${prefix}Seller`).value.trim(), number: el(`${prefix}Number`).value.trim(), category: el(`${prefix}Category`).value,
    amount: el(`${prefix}Amount`).value, included: el(`${prefix}Included`).value === 'true' };
}

function commitRecordChanges(record, values) {
  if (isLocked()) return { error: '正在处理批次，请稍后保存' };
  if (!record) return { error: '未找到当前票据' };
  if (values.included && !hasExportablePage(record)) return { error: '此文件没有可导出票面，请重试读取或移除', field: 'Included' };
  const amount = String(values.amount).trim();
  if ((values.included || amount !== '') && (!/^-?\d+(?:\.\d{1,2})?$/.test(amount) || !Number.isSafeInteger(Math.round(Number(amount) * 100)))) return { error: '请输入有效金额，最多保留两位小数', field: 'Amount' };
  if (values.included && !isValidDate(values.date)) return { error: '请补充有效的开票日期', field: 'Date' };
  if (values.included && (!values.seller || /待核对|未识别/.test(values.seller))) return { error: '请补充票面上的销售方名称', field: 'Seller' };
  const next = { ...record, ...values, amount: amount === '' ? null : Number(amount) };
  if (next.amount != null && !Number.isFinite(next.amount)) return { error: '金额格式不正确', field: 'Amount' };
  const normalizeNumber = value => String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const number = normalizeNumber(next.number);
  if (next.included && number.length >= 10 && state.records.some(candidate => candidate.id !== record.id && (candidate.included || candidate.linkedInvoiceId) && normalizeNumber(candidate.number) === number)) return { error: '本批已有相同票号，请核对或仅作附件，避免重复计算', field: 'Number' };
  if (record.linkedInvoiceId) { next.linkOverride = true; next.linkedInvoiceId = ''; }
  const changedAmount = record.amount !== next.amount;
  Object.assign(record, next, { status: next.included ? 'ready' : 'attachment', confirmed: true, reviewReason: '', amountSource: changedAmount ? '人工修改' : record.amountSource || '票面自动提取' });
  reconcileFlightAmounts();
  rebuildInvoiceKeys();
  return { ok: true };
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function showReviewError(prefix, result) {
  el(`${prefix}StatusHint`).textContent = result.error;
  if (result.field) {
    const field = el(`${prefix}${result.field}`);
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
  toast(result.error);
}

function saveEdit(event) {
  event.preventDefault();
  const record = state.records.find(item => item.id === el('editId').value);
  const result = commitRecordChanges(record, readReviewValues('edit'));
  if (!result.ok) return showReviewError('edit', result);
  el('editDialog').close();
  render();
  toast('已保存人工核对结果，合计已更新');
}

async function copyTotalAmount() {
  const price = totalAmount(countedRecords()).toFixed(2);
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(price);
    else {
      const field = document.createElement('textarea');
      field.value = price;
      Object.assign(field.style, { position: 'fixed', left: '-9999px', top: '0' });
      field.setAttribute('readonly', ''); document.body.append(field); field.select();
      const copied = document.execCommand('copy'); field.remove();
      if (!copied) throw new Error('Clipboard unavailable');
    }
    const button = el('copyTotalButton'); button.classList.add('copied');
    clearTimeout(copyTotalAmount.timer); copyTotalAmount.timer = setTimeout(() => button.classList.remove('copied'), 1400);
    toast('已复制 ' + price);
  } catch { toast('复制失败，请检查剪贴板权限'); }
}

async function exportCsv() {
  if (isLocked()) return toast('正在处理批次，请稍后导出');
  if (previewDirty) return toast('请先保存或重置核对修改，再导出明细');
  const included = countedRecords();
  const includedIds = new Set(included.map(record => record.id));
  const rows = [['序号','开票日期','票据类别','销售方','发票号码或凭证号','金额（元）','是否计入合计','来源文件','识别状态']];
  state.records.forEach((record, index) => rows.push([index + 1, record.date, record.category, record.seller, record.number, record.amount ?? '', includedIds.has(record.id) ? '是' : '否', record.source, record.status === 'ready' ? record.confirmed ? '已人工核对' : '已识别' : record.status === 'attachment' ? '附件' : '待核对']));
  const total = totalAmount(included);
  rows.push(['','','','','合计', total.toFixed(2),'','','']);
  const csv = '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  state.exporting = true;
  state.exportKind = 'csv';
  render();
  try {
    const saved = await downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `报销明细-${dateStamp()}.csv`);
    if (saved !== false) toast('明细已导出');
  } catch (error) { console.error(error); toast('明细保存失败，请重试'); }
  finally { state.exporting = false; state.exportKind = ''; render(); }
}

async function mergePdfs(selectedOnly = false) {
  if (isLocked() || !window.PDFLib || !state.units.length) return;
  if (previewDirty) return toast('请先保存或重置核对修改，再导出 PDF');
  const records = selectedOnly ? state.records.filter(record => selectedRecords.has(record.id)) : state.records;
  const recordIds = new Set(records.map(record => record.id));
  // Filter the export order, never the order in which cards were selected.
  const units = selectedOnly ? state.units.filter(unit => recordIds.has(unit.recordId)) : state.units;
  if (!units.length) return;
  if (selectedOnly && records.some(record => !units.some(unit => unit.recordId === record.id))) return toast('选中票据中有项目没有可导出票面，请重试读取或取消选择');
  const snapshot = { units: units.map(unit => ({ ...unit })), sources: new Map(state.files.map(file => [file.id, file.pdfBytes])), included: countedRecords(records).map(record => ({ ...record })), recordCount: records.length };
  if (snapshot.units.some(unit => !snapshot.sources.get(unit.fileId) || unit.page < 1)) return toast('有页面无法导出，请重试读取或移除异常文件');
  state.exporting = true;
  state.exportKind = 'pdf';
  render();
  try {
    const merged = await window.PDFLib.PDFDocument.create();
    const sources = new Map();
    for (const unit of snapshot.units) {
      if (!sources.has(unit.fileId)) sources.set(unit.fileId, await window.PDFLib.PDFDocument.load(snapshot.sources.get(unit.fileId)));
      const [page] = await merged.copyPages(sources.get(unit.fileId), [unit.page - 1]);
      merged.addPage(page);
    }
    const bytes = await merged.save();
    const included = snapshot.included;
    const total = totalAmount(included);
    const filename = selectedOnly
      ? `${dateTimeStamp()}-${snapshot.recordCount}条-${total.toFixed(2)}元-选中票据合并.pdf`
      : `${dateTimeStamp()}-${included.length}张-${total.toFixed(2)}元-合并发票.pdf`;
    const saved = await downloadBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
    if (saved !== false) toast(selectedOnly ? `已按当前顺序合并 ${snapshot.recordCount} 条选中票据，共 ${snapshot.units.length} 页` : `已导出 ${snapshot.units.length} 个页面`);
  } catch (error) {
    console.error(error);
    toast('合并失败，请检查 PDF 是否加密');
  } finally {
    state.exporting = false;
    state.exportKind = '';
    render();
  }
}

function clearAll() {
  if (isLocked()) return;
  previewDirty = false;
  el('previewDialog').close();
  el('editDialog').close();
  previewState.unitId = '';
  previewRecordScope = null;
  replacementTargetId = '';
  el('replacementInput').value = '';
  el('previewReplacementInput').value = '';
  selectedRecords.clear(); selectionAnchor = '';
  clearLocalDraft();
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
  thumbnailCache.clear();
  setOrderMode('import');
  fileInput.value = '';
  state.activeView = 'review';
  render();
  toast('已清空当前批次');
}

function resetBatch() {
  thumbnailCache.clear();
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

function captureDraft() {
  return {
    version: 1, savedAt: Date.now(), activeView: state.activeView, orderMode, secondarySort, layoutMode, viewScale, cardScaleVersion: 2,
    files: state.files.map(({ pdfDoc, file, pdfBytes, ...metadata }) => ({ ...metadata, file, fileName: file.name, fileType: file.type, lastModified: file.lastModified,
      pdfBytes: metadata.kind === 'pdf' ? undefined : pdfBytes })),
    records: state.records.map(record => ({ ...record, pages: record.pages ? [...record.pages] : undefined })),
    units: state.units.map(unit => ({ ...unit, orderMeta: unit.orderMeta ? { ...unit.orderMeta } : undefined })),
    deletedPages: deletedPages.map(cloneDeletionHistory),
    duplicatePages: state.duplicatePages, skippedPages: state.skippedPages
  };
}

function setDraftStatus(text) {
  const failed = /失败|不可用/.test(text);
  el('storageWarning').hidden = !failed;
  el('storageWarning').textContent = failed ? text : '';
}

function scheduleDraftSave() {
  draftDirty = true;
  draftRevision += 1;
  setDraftStatus('本地草稿待保存…');
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraftSave, 650);
}

async function flushDraftSave() {
  if (isLocked() || state.demo || !state.files.length) return;
  const revision = draftRevision;
  const snapshot = captureDraft();
  setDraftStatus('正在保存本地草稿…');
  draftWrites = draftWrites.catch(() => {}).then(() => saveDraft(snapshot));
  try {
    await draftWrites;
    if (revision === draftRevision) {
      draftDirty = false;
      setDraftStatus('');
    }
  } catch {
    if (revision === draftRevision) setDraftStatus('本地保存失败，请及时导出；刷新可能丢失修改');
  }
}

function clearLocalDraft() {
  clearTimeout(draftTimer);
  draftRevision += 1;
  const revision = draftRevision;
  draftDirty = true;
  draftWrites = draftWrites.catch(() => {}).then(() => deleteDraft());
  draftWrites.then(() => {
    if (revision === draftRevision) { draftDirty = false; setDraftStatus('本地草稿已清空'); }
  }).catch(() => { if (revision === draftRevision) setDraftStatus('草稿清除失败，请检查浏览器本地存储'); });
}

async function restoreLocalDraft() {
  state.restoring = true;
  setDraftStatus('正在检查本地草稿…');
  render();
  try {
    const draft = await withTimeout(loadDraft(), 6000, '读取本地草稿超时');
    if (!draft?.files?.length || draft.version !== 1) { setDraftStatus('票据与修改将自动保存到本机浏览器'); return; }
    layoutMode = draft.layoutMode === 'list' ? 'list' : 'grid';
    if (preferredViewScale === null && draft.cardScaleVersion === 2 && Number.isInteger(draft.viewScale) && draft.viewScale >= 60 && draft.viewScale <= 160) {
      applyViewScale(draft.viewScale);
    }
    state.records = draft.records || [];
    state.units = draft.units || [];
    state.duplicatePages = draft.duplicatePages || 0;
    state.skippedPages = draft.skippedPages || 0;
    deletedPages.push(...(draft.deletedPages || []));
    for (const stored of draft.files) {
      const file = new File([stored.file], stored.fileName || stored.file.name || '恢复票据.pdf', { type: stored.fileType || stored.file.type, lastModified: stored.lastModified });
      const item = { ...stored, file };
      state.files.push(item);
      // Deleted pages also need their source PDF so undo continues to work after refresh.
      if (!state.units.some(unit => unit.fileId === item.id) && !deletedPages.some(deletion => deletionUsesFile(deletion, item.id))) continue;
      try {
        const bytes = stored.pdfBytes ? new Uint8Array(stored.pdfBytes) : new Uint8Array(await file.arrayBuffer());
        const task = pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href, cMapPacked: true,
          standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href, wasmUrl: new URL('./vendor/wasm/', import.meta.url).href, useSystemFonts: true });
        item.pdfDoc = await withTimeout(task.promise, 20000, '恢复票面超时', () => task.destroy());
        item.pdfBytes = bytes;
      } catch {
        item.status = '草稿票面恢复失败 · 可重试读取';
        state.units = state.units.filter(unit => unit.fileId !== item.id);
        state.records.filter(record => record.fileId === item.id).forEach(record => Object.assign(record, { included: false, confirmed: false, status: 'review', page: 0, pages: [], reviewReason: '原文件未能恢复，请重试读取；此项目未计入金额。' }));
        for (let index = deletedPages.length - 1; index >= 0; index--) {
          const deletion = deletedPages[index];
          if (deletion.kind === 'replace') {
            // Keep the replacement if its old source cannot be restored; never undo into missing pages.
            if (deletion.records.some(entry => entry.record.fileId === item.id)) deletedPages.splice(index, 1);
          } else if (deletion.kind === 'batch') {
            deletion.entries = deletion.entries.filter(entry => entry.unit.fileId !== item.id);
            deletion.records.filter(entry => entry.record.fileId === item.id).forEach(entry => Object.assign(entry.record, { included: false, confirmed: false, status: 'review', page: 0, pages: [], reviewReason: '原文件未能恢复，请重试读取。' }));
          } else if (deletion.unit.fileId === item.id) deletedPages.splice(index, 1);
        }
      }
    }
    state.records.filter(record => record.included && !hasExportablePage(record)).forEach(record => Object.assign(record, { included: false, confirmed: false, status: 'review', reviewReason: '未找到对应票面，请重新导入或移除。' }));
    reconcileFlightAmounts();
    rebuildInvoiceKeys();
    secondarySort = getSortDefinition(draft.secondarySort) ? draft.secondarySort : 'none';
    setOrderMode(draft.orderMode || (draft.orderLabel?.includes('日期') ? 'date' : draft.orderLabel?.includes('配对') ? 'paired' : 'import'));
    state.activeView = 'review';
    toast('已恢复上次本地批次，包括修改、顺序和删页撤销记录');
  } catch {
    setDraftStatus('本地草稿不可用；本次操作请及时导出');
  } finally {
    state.restoring = false;
    render();
  }
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
async function downloadBlob(blob, name) { if (window.invoiceDesktop) return window.invoiceDesktop.save(blob, name); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function toast(message) {
  // The native dialog is in the top layer, above the page's toast regardless of z-index.
  if (el('previewDialog').open) el('previewStatusHint').textContent = message;
  const node = el('toast'); node.textContent = message;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'toast-close'; close.textContent = '×'; close.setAttribute('aria-label', '关闭提示');
  close.addEventListener('click', () => { node.classList.remove('show'); clearTimeout(toast.timer); });
  node.append(close); node.classList.add('show'); clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2600);
}

// Bootstrap after listeners are ready. A pending restore locks batch mutations.
applyViewScale(viewScale, false);
render();
restoreLocalDraft();
