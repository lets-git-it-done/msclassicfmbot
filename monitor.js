const query = selector => document.querySelector(selector);
const video = query('#screenPreview');
const canvas = query('#scanCanvas');
const context = canvas.getContext('2d', { willReadFrequently: true });
const dialogCanvas = document.createElement('canvas');
const dialogContext = dialogCanvas.getContext('2d', { willReadFrequently: true });
const itemCanvas = document.createElement('canvas');
const itemContext = itemCanvas.getContext('2d', { willReadFrequently: true });
const feeCanvas = document.createElement('canvas');
const catalogById = new Map();
const monitorItems = new Map();
const alertedItems = new Set();
const missedScans = new Map();
let screenStream = null;
let ocrWorker = null;
let scanning = false;
let scanInProgress = false;
let audioContext = null;
let scanTimer = null;
let backlogCaptureTimer = null;
let backlogScreenshots = [];
let backlogProcessing = false;
let backlogCaptureInProgress = false;
let backlogSuppressed = false;
let backlogOcrWorkers = null;

const feeNotice = 'Please be aware that a 3% fee will be deducted from sales.';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function normalizedText(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getProfit(item) {
  const npcSellBack = catalogById.get(item.itemId)?.npcSellBack ?? null;
  const profitPerItem = npcSellBack !== null && item.shopPrice !== null
    ? npcSellBack - item.shopPrice
    : null;
  const totalProfit = profitPerItem !== null
    ? profitPerItem * item.stock
    : null;
  return { npcSellBack, profitPerItem, totalProfit };
}

function renderItems() {
  const minimumProfit = Math.max(0, Number(query('#minAlertProfit').value) || 0);
  const items = [...monitorItems.values()];
  const candidates = items.filter(item => {
    const { totalProfit } = getProfit(item);
    return item.status === 'available' && totalProfit !== null && totalProfit >= minimumProfit;
  });

  query('#monitorRows').innerHTML = items.map(item => {
    const { npcSellBack, profitPerItem, totalProfit } = getProfit(item);
    const isAlert = candidates.includes(item);
    const soldClass = item.status === 'available' ? '' : 'sold-row';
    const statusOptions = [
      ['available', 'Available'],
      ['sold-out', 'Sold out'],
      ['sold', 'Sold'],
      ['not-seen', 'Not on screen']
    ].map(([value, label]) =>
      `<option value="${value}" ${item.status === value ? 'selected' : ''}>${label}</option>`
    ).join('');

    return `<tr class="${soldClass} ${isAlert ? 'alert-row' : ''}">` +
      `<td>${escapeHtml(item.name)}</td>` +
      `<td><select data-item-id="${item.itemId}" data-field="status">${statusOptions}</select></td>` +
      `<td><input aria-label="Stock for ${escapeHtml(item.name)}" data-item-id="${item.itemId}" data-field="stock" type="number" min="0" step="1" value="${item.stock}"></td>` +
      `<td><input aria-label="Shop price for ${escapeHtml(item.name)}" data-item-id="${item.itemId}" data-field="shopPrice" type="number" min="0" step="1" value="${item.shopPrice ?? ''}" placeholder="Unknown"></td>` +
      `<td>${npcSellBack === null ? 'Unknown' : `${npcSellBack.toLocaleString()} mesos`}</td>` +
      `<td class="${profitPerItem === null ? '' : profitPerItem > 0 ? 'profit' : 'bad'}">${profitPerItem === null ? '—' : `${profitPerItem.toLocaleString()} mesos`}</td>` +
      `<td class="${totalProfit === null ? '' : totalProfit > 0 ? 'profit' : 'bad'}">${totalProfit === null ? '—' : `${totalProfit.toLocaleString()} mesos`}</td>` +
      `</tr>`;
  }).join('');

  query('#monitorEmpty').hidden = items.length > 0;
  query('#alertSummary').textContent = candidates.length
    ? `${candidates.length} item${candidates.length === 1 ? '' : 's'} meet the alert threshold.`
    : 'No qualifying alerts.';

  updateAlerts(candidates);
}

function updateAlerts(candidates) {
  const qualifyingNow = new Set(candidates.map(item => item.itemId));
  const newAlerts = candidates.filter(item => !alertedItems.has(item.itemId));
  for (const itemId of [...alertedItems]) {
    if (!qualifyingNow.has(itemId)) alertedItems.delete(itemId);
  }
  for (const item of newAlerts) alertedItems.add(item.itemId);

  if (newAlerts.length) {
    playPing();
    query('#monitorStatus').textContent = newAlerts.map(item => {
      const { totalProfit } = getProfit(item);
      return `${item.name}: +${totalProfit.toLocaleString()} mesos`;
    }).join(' · ');
  }
}

function playPing() {
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.16, audioContext.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.28);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.3);
}

