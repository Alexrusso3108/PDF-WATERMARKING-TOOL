/* ============================================================
   WatermarkPDF — Application Logic (v4)
   Uses base64 strings for all pdf-lib I/O to bypass SES lockdown.
   SES (shipped with pdf-lib) patches ArrayBuffer/Blob APIs;
   plain base64 strings are primitives and immune to this.
   ============================================================ */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────
  let pdfFile          = null;
  let pdfPageCount     = 0;
  let watermarkedBytes = null;          // Uint8Array from pdfDoc.save()
  let watermarkedUrl   = null;          // Base64 Data URL for SES-proof download
  let selectedPosition = 'center';
  let logoFile         = null;
  let logoBase64       = null;          // raw base64 string (no data-url prefix)
  let logoMimeType     = '';
  let toastTimer;                       // declared here to avoid TDZ in showToast

  // ── File reading helpers ───────────────────────────────

  /**
   * readAsBase64 — reads a File and resolves with a RAW base64 string.
   * This sidesteps all ArrayBuffer / SES-lockdown issues because we give
   * pdf-lib a plain string primitive instead of a typed-array.
   */
  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // reader.result = "data:<mime>;base64,XXXXXX"
        const b64 = reader.result.split(',')[1];
        resolve(b64);
      };
      reader.onerror = () => reject(new Error('Cannot read ' + file.name));
      reader.readAsDataURL(file);
    });
  }

  /**
   * readAsUint8Array — reads a File into a Uint8Array via FileReader.
   * Used only for pdf.js page-count (pdf.js has its own worker; no SES clash).
   */
  function readAsUint8Array(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(new Error('Cannot read ' + file.name));
      reader.readAsArrayBuffer(file);
    });
  }

  // ── DOM Refs ───────────────────────────────────────────
  const dropZone     = document.getElementById('drop-zone');
  const pdfInput     = document.getElementById('pdf-input');
  const fileInfo     = document.getElementById('file-info');
  const fileName     = document.getElementById('file-name');
  const fileMeta     = document.getElementById('file-meta');
  const removeBtn    = document.getElementById('remove-file');
  const applyBtn     = document.getElementById('apply-btn');
  const downloadBtn  = document.getElementById('download-btn');
  const progressWrap = document.getElementById('progress-wrap');
  const progressBar  = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');
  const previewPlaceholder = document.getElementById('preview-placeholder');
  const canvasPages  = document.getElementById('canvas-pages');
  const positionGrid = document.getElementById('position-grid');

  // Text watermark
  const wmText     = document.getElementById('wm-text');
  const wmColor    = document.getElementById('wm-color');
  const colorHex   = document.getElementById('color-hex');
  const wmOpacity  = document.getElementById('wm-opacity');
  const opacityVal = document.getElementById('opacity-val');
  const wmSize     = document.getElementById('wm-size');
  const sizeVal    = document.getElementById('size-val');
  const wmRotation = document.getElementById('wm-rotation');
  const rotationVal= document.getElementById('rotation-val');
  const wmRepeat   = document.getElementById('wm-repeat');

  // Logo
  const logoEnabled      = document.getElementById('logo-enabled');
  const logoInput        = document.getElementById('logo-input');
  const logoDropZone     = document.getElementById('logo-drop-zone');
  const logoDropInner    = document.getElementById('logo-drop-inner');
  const logoPreviewWrap  = document.getElementById('logo-preview-wrap');
  const logoPreviewImg   = document.getElementById('logo-preview-img');
  const logoPreviewName  = document.getElementById('logo-preview-name');
  const logoRemoveBtn    = document.getElementById('logo-remove');
  const logoWidthRange   = document.getElementById('logo-width');
  const logoWidthVal     = document.getElementById('logo-width-val');
  const logoOpacityRange = document.getElementById('logo-opacity');
  const logoOpacityVal   = document.getElementById('logo-opacity-val');
  const logoBody         = document.getElementById('logo-body');
  const logoChevron      = document.getElementById('logo-chevron');

  // Date
  const dateEnabled      = document.getElementById('date-enabled');
  const dateModeToday    = document.getElementById('date-mode-today');
  const dateModeCustom   = document.getElementById('date-mode-custom');
  const customDateGroup  = document.getElementById('custom-date-group');
  const wmCustomDate     = document.getElementById('wm-custom-date');
  const dateFormatSel    = document.getElementById('date-format');
  const dateColorInput   = document.getElementById('date-color');
  const dateColorHex     = document.getElementById('date-color-hex');
  const dateSizeRange    = document.getElementById('date-size');
  const dateSizeVal      = document.getElementById('date-size-val');
  const dateOpacityRange = document.getElementById('date-opacity');
  const dateOpacityVal   = document.getElementById('date-opacity-val');
  const datePreviewText  = document.getElementById('date-preview-text');
  const dateBody         = document.getElementById('date-body');
  const dateChevron      = document.getElementById('date-chevron');

  // ── PDF Drop Zone ──────────────────────────────────────
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  dropZone.addEventListener('click', () => pdfInput.click());
  pdfInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  removeBtn.addEventListener('click', resetFile);

  // ── Range / Color live update ──────────────────────────
  wmOpacity.addEventListener('input',  () => { opacityVal.textContent  = wmOpacity.value; });
  wmSize.addEventListener('input',     () => { sizeVal.textContent     = wmSize.value; });
  wmRotation.addEventListener('input', () => { rotationVal.textContent = wmRotation.value; });
  wmColor.addEventListener('input',    () => { colorHex.textContent    = wmColor.value; });
  if (logoWidthRange)   logoWidthRange.addEventListener('input',   () => { logoWidthVal.textContent   = logoWidthRange.value; });
  if (logoOpacityRange) logoOpacityRange.addEventListener('input', () => { logoOpacityVal.textContent = logoOpacityRange.value; });
  dateSizeRange.addEventListener('input',     () => { dateSizeVal.textContent    = dateSizeRange.value;  updateDatePreview(); });
  dateOpacityRange.addEventListener('input',  () => { dateOpacityVal.textContent = dateOpacityRange.value; });
  dateColorInput.addEventListener('input',    () => { dateColorHex.textContent   = dateColorInput.value; });
  dateFormatSel.addEventListener('change',    updateDatePreview);
  dateModeToday.addEventListener('change',    () => { customDateGroup.classList.add('hidden');    updateDatePreview(); });
  dateModeCustom.addEventListener('change',   () => { customDateGroup.classList.remove('hidden'); updateDatePreview(); });
  wmCustomDate.addEventListener('change',     updateDatePreview);

  wmCustomDate.value = new Date().toISOString().split('T')[0];
  updateDatePreview();

  // ── Position Grid ──────────────────────────────────────
  wirePositionGrid(positionGrid, pos => { selectedPosition = pos; });

  // ── Logo Panel (only wire if elements exist in HTML) ───
  const logoToggleEl = document.getElementById('logo-toggle');
  if (logoToggleEl && logoEnabled && logoBody && logoChevron) {
    logoToggleEl.addEventListener('click', e => {
      if (e.target === logoEnabled || e.target.closest('label.toggle') === logoEnabled.parentElement) return;
      const open = !logoBody.classList.contains('hidden');
      logoBody.classList.toggle('hidden', open);
      logoChevron.classList.toggle('open', !open);
    });
    logoEnabled.addEventListener('change', () => {
      if (logoEnabled.checked) { logoBody.classList.remove('hidden'); logoChevron.classList.add('open'); }
    });
  }
  if (logoInput)    logoInput.addEventListener('change',    e => { if (e.target.files[0]) handleLogoFile(e.target.files[0]); });
  if (logoDropZone) {
    logoDropZone.addEventListener('click',    () => { if (!logoFile && logoInput) logoInput.click(); });
    logoDropZone.addEventListener('dragover', e  => { e.preventDefault(); logoDropZone.style.borderColor = 'var(--primary)'; });
    logoDropZone.addEventListener('dragleave',()  => { logoDropZone.style.borderColor = ''; });
    logoDropZone.addEventListener('drop',     e  => {
      e.preventDefault(); logoDropZone.style.borderColor = '';
      if (e.dataTransfer.files[0]) handleLogoFile(e.dataTransfer.files[0]);
    });
  }
  if (logoRemoveBtn) logoRemoveBtn.addEventListener('click', e => { e.stopPropagation(); resetLogo(); });

  // ── Date Panel ─────────────────────────────────────────
  document.getElementById('date-toggle').addEventListener('click', e => {
    if (e.target === dateEnabled || e.target.closest('label.toggle') === dateEnabled.parentElement) return;
    const open = !dateBody.classList.contains('hidden');
    dateBody.classList.toggle('hidden', open);
    dateChevron.classList.toggle('open', !open);
  });
  dateEnabled.addEventListener('change', () => {
    if (dateEnabled.checked) { dateBody.classList.remove('hidden'); dateChevron.classList.add('open'); }
  });

  // ── Action Buttons ─────────────────────────────────────
  applyBtn.addEventListener('click',   applyWatermark);
  downloadBtn.addEventListener('click', downloadPDF);

  // ── Handle PDF upload ──────────────────────────────────
  async function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      showToast('⚠️ Please upload a valid PDF file.'); return;
    }
    pdfFile = file;
    
    let trueSize = file.size || 0;
    try {
      // Bypass SES ArrayBuffer lock by using Base64
      const b64 = await readAsBase64(file);
      
      // Calculate real file size since SES hides file.size getter
      const padding = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
      trueSize = Math.floor((b64.length * 3) / 4) - padding;

      // Decode Base64 to Uint8Array for pdf.js wrapper
      const binaryString = atob(b64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
      pdfPageCount = doc.numPages;
    } catch (err) { 
      console.error('pdf.js parse error:', err);
      pdfPageCount = 0; 
    }

    dropZone.classList.add('hidden');
    fileInfo.classList.remove('hidden');
    fileName.textContent = file.name;
    fileMeta.textContent = `${pdfPageCount || '?'} page${pdfPageCount !== 1 ? 's' : ''} · ${formatBytes(trueSize)}`;
    applyBtn.disabled    = false;
    downloadBtn.disabled = true;
    watermarkedBytes     = null;
    clearPreview();
    showToast('✅ PDF loaded successfully!');
  }

  function resetFile() {
    pdfFile = null; pdfPageCount = 0;
    watermarkedBytes = null; watermarkedUrl = null; pdfInput.value = '';
    dropZone.classList.remove('hidden');
    fileInfo.classList.add('hidden');
    applyBtn.disabled = true; downloadBtn.disabled = true;
    clearPreview();
  }

  // ── Handle Logo upload ─────────────────────────────────
  async function handleLogoFile(file) {
    if (!['image/png','image/jpeg','image/jpg'].includes(file.type)) {
      showToast('⚠️ Please upload a PNG or JPG image.'); return;
    }
    logoFile    = file;
    logoMimeType = file.type;
    // Store as base64 — pdf-lib's embedPng/embedJpg accepts base64 strings
    logoBase64  = await readAsBase64(file);
    logoPreviewImg.src      = URL.createObjectURL(file);
    logoPreviewName.textContent = file.name;
    logoDropInner.classList.add('hidden');
    logoPreviewWrap.classList.remove('hidden');
    showToast('🖼️ Logo uploaded!');
  }

  function resetLogo() {
    logoFile = null; logoBase64 = null; logoMimeType = '';
    logoInput.value = ''; logoPreviewImg.src = '';
    logoPreviewWrap.classList.add('hidden');
    logoDropInner.classList.remove('hidden');
  }

  // ── Date helpers ───────────────────────────────────────
  function buildDateString() {
    const d = (dateModeCustom.checked && wmCustomDate.value)
      ? new Date(wmCustomDate.value + 'T00:00:00')
      : new Date();
    return formatDate(d, dateFormatSel.value);
  }

  function formatDate(d, fmt) {
    const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const p = n => String(n).padStart(2, '0');
    return fmt
      .replace('DD',   p(d.getDate()))
      .replace('MM',   p(d.getMonth() + 1))
      .replace('YYYY', d.getFullYear())
      .replace('MMM',  M[d.getMonth()])
      .replace('HH',   p(d.getHours()))
      .replace('mm',   p(d.getMinutes()));
  }

  function updateDatePreview() { datePreviewText.textContent = buildDateString(); }

  // ── APPLY WATERMARK ────────────────────────────────────
  async function applyWatermark() {
    if (!pdfFile) return;

    const text     = wmText.value.trim() || 'WATERMARK';
    const opacity  = parseInt(wmOpacity.value)  / 100;
    const fontSize = parseInt(wmSize.value);
    const rotation = parseInt(wmRotation.value);
    const repeat   = wmRepeat ? wmRepeat.checked : false;
    const useLogo  = logoEnabled ? (logoEnabled.checked && logoBase64) : false;
    const useDate  = dateEnabled ? dateEnabled.checked : false;

    applyBtn.disabled = true; downloadBtn.disabled = true;
    progressWrap.classList.remove('hidden');
    clearPreview();

    try {
      // ── Read PDF as raw base64 string ──────────────────
      // pdf-lib accepts base64 strings natively and decodes them internally.
      // This bypasses all SES/ArrayBuffer realm issues completely.
      const pdfBase64 = await readAsBase64(pdfFile);

      const { PDFDocument, rgb, degrees } = PDFLib;
      const pdfDoc = await PDFDocument.load(pdfBase64, { ignoreEncryption: true });
      const pages  = pdfDoc.getPages();
      const total  = pages.length;

      // Embed shared font
      const font = await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBold);

      // Text color
      const [tr, tg, tb] = hexToRgb01(wmColor.value);

      // Embed logo (pass base64 string — pdf-lib embedPng/embedJpg accept it)
      let embeddedLogo = null, logoDims = null;
      if (useLogo) {
        try {
          embeddedLogo = logoMimeType === 'image/png'
            ? await pdfDoc.embedPng(logoBase64)
            : await pdfDoc.embedJpg(logoBase64);
          logoDims = embeddedLogo.scale(1);
        } catch (e) {
          showToast('⚠️ Logo embed failed: ' + e.message);
          embeddedLogo = null;
        }
      }

      // Date settings
      const dateStr    = useDate ? buildDateString() : '';
      const dateFontSz = dateSizeRange    ? parseInt(dateSizeRange.value)    : 14;
      const dateOpac   = dateOpacityRange ? parseInt(dateOpacityRange.value) / 100 : 0.8;
      const [dr, dg, db] = dateColorInput ? hexToRgb01(dateColorInput.value) : [0.2, 0.2, 0.2];

      // Logo settings
      const targetLogoW = logoWidthRange   ? parseInt(logoWidthRange.value)   : 100;
      const logoOpac    = logoOpacityRange ? parseInt(logoOpacityRange.value) / 100 : 0.8;

      for (let i = 0; i < total; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();

        if (repeat) {
          const textW  = font.widthOfTextAtSize(text, fontSize);
          const groupW = Math.max(textW, targetLogoW);
          const groupH = calcGroupHeight(embeddedLogo, logoDims, targetLogoW, fontSize, 8);
          const stepX  = groupW + 60;
          const stepY  = groupH + 60;

          for (let y = 0; y < height + stepY; y += stepY) {
            for (let x = 0; x < width + stepX; x += stepX) {
              drawGroup(page, x, y, {
                text, font, fontSize, opacity, rotation, rgb, degrees,
                textColor: [tr, tg, tb],
                embeddedLogo, logoDims, targetLogoW, logoOpac,
              });
            }
          }
        } else {
          const groupH = calcGroupHeight(embeddedLogo, logoDims, targetLogoW, fontSize, 8);
          const textW  = font.widthOfTextAtSize(text, fontSize);
          const groupW = Math.max(
            textW,
            useLogo && logoDims ? targetLogoW : 0
          );
          const [anchorX, anchorY] = calcGroupAnchor(selectedPosition, width, height, groupW, groupH);
          drawGroup(page, anchorX, anchorY, {
            text, font, fontSize, opacity, rotation, rgb, degrees,
            textColor: [tr, tg, tb],
            embeddedLogo, logoDims, targetLogoW, logoOpac,
          });
        }

        // ── Date: always pinned to bottom-right corner, independent of watermark position ──
        if (useDate && dateStr) {
          const dateMargin = 20;
          const dateW = font.widthOfTextAtSize(dateStr, dateFontSz);
          page.drawText(dateStr, {
            x: width  - dateMargin - dateW,
            y: dateMargin,
            size: dateFontSz, font,
            color: rgb(dr, dg, db),
            opacity: dateOpac,
          });
        }

        progressBar.style.width = Math.round(((i + 1) / total) * 100) + '%';
        progressText.textContent = `${i + 1} / ${total}`;
        await tick();
      }

      watermarkedBytes = await pdfDoc.save();
      watermarkedUrl   = await pdfDoc.saveAsBase64({ dataUri: true });
      progressWrap.classList.add('hidden');
      progressBar.style.width = '0%';
      downloadBtn.disabled = false; applyBtn.disabled = false;

      const parts = ['text'];
      if (embeddedLogo) parts.push('logo');
      if (useDate)      parts.push('date');
      showToast(`🎉 Stamp (${parts.join(' + ')}) applied to all ${total} pages!`);

      await renderPreview(watermarkedBytes);

    } catch (err) {
      console.error('applyWatermark error:', err);
      progressWrap.classList.add('hidden');
      applyBtn.disabled = false;
      showToast('❌ Error: ' + err.message);
    }
  }

  // ── drawGroup — renders logo + text (date is drawn independently) ──
  function drawGroup(page, anchorX, anchorY, opts) {
    const {
      text, font, fontSize, opacity, rotation, rgb, degrees,
      textColor,
      embeddedLogo, logoDims, targetLogoW, logoOpac,
    } = opts;

    const GAP = 6;
    const textW  = font.widthOfTextAtSize(text, fontSize);
    const logoW  = embeddedLogo && logoDims ? targetLogoW : 0;
    const groupW = Math.max(textW, logoW);

    let currentY = anchorY;

    // 1. Text watermark — rotation-corrected centering
    // pdf-lib rotates drawText around its origin (bottom-left corner).
    // To keep the visual centre of the rotated text at the intended anchor
    // centre, we back-calculate the true origin using trigonometry:
    //   origin_x = cx - (w/2)·cosθ + (h/2)·sinθ
    //   origin_y = cy - (w/2)·sinθ - (h/2)·cosθ
    const θ      = rotation * Math.PI / 180;
    const cosθ   = Math.cos(θ);
    const sinθ   = Math.sin(θ);
    const halfW  = textW / 2;
    const halfH  = fontSize / 2;
    // Visual centre we want the text to land on
    const cx = anchorX + groupW / 2;
    const cy = currentY + halfH;
    const tx = cx - halfW * cosθ + halfH * sinθ;
    const ty = cy - halfW * sinθ - halfH * cosθ;

    page.drawText(text, {
      x: tx, y: ty,
      size: fontSize, font,
      color: rgb(textColor[0], textColor[1], textColor[2]),
      opacity,
      rotate: degrees(rotation),
    });
    currentY += fontSize + GAP;

    // 2. Logo above text
    if (embeddedLogo && logoDims) {
      const scale = targetLogoW / logoDims.width;
      const lw    = logoDims.width  * scale;
      const lh    = logoDims.height * scale;
      const lx    = anchorX + (groupW - lw) / 2;
      page.drawImage(embeddedLogo, {
        x: lx, y: currentY,
        width: lw, height: lh,
        opacity: logoOpac,
      });
    }
  }

  function calcGroupHeight(embeddedLogo, logoDims, targetLogoW, fontSize, gap) {
    let h = fontSize;
    if (embeddedLogo && logoDims) {
      h += (logoDims.height * (targetLogoW / logoDims.width)) + gap;
    }
    return h;
  }

  function calcGroupAnchor(pos, pageW, pageH, groupW, groupH) {
    const m = 30; // margin
    const left   = m;
    const center = pageW / 2 - groupW / 2;
    const right  = pageW - m - groupW;
    const top    = pageH - m - groupH;
    const middle = pageH / 2 - groupH / 2;
    const bottom = m;
    const map = {
      'top-left':      [left,   top],
      'top-center':    [center, top],
      'top-right':     [right,  top],
      'middle-left':   [left,   middle],
      'center':        [center, middle],
      'middle-right':  [right,  middle],
      'bottom-left':   [left,   bottom],
      'bottom-center': [center, bottom],
      'bottom-right':  [right,  bottom],
    };
    return map[pos] || map['center'];
  }

  // ── PDF.js Preview ─────────────────────────────────────
  async function renderPreview(bytes) {
    previewPlaceholder.classList.add('hidden');
    canvasPages.innerHTML = '';
    // Pass a copy so pdf.js worker transfer doesn't affect our bytes reference
    const pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    const count  = Math.min(pdfDoc.numPages, 10);
    for (let p = 1; p <= count; p++) {
      const page     = await pdfDoc.getPage(p);
      const viewport = page.getViewport({ scale: 1.2 });
      const wrapper  = document.createElement('div');
      wrapper.className = 'page-wrapper';
      const label = document.createElement('div');
      label.className = 'page-label';
      label.textContent = `Page ${p}` + (pdfDoc.numPages > 10 && p === count ? ` (first ${count} of ${pdfDoc.numPages})` : '');
      const canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      wrapper.appendChild(label);
      wrapper.appendChild(canvas);
      canvasPages.appendChild(wrapper);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
  }

  // ── Download ───────────────────────────────────────────
  function downloadPDF() {
    if (!watermarkedUrl) return;
    const a    = document.createElement('a');
    a.href     = watermarkedUrl;
    a.download = `${(pdfFile?.name || 'document').replace(/\.pdf$/i, '')}_watermarked.pdf`;
    a.click();
    showToast('⬇️ Downloading your watermarked PDF…');
  }

  // ── Helpers ────────────────────────────────────────────
  function wirePositionGrid(grid, onSelect) {
    grid.querySelectorAll('.pos-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onSelect(btn.dataset.pos);
      });
    });
  }

  function clearPreview() {
    canvasPages.innerHTML = '';
    previewPlaceholder.classList.remove('hidden');
  }

  function hexToRgb01(hex) {
    return [
      parseInt(hex.slice(1, 3), 16) / 255,
      parseInt(hex.slice(3, 5), 16) / 255,
      parseInt(hex.slice(5, 7), 16) / 255,
    ];
  }

  function formatBytes(b) {
    if (b < 1024)    return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function tick() { return new Promise(r => setTimeout(r, 0)); }

  function showToast(msg) {
    const t = document.getElementById('toast');
    document.getElementById('toast-msg').textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3800);
  }

})();