function getDialogCrop(sourceWidth, sourceHeight) {
  const leftPercent = Math.min(95, Math.max(0, Number(query('#cropLeft').value) || 0));
  const topPercent = Math.min(95, Math.max(0, Number(query('#cropTop').value) || 0));
  const widthPercent = Math.min(100 - leftPercent, Math.max(5, Number(query('#cropWidth').value) || 5));
  const heightPercent = Math.min(100 - topPercent, Math.max(5, Number(query('#cropHeight').value) || 5));

  return {
    x: Math.round(sourceWidth * leftPercent / 100),
    y: Math.round(sourceHeight * topPercent / 100),
    width: Math.round(sourceWidth * widthPercent / 100),
    height: Math.round(sourceHeight * heightPercent / 100)
  };
}

function updateCropOverlay() {
  const overlay = query('#dialogCropOverlay');
  const frame = video.parentElement;
  const frameRect = frame.getBoundingClientRect();
  const videoRect = video.getBoundingClientRect();
  const crop = getDialogCrop(100, 100);

  if (!video.videoWidth || !video.videoHeight) {
    overlay.style.left = `${crop.x}%`;
    overlay.style.top = `${crop.y}%`;
    overlay.style.width = `${crop.width}%`;
    overlay.style.height = `${crop.height}%`;
    return;
  }

  const videoRatio = video.videoWidth / video.videoHeight;
  const renderedWidth = Math.min(videoRect.width, videoRect.height * videoRatio);
  const renderedHeight = renderedWidth / videoRatio;
  const contentLeft = videoRect.left - frameRect.left + (videoRect.width - renderedWidth) / 2;
  const contentTop = videoRect.top - frameRect.top + (videoRect.height - renderedHeight) / 2;
  overlay.style.left = `${contentLeft + renderedWidth * crop.x / 100}px`;
  overlay.style.top = `${contentTop + renderedHeight * crop.y / 100}px`;
  overlay.style.width = `${renderedWidth * crop.width / 100}px`;
  overlay.style.height = `${renderedHeight * crop.height / 100}px`;
}

function prepareDialogImages(crop) {
  dialogCanvas.width = crop.width;
  dialogCanvas.height = crop.height;
  dialogContext.drawImage(
    canvas,
    crop.x, crop.y, crop.width, crop.height,
    0, 0, crop.width, crop.height
  );

  const itemRect = {
    x: Math.round(crop.width * 0.015),
    y: Math.round(crop.height * 0.335),
    width: Math.round(crop.width * 0.435),
    height: Math.round(crop.height * 0.525)
  };
  itemCanvas.width = itemRect.width;
  itemCanvas.height = itemRect.height;
  itemContext.drawImage(
    dialogCanvas,
    itemRect.x, itemRect.y, itemRect.width, itemRect.height,
    0, 0, itemRect.width, itemRect.height
  );

  feeCanvas.width = Math.round(crop.width * 0.44);
  feeCanvas.height = Math.round(crop.height * 0.12);
  feeCanvas.getContext('2d').drawImage(
    dialogCanvas,
    Math.round(crop.width * 0.01),
    Math.round(crop.height * 0.875),
    feeCanvas.width,
    feeCanvas.height,
    0, 0, feeCanvas.width, feeCanvas.height
  );
}

function detectLighterRows(ocrLines, sourceCanvas = itemCanvas, sourceContext = itemContext) {
  const rows = (ocrLines || []).flatMap(line => {
    const text = normalizedText(line.text || '');
    const item = [...catalogById.values()]
      .sort((left, right) => right.name.length - left.name.length)
      .find(entry => text.includes(normalizedText(entry.name)));
    if (!item || !line.bbox) return [];

    const { x0, y0, x1, y1 } = line.bbox;
    const left = Math.max(0, Math.floor(x0));
    const top = Math.max(0, Math.floor(y0));
    const width = Math.min(sourceCanvas.width - left, Math.max(1, Math.ceil(x1 - x0)));
    const height = Math.min(sourceCanvas.height - top, Math.max(1, Math.ceil(y1 - y0)));
    if (width <= 0 || height <= 0) return [];

    const pixels = sourceContext.getImageData(left, top, width, height).data;
    let luminance = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      luminance += 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
    }
    return [{ itemId: item.id, luminance: luminance / (pixels.length / 4) }];
  });

  if (rows.length < 2) return new Set();
  const sortedLuminance = rows.map(row => row.luminance).sort((a, b) => a - b);
  const middle = Math.floor(sortedLuminance.length / 2);
  const median = sortedLuminance.length % 2
    ? sortedLuminance[middle]
    : (sortedLuminance[middle - 1] + sortedLuminance[middle]) / 2;
  return new Set(
    rows
      .filter(row => row.luminance >= median + 12 && row.luminance >= median * 1.12)
      .map(row => row.itemId)
  );
}

function parseMarketText(text, visuallySold = new Set()) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const normalizedLines = lines.map(normalizedText);
  const catalog = [...catalogById.values()]
    .sort((left, right) => right.name.length - left.name.length);
  const detected = [];

  for (let index = 0; index < lines.length; index += 1) {
    const item = catalog.find(entry =>
      normalizedLines[index].includes(normalizedText(entry.name))
    );
    if (!item) continue;

    const nextItemIndex = lines.findIndex((line, nextIndex) =>
      nextIndex > index && catalog.some(entry =>
        normalizedText(line).includes(normalizedText(entry.name))
      )
    );
    const rowText = lines.slice(index, nextItemIndex < 0 ? index + 3 : Math.min(nextItemIndex, index + 3)).join(' ');
    const status = /\b(sold\s*out|out\s*of\s*stock|unavailable)\b/i.test(rowText)
      ? 'sold-out'
      : /\bsold\b/i.test(rowText)
        ? 'sold'
        : visuallySold.has(item.id)
          ? 'sold'
        : 'available';
    const numbers = rowText
      .replace(new RegExp(item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '')
      .match(/\d[\d,]*/g)
      ?.map(value => Number(value.replace(/,/g, '')))
      .filter(Number.isFinite) || [];
    const offerMatch = rowText.match(/(\d[\d,]*)\s*for\s*(\d[\d,]*)\s+(?:mesos?|each)/i);
    const stockMatch = rowText.match(/(?:stock|qty|quantity|x)\s*[:=]?\s*(\d[\d,]*)/i);
    const priceMatch = rowText.match(/(?:price|mesos?|each|ea)\s*[:=]?\s*(\d[\d,]*)/i);
    const stock = status === 'available'
      ? offerMatch
        ? Number(offerMatch[1].replace(/,/g, ''))
        : stockMatch ? Number(stockMatch[1].replace(/,/g, '')) : numbers.length > 1 ? numbers[0] : null
      : 0;
    const shopPrice = status !== 'available'
      ? null
      : offerMatch
        ? Number(offerMatch[2].replace(/,/g, ''))
        : priceMatch
        ? Number(priceMatch[1].replace(/,/g, ''))
        : numbers.length > 1
          ? numbers[1]
          : numbers.length === 1
            ? numbers[0]
            : null;

    detected.push({
      itemId: item.id,
      name: item.name,
      status,
      stock: stock === null ? 0 : stock,
      shopPrice: shopPrice === null ? null : shopPrice
    });
  }
  return detected;
}

function reconcileScannedItems(detectedItems) {
  const seenItemIds = new Set(detectedItems.map(item => item.itemId));
  const minimumProfit = Math.max(0, Number(query('#minAlertProfit').value) || 0);

  for (const item of detectedItems) {
    missedScans.delete(item.itemId);
    monitorItems.set(item.itemId, item);
  }

  for (const [itemId, item] of monitorItems) {
    if (seenItemIds.has(itemId)) continue;

    const misses = (missedScans.get(itemId) || 0) + 1;
    missedScans.set(itemId, misses);
    if (misses < 2) continue;

    const { totalProfit } = getProfit(item);
    if (totalProfit !== null && totalProfit >= minimumProfit) {
      item.status = 'not-seen';
      continue;
    }

    monitorItems.delete(itemId);
    missedScans.delete(itemId);
    alertedItems.delete(itemId);
  }
}

async function loadOcrWorker() {
  if (ocrWorker) return ocrWorker;
  query('#scanStatus').textContent = 'Loading local OCR engine…';
  ocrWorker = await createOcrWorker(progress => {
    if (progress.status === 'recognizing text') {
      query('#scanStatus').textContent = `Scanning dialog… ${Math.round(progress.progress * 100)}%`;
    }
  });
  return ocrWorker;
}

function createOcrWorker(logger = () => {}) {
  return Tesseract.createWorker('eng', 1, {
    workerPath: '/node_modules/tesseract.js/dist/worker.min.js',
    corePath: '/node_modules/tesseract.js-core/tesseract-core.wasm.js',
    langPath: '/node_modules/@tesseract.js-data/eng/4.0.0',
    gzip: true,
    logger
  });
}

function loadBacklogOcrWorkers() {
  if (!backlogOcrWorkers) {
    const workerCount = Math.min(2, Math.max(1, navigator.hardwareConcurrency || 2));
    backlogOcrWorkers = Promise.all(
      Array.from({ length: workerCount }, () => createOcrWorker())
    );
  }
  return backlogOcrWorkers;
}

function startBacklogCapture() {
  if (backlogCaptureTimer || backlogSuppressed) return;
  backlogCaptureTimer = setInterval(() => {
    captureBacklogScreenshot().catch(error => {
      query('#scanStatus').textContent = `Backlog capture failed: ${error.message}`;
      stopBacklogCapture(true);
    });
  }, 1000);
  query('#scanStatus').textContent = 'Free Market detected · capturing an OCR backlog every second.';
}

function stopBacklogCapture(suppressUntilLiveScan = false) {
  if (backlogCaptureTimer) clearInterval(backlogCaptureTimer);
  backlogCaptureTimer = null;
  backlogScreenshots = [];
  if (suppressUntilLiveScan) backlogSuppressed = true;
}

async function captureBacklogScreenshot() {
  if (
    !scanning ||
    !backlogCaptureTimer ||
    backlogCaptureInProgress ||
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
  ) return;

  backlogCaptureInProgress = true;
  try {
    const crop = getDialogCrop(video.videoWidth, video.videoHeight);
    const screenshot = document.createElement('canvas');
    screenshot.width = crop.width;
    screenshot.height = crop.height;
    screenshot.getContext('2d').drawImage(
      video,
      crop.x, crop.y, crop.width, crop.height,
      0, 0, crop.width, crop.height
    );
    const blob = await new Promise(resolve => screenshot.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not encode the captured dialog image.');
    if (!scanning || !backlogCaptureTimer) return;

    backlogScreenshots.push({ blob, capturedAt: Date.now() });
    query('#scanStatus').textContent =
      `Free Market detected · ${backlogScreenshots.length} screenshot${backlogScreenshots.length === 1 ? '' : 's'} queued for OCR.`;
    processBacklogScreenshots();
  } finally {
    backlogCaptureInProgress = false;
  }
}

async function recognizeBacklogScreenshot(blob) {
  const dialogImage = await createImageBitmap(blob);
  try {
    const itemCrop = {
      x: Math.round(dialogImage.width * 0.015),
      y: Math.round(dialogImage.height * 0.335),
      width: Math.round(dialogImage.width * 0.435),
      height: Math.round(dialogImage.height * 0.525)
    };
    const itemImage = document.createElement('canvas');
    itemImage.width = itemCrop.width;
    itemImage.height = itemCrop.height;
    const itemImageContext = itemImage.getContext('2d', { willReadFrequently: true });
    itemImageContext.drawImage(
      dialogImage,
      itemCrop.x, itemCrop.y, itemCrop.width, itemCrop.height,
      0, 0, itemCrop.width, itemCrop.height
    );

    const feeImage = document.createElement('canvas');
    feeImage.width = Math.round(dialogImage.width * 0.44);
    feeImage.height = Math.round(dialogImage.height * 0.12);
    feeImage.getContext('2d').drawImage(
      dialogImage,
      Math.round(dialogImage.width * 0.01),
      Math.round(dialogImage.height * 0.875),
      feeImage.width, feeImage.height,
      0, 0, feeImage.width, feeImage.height
    );

    const [feeWorker, itemWorker] = await loadBacklogOcrWorkers();
    let feeResult;
    let itemResult;
    if (itemWorker) {
      [feeResult, itemResult] = await Promise.all([
        feeWorker.recognize(feeImage),
        itemWorker.recognize(itemImage)
      ]);
    } else {
      feeResult = await feeWorker.recognize(feeImage);
      const feeText = normalizedText(feeResult.data.text);
      if (!feeText.includes(normalizedText(feeNotice))) {
        return { dialogDetected: false, feeText };
      }
      itemResult = await feeWorker.recognize(itemImage);
    }
    const feeText = normalizedText(feeResult.data.text);
    const dialogDetected = feeText.includes(normalizedText(feeNotice));
    if (!dialogDetected) return { dialogDetected, feeText };

    const visuallySold = detectLighterRows(itemResult.data.lines, itemImage, itemImageContext);
    return {
      dialogDetected,
      feeText,
      itemText: itemResult.data.text,
      detectedItems: parseMarketText(itemResult.data.text, visuallySold)
    };
  } finally {
    dialogImage.close();
  }
}

async function processBacklogScreenshots() {
  if (backlogProcessing) return;
  backlogProcessing = true;
  try {
    while (scanning && backlogCaptureTimer && backlogScreenshots.length) {
      while (scanInProgress && scanning && backlogCaptureTimer) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!scanning || !backlogCaptureTimer) break;

      const screenshot = backlogScreenshots[0];
      const result = await recognizeBacklogScreenshot(screenshot.blob);
      if (!scanning || !backlogCaptureTimer) {
        backlogScreenshots = [];
        break;
      }
      backlogScreenshots.shift();
      if (!result.dialogDetected) {
        query('#recognizedText').textContent = `Backlog fee-area OCR:\n${result.feeText || '(no text recognized)'}`;
        query('#scanStatus').textContent = 'Backlog OCR no longer detects the Free Market dialog; remaining screenshots discarded.';
        query('#monitorStatus').textContent = 'Monitoring locally; screenshot backlog stopped after dialog disappeared.';
        stopBacklogCapture(true);
        break;
      }

      reconcileScannedItems(result.detectedItems);
      query('#recognizedText').textContent = `Backlog item list:\n${result.itemText || '(no item text recognized)'}`;
      query('#lastScan').textContent = `Last scan: ${new Date(screenshot.capturedAt).toLocaleTimeString()}`;
      renderItems();
    }
  } catch (error) {
    query('#scanStatus').textContent = `Backlog OCR failed: ${error.message}`;
    stopBacklogCapture(true);
  } finally {
    backlogProcessing = false;
  }
}

async function scanFrame() {
  if (
    !scanning ||
    scanInProgress ||
    backlogProcessing ||
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
  ) return;
  scanInProgress = true;
  try {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const worker = await loadOcrWorker();
    const crop = getDialogCrop(canvas.width, canvas.height);
    prepareDialogImages(crop);
    const feeResult = await worker.recognize(feeCanvas);
    const feeText = normalizedText(feeResult.data.text);
    const expectedFeeText = normalizedText(feeNotice);
    const marketDialogDetected = feeText.includes(expectedFeeText);
    if (!marketDialogDetected) {
      stopBacklogCapture();
      backlogSuppressed = false;
      query('#monitorStatus').textContent = 'Monitoring locally; Free Market dialog not detected.';
      query('#recognizedText').textContent = `Dialog fee-area OCR:\n${feeResult.data.text || '(no text recognized)'}`;
      query('#scanStatus').textContent = 'Free Market dialog not confirmed. Adjust the crop until the red outline covers the dialog and fee notice.';
      return;
    }
    if (!backlogSuppressed) {
      startBacklogCapture();
      query('#monitorStatus').textContent =
        `Monitoring locally; polling every ${query('#scanInterval').value.trim()} ms.`;
    }

    const itemResult = await worker.recognize(itemCanvas);
    query('#recognizedText').textContent =
      `Fee notice:\n${feeResult.data.text}\n\nItem list:\n${itemResult.data.text || '(no item text recognized)'}`;
    const visuallySold = detectLighterRows(itemResult.data.lines);
    const detectedItems = parseMarketText(itemResult.data.text, visuallySold);
    reconcileScannedItems(detectedItems);
    query('#scanStatus').textContent = detectedItems.length
      ? `Free Market detected · ${detectedItems.length} catalog item${detectedItems.length === 1 ? '' : 's'} recognized.`
      : 'Free Market confirmed by the fee notice, but no catalog items were recognized. You can edit rows below.';
    query('#lastScan').textContent = `Last scan: ${new Date().toLocaleTimeString()}`;
    renderItems();
  } catch (error) {
    query('#scanStatus').textContent = `Scan failed: ${error.message}`;
  } finally {
    scanInProgress = false;
  }
}

async function startMonitor() {
  const interval = getScanInterval();
  if (interval === null) return;

  if (!navigator.mediaDevices?.getDisplayMedia) {
    query('#monitorStatus').textContent = 'Screen capture is not supported in this browser.';
    return;
  }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: false
    });
    video.srcObject = screenStream;
    await video.play();
    updateCropOverlay();
    audioContext = new AudioContext();
    await audioContext.resume();
    scanning = true;
    query('#startMonitor').disabled = true;
    query('#stopMonitor').disabled = false;
    query('#monitorStatus').textContent = `Monitoring locally; polling every ${interval} ms.`;
    query('#scanStatus').textContent = 'Waiting for first scan…';
    scanTimer = setInterval(scanFrame, interval);
    await scanFrame();
    screenStream.getVideoTracks()[0].addEventListener('ended', stopMonitor);
  } catch (error) {
    if (screenStream) stopMonitor();
    query('#monitorStatus').textContent = `Could not start screen monitoring: ${error.message}`;
  }
}

function getScanInterval() {
  const input = query('#scanInterval');
  const status = query('#scanIntervalStatus');
  const value = input.value.trim();
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 2_147_483_647) {
    status.textContent = 'Enter a whole number of milliseconds greater than 0.';
    return null;
  }

  status.textContent = 'OCR scans run one at a time, so recognition may take longer than the polling interval.';
  return Number(value);
}

function updateScanInterval() {
  const interval = getScanInterval();
  if (interval === null || !scanning) return;

  if (scanTimer) clearInterval(scanTimer);
  scanTimer = setInterval(scanFrame, interval);
  query('#monitorStatus').textContent = `Monitoring locally; polling every ${interval} ms.`;
}

function stopMonitor() {
  scanning = false;
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  stopBacklogCapture();
  backlogSuppressed = false;
  if (screenStream) {
    for (const track of screenStream.getTracks()) track.stop();
  }
  screenStream = null;
  if (audioContext && audioContext.state !== 'closed') audioContext.close();
  audioContext = null;
  video.srcObject = null;
  updateCropOverlay();
  query('#startMonitor').disabled = false;
  query('#stopMonitor').disabled = true;
  query('#monitorStatus').textContent = 'Monitor stopped.';
  query('#scanStatus').textContent = 'Screen capture is off.';
}

async function initialize() {
  try {
    const response = await fetch('/api/npc-catalog');
    if (!response.ok) throw new Error(`Catalog request failed with HTTP ${response.status}`);
    const catalog = await response.json();
    for (const item of catalog) catalogById.set(item.id, item);
    renderItems();
  } catch (error) {
    query('#monitorStatus').textContent = `Could not load NPC values: ${error.message}`;
  }
}

query('#startMonitor').addEventListener('click', startMonitor);
query('#stopMonitor').addEventListener('click', stopMonitor);
query('#scanInterval').addEventListener('input', updateScanInterval);
query('#minAlertProfit').addEventListener('input', () => {
  const minimumProfit = Math.max(0, Number(query('#minAlertProfit').value) || 0);
  for (const [itemId, item] of monitorItems) {
    const { totalProfit } = getProfit(item);
    if (item.status === 'not-seen' && (totalProfit === null || totalProfit < minimumProfit)) {
      monitorItems.delete(itemId);
      missedScans.delete(itemId);
      alertedItems.delete(itemId);
    }
  }
  renderItems();
});
['cropLeft', 'cropTop', 'cropWidth', 'cropHeight'].forEach(id => {
  query(`#${id}`).addEventListener('input', updateCropOverlay);
});
query('#monitorRows').addEventListener('change', event => {
  const input = event.target.closest('[data-item-id][data-field]');
  if (!input) return;
  const item = monitorItems.get(Number(input.dataset.itemId));
  if (!item) return;

  if (input.dataset.field === 'status') {
    item.status = input.value;
    if (item.status !== 'available') item.stock = 0;
  } else if (input.dataset.field === 'stock') {
    item.stock = Math.max(0, Number(input.value) || 0);
  } else if (input.dataset.field === 'shopPrice') {
    item.shopPrice = input.value === '' ? null : Math.max(0, Number(input.value) || 0);
  }
  renderItems();
});

window.addEventListener('beforeunload', stopMonitor);
window.addEventListener('resize', updateCropOverlay);
video.addEventListener('resize', updateCropOverlay);
updateCropOverlay();
initialize();
