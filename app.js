const BASE_API_URL = "https://mrz.scicom.my"; // remove this after deploying
const state = {
  upload: null,
  documentId: null,
  localFile: null,
  previewImage: null,
  rotation: 0,
  microRotation: 0,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  dragStart: null,
  dragCurrent: null,
  canvasScale: 1,
  canvasBounds: { x: 0, y: 0, width: 0, height: 0 },
  isBusy: false,
  guidance: { faceRects: null, mrzRect: null },
};

const els = {
  uploadForm: document.querySelector("#upload-form"),
  fileInput: document.querySelector("#file-input"),
  uploadButton: document.querySelector("#upload-button"),
  rotateLeft: document.querySelector("#rotate-left"),
  rotateRight: document.querySelector("#rotate-right"),
  resetAdjust: document.querySelector("#reset-adjust"),
  extractButton: document.querySelector("#extract-button"),
  useFaceHint: document.querySelector("#use-face-hint"),
  microRotate: document.querySelector("#micro-rotate"),
  zoomOut: document.querySelector("#zoom-out"),
  zoomIn: document.querySelector("#zoom-in"),
  zoomRange: document.querySelector("#zoom-range"),
  offsetXRange: document.querySelector("#offset-x-range"),
  offsetYRange: document.querySelector("#offset-y-range"),
  canvas: document.querySelector("#preview-canvas"),
  exportCanvas: document.querySelector("#export-canvas"),
  viewerFrame: document.querySelector("#viewer-frame"),
  docName: document.querySelector("#doc-name"),
  docMeta: document.querySelector("#doc-meta"),
  docIdChip: document.querySelector("#doc-id-chip"),
  rotationChip: document.querySelector("#rotation-chip"),
  cropAnalysisOutput: document.querySelector("#crop-analysis-output"),
  requestJson: document.querySelector("#request-json"),
  uploadJson: document.querySelector("#upload-json"),
  resultJson: document.querySelector("#result-json"),
  analysisOutput: document.querySelector("#analysis-output"),
  microRotateVal: document.querySelector("#micro-rotate-val"),
  zoomVal: document.querySelector("#zoom-val"),
  offsetXVal: document.querySelector("#offset-x-val"),
  offsetYVal: document.querySelector("#offset-y-val"),
  statusText: document.querySelector("#status-text"),
  spinnerOverlay: document.querySelector("#spinner-overlay"),
  toastContainer: document.querySelector("#toast-container"),
  fileDrop: document.querySelector(".file-drop"),
  fileDropLabel: document.querySelector(".file-drop-label"),
  extractButtonInline: document.querySelector("#extract-button-inline"),
};

let opencvReady = false;

const ctx = els.canvas.getContext("2d");
const WORKING_FRAME_MARGIN_X = 0.04;
const WORKING_FRAME_MARGIN_Y = 0.04;
const TRANSFORM_PAD_RATIO = 0.14;
const OFFSET_LIMIT = 0.2;
const OFFSET_Y_LIMIT = 0.6;
const ZOOM_MIN = 1.0;
const ZOOM_MAX = 2.2;
const DRAG_SENSITIVITY = 0.35;
const MRZ_FOCUS_HEIGHT = 0.140625;
const BG_FILL = "#f6f0e5";

const guidanceCanvas = document.createElement("canvas");
let renderNeeded = true;
let guidanceTimer = null;
const GUIDANCE_INTERVAL = 500;

function showToast(message, type) {
  if (!els.toastContainer) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type === "success" ? "success" : "error"}`;
  const icon = type === "success" ? "\u2713" : "\u2717";
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${escapeHtml(message)}</span>`;
  els.toastContainer.appendChild(toast);
  const dismiss = () => {
    toast.classList.add("toast-dismissing");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  };
  setTimeout(dismiss, 4000);
}

function setStatus(message, isError = false) {
  els.statusText.textContent = message;
  els.statusText.classList.toggle("status-error", isError);
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getPreviewUrl(documentId) {
  return `${BASE_API_URL}/api/documents/${documentId}/preview`;
}

function getRotatedImageSize() {
  if (!state.previewImage) {
    return { width: 0, height: 0 };
  }
  const swapAxes = state.rotation === 90 || state.rotation === 270;
  return swapAxes
    ? { width: state.previewImage.height, height: state.previewImage.width }
    : { width: state.previewImage.width, height: state.previewImage.height };
}

function getPaddedPreviewSource() {
  if (!state.previewImage) {
    return null;
  }
  const image = state.previewImage;
  const padX = Math.round(image.width * TRANSFORM_PAD_RATIO);
  const padY = Math.round(image.height * TRANSFORM_PAD_RATIO);
  const canvas = document.createElement("canvas");
  canvas.width = image.width + (padX * 2);
  canvas.height = image.height + (padY * 2);
  const offscreen = canvas.getContext("2d");
  offscreen.imageSmoothingEnabled = true;
  offscreen.imageSmoothingQuality = "high";
  offscreen.drawImage(image, padX, padY);
  return canvas;
}

function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(",");
  const mime = meta.match(/data:(.*?);base64/)?.[1] || "image/jpeg";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

function buildExtractionPayload() {
  return {
    document_id: state.documentId,
    input_mode: "frontend",
    enable_correction: false,
    use_face_hint: false,
  };
}

function updatePayloadView() {
  els.requestJson.textContent = formatJson(buildExtractionPayload());
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function getReportFilename(reportPath) {
  if (!reportPath) {
    return "";
  }
  const normalized = String(reportPath).replaceAll("\\", "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function formatDateYYMMDD(value) {
  if (!value || !/^\d{6}$/.test(value)) {
    return null;
  }
  return `${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
}

function buildAnalysis(result) {
  if (!result) {
    return [
      {
        title: "No extraction",
        items: ["Run extraction to see a structured summary."],
        tone: "",
      },
    ];
  }

  const parsed = result.parsed || {};
  const line1 = result.line1 || "";
  const line2 = result.line2 || "";
  const cards = [];
  const mrzItems = [];
  const structuralItems = [];
  const identityItems = [];
  const documentItems = [];
  const warningItems = [];

  mrzItems.push(line1 || "-");
  mrzItems.push(line2 || "-");

  structuralItems.push(`Status: ${result.status || "unknown"}`);
  structuralItems.push(`Line 1 length: ${line1.length}/44`);
  structuralItems.push(`Line 2 length: ${line2.length}/44`);
  if (typeof result.duration_ms === "number") {
    structuralItems.push(`Duration: ${result.duration_ms.toFixed(2)} ms`);
  }
  if (result.report_path) {
    structuralItems.push({
      type: "link",
      label: "Report",
      href: `/api/extractions/${encodeURIComponent(result.extraction_id)}/report`,
      text: "Open JSON report",
    });
  }

  if (parsed.surname || parsed.given_names) {
    identityItems.push(`Surname: ${parsed.surname || "-"}`);
    identityItems.push(`Given names: ${parsed.given_names || "-"}`);
  }
  if (parsed.sex) {
    identityItems.push(`Sex: ${parsed.sex}`);
  }

  if (parsed.document_number) {
    documentItems.push(`Document number: ${parsed.document_number}`);
  }
  if (parsed.nationality) {
    documentItems.push(`Nationality: ${parsed.nationality}`);
  }
  if (parsed.birth_date_yymmdd) {
    documentItems.push(
      `Birth date: ${parsed.birth_date_yymmdd}${formatDateYYMMDD(parsed.birth_date_yymmdd) ? ` (${formatDateYYMMDD(parsed.birth_date_yymmdd)})` : ""}`
    );
  }
  if (parsed.expiry_date_yymmdd) {
    documentItems.push(
      `Expiry date: ${parsed.expiry_date_yymmdd}${formatDateYYMMDD(parsed.expiry_date_yymmdd) ? ` (${formatDateYYMMDD(parsed.expiry_date_yymmdd)})` : ""}`
    );
  }
  if (parsed.personal_number) {
    documentItems.push(`Personal number: ${parsed.personal_number}`);
  }

  if (line1.length !== 44) {
    warningItems.push("Line 1 is not 44 characters, so TD3 structure is incomplete.");
  }
  if (line2.length !== 44) {
    warningItems.push("Line 2 is not 44 characters, so checksum-backed fields may be unreliable.");
  }
  if (!parsed.document_number) {
    warningItems.push("Document number was not parsed from line 2.");
  }
  if (!parsed.nationality) {
    warningItems.push("Nationality was not parsed from line 2.");
  }
  if (!parsed.surname && !parsed.given_names) {
    warningItems.push("Name fields were not parsed from line 1.");
  }

  cards.push({
    title: "MRZ Output",
    items: mrzItems,
    tone: "",
  });

  if (identityItems.length > 0) {
    cards.push({
      title: "Identity Fields",
      items: identityItems,
      tone: "",
    });
  }

  if (documentItems.length > 0) {
    cards.push({
      title: "Document Fields",
      items: documentItems,
      tone: "",
    });
  }

  cards.push({
    title: "Structural Summary",
    items: structuralItems,
    tone: warningItems.length === 0 ? "analysis-good" : "",
  });

  cards.push({
    title: "Quality Notes",
    items: warningItems.length > 0 ? warningItems : ["Line lengths and parsed fields look structurally plausible for TD3 output."],
    tone: warningItems.length > 0 ? "analysis-warn" : "analysis-good",
  });

  return cards;
}

function renderAnalysis(result) {
  const cards = buildAnalysis(result);
  els.analysisOutput.innerHTML = cards
    .map((card) => {
      const items = card.items
        .map((item) => {
          if (typeof item === "string") {
            const itemClass = card.title === "MRZ Output" ? "mrz-line" : "";
            return `<li class="${itemClass}">${escapeHtml(item)}</li>`;
          }
          if (item && item.type === "link") {
            return `<li>${escapeHtml(item.label)}: <a class="analysis-link" href="${escapeHtml(item.href)}" target="_blank" rel="noreferrer">${escapeHtml(item.text)}</a></li>`;
          }
          return "";
        })
        .join("");
      const listClass = card.title === "MRZ Output" ? "mrz-list" : "";
      return `
        <section class="analysis-card">
          <h3 class="${card.tone || ""}">${escapeHtml(card.title)}</h3>
          <ul class="${listClass}">${items}</ul>
        </section>
      `;
    })
    .join("");
}

function buildCropAnalysis() {
  if (!state.previewImage) {
    return [
      {
        title: "No document",
        items: ["Load a document before checking alignment."],
        tone: "",
      },
    ];
  }
  const warnings = [];

  if (Math.abs(state.microRotation) > 3.0) {
    warnings.push("Micro rotation is fairly large. Recheck that the page is truly skewed before keeping it.");
  }
  if (state.zoom > 1.6) {
    warnings.push("Zoom is high. Make sure important document edges are not pushed out of frame.");
  }
  if (Math.abs(state.offsetX) > 0.12) {
    warnings.push("Horizontal shift is large. Verify the passport page is still centered enough for extraction.");
  }
  if (Math.abs(state.offsetY) > 0.35) {
    warnings.push("Vertical shift is large. Verify the passport page is still fully visible.");
  }

  const cards = [
    {
      title: "Adjustment Geometry",
      items: [
        `Rotation: ${state.rotation} degrees`,
        `Micro rotation: ${state.microRotation.toFixed(1)} degrees`,
        `Zoom: ${state.zoom.toFixed(2)}x`,
        `Offset: x=${state.offsetX.toFixed(3)}, y=${state.offsetY.toFixed(3)}`,
      ],
      tone: warnings.length === 0 ? "analysis-good" : "",
    },
    {
      title: "Quick Notes",
      items: warnings.length > 0
        ? warnings
        : ["Current alignment looks broadly reasonable for a first extraction pass."],
      tone: warnings.length > 0 ? "analysis-warn" : "analysis-good",
    },
  ];

  return cards;
}

function renderCropAnalysis() {
  const cards = buildCropAnalysis();
  els.cropAnalysisOutput.innerHTML = cards
    .map((card) => {
      const items = card.items
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("");
      return `
        <section class="analysis-card">
          <h3 class="${card.tone || ""}">${escapeHtml(card.title)}</h3>
          <ul>${items}</ul>
        </section>
      `;
    })
    .join("");
}

function updateControls() {
  const hasImage = Boolean(state.previewImage);
  els.rotateLeft.disabled = !hasImage || state.isBusy;
  els.rotateRight.disabled = !hasImage || state.isBusy;
  els.resetAdjust.disabled = !hasImage || state.isBusy;
  els.extractButton.disabled = !hasImage || state.isBusy;
  els.extractButtonInline.disabled = !hasImage || state.isBusy;
  const hasFile = els.fileInput.files && els.fileInput.files.length > 0;
  els.uploadButton.disabled = !hasFile || state.isBusy;
  els.fileInput.disabled = state.isBusy;
  els.microRotate.disabled = !hasImage || state.isBusy;
  els.zoomOut.disabled = !hasImage || state.isBusy;
  els.zoomIn.disabled = !hasImage || state.isBusy;
  els.zoomRange.disabled = !hasImage || state.isBusy;
  els.offsetXRange.disabled = !hasImage || state.isBusy;
  els.offsetYRange.disabled = !hasImage || state.isBusy;
  els.rotationChip.textContent = `rotation: ${state.rotation}`;
  els.docIdChip.textContent = `document: ${state.documentId || "-"}`;
  els.microRotate.value = String(state.microRotation);
  els.zoomRange.value = String(state.zoom);
  els.offsetXRange.value = String(state.offsetX);
  els.offsetYRange.value = String(state.offsetY);
  els.microRotateVal.textContent = `${state.microRotation >= 0 ? "+" : ""}${state.microRotation.toFixed(1)}°`;
  els.zoomVal.textContent = `${state.zoom.toFixed(2)}×`;
  els.offsetXVal.textContent = `${state.offsetX >= 0 ? "+" : ""}${state.offsetX.toFixed(3)}`;
  els.offsetYVal.textContent = `${state.offsetY >= 0 ? "+" : ""}${state.offsetY.toFixed(3)}`;
  updatePayloadView();
  if (els.spinnerOverlay) {
    els.spinnerOverlay.hidden = !state.isBusy;
  }
}

function updateDocumentSummary() {
  if (!state.previewImage && !state.localFile) {
    els.docName.textContent = "No document";
    els.docMeta.textContent = "Load a file to begin.";
    return;
  }

  if (state.upload) {
    els.docName.textContent = state.upload.filename;
    els.docMeta.textContent =
      `${state.upload.source_type} | ${state.upload.preview_width}x${state.upload.preview_height} | deduplicated=${state.upload.deduplicated}`;
  } else if (state.localFile) {
    els.docName.textContent = state.localFile.name;
    const img = state.previewImage;
    els.docMeta.textContent = img
      ? `local | ${img.naturalWidth}x${img.naturalHeight} | not uploaded yet`
      : "Loading...";
  }
}

function resetAdjustments() {
  state.microRotation = 0;
  state.zoom = 1;
  state.offsetX = 0;
  state.offsetY = 0;
  state.dragStart = null;
  state.dragCurrent = null;
}

function handleResetAdjust() {
  state.rotation = 0;
  resetAdjustments();
  renderCanvas();
  renderCropAnalysis();
  updateControls();
  setStatus("Adjustments reset.");
}

function drawEmptyCanvas() {
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.fillStyle = "#f6f0e5";
  ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.fillStyle = "#67757c";
  ctx.font = "600 18px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText("Load a document to preview it here.", els.canvas.width / 2, els.canvas.height / 2);
}

function drawCropRect(rectPx) {
  ctx.save();
  ctx.fillStyle = "rgba(13, 107, 95, 0.16)";
  ctx.strokeStyle = "#0d6b5f";
  ctx.lineWidth = 2;
  ctx.fillRect(rectPx.x, rectPx.y, rectPx.width, rectPx.height);
  ctx.strokeRect(rectPx.x, rectPx.y, rectPx.width, rectPx.height);
  ctx.restore();
}

function drawWorkingFrameOverlay(targetWidth, targetHeight) {
  const bottomPad = targetHeight * 0.04;
  const zoneX = targetWidth * 0.01;
  const zoneY = targetHeight * (1 - MRZ_FOCUS_HEIGHT) - bottomPad;
  const zoneW = targetWidth * 0.98;
  const zoneH = targetHeight * MRZ_FOCUS_HEIGHT;

ctx.save();
ctx.setLineDash([8, 6]);
ctx.strokeStyle = "rgba(13, 107, 95, 0.35)";
ctx.lineWidth = 2;
ctx.fillStyle = "rgba(13, 107, 95, 0.05)";
ctx.fillRect(zoneX, zoneY, zoneW, zoneH);
ctx.strokeRect(zoneX, zoneY, zoneW, zoneH);
ctx.setLineDash([]);

const label = "Align MRZ lines inside this box";
ctx.font = '600 13px "Segoe UI", sans-serif';
const textWidth = ctx.measureText(label).width;
const textX = targetWidth / 2;
const textY = zoneY - 15;
const padX = 10, padH = 25;

// Draw dark pill background behind text
ctx.fillStyle = "rgba(0, 0, 0, 0.47)";
ctx.beginPath();
ctx.roundRect(textX - textWidth / 2 - padX, textY - padH + 4, textWidth + padX * 2, padH + 4, 6);
ctx.fill();

// Draw crisp white text on top
ctx.fillStyle = "rgba(216, 255, 224, 0.94)";
ctx.textAlign = "center";
ctx.textBaseline = "bottom";
ctx.fillText(label, textX, textY);

ctx.restore();
}
// ── Shared render function for all three canvases ──────────────────
// Renders current image with all transforms onto targetCanvas at the given size.
// Returns the fit scale used for letterboxing.
function renderImage(targetCanvas, targetW, targetH) {
  const tctx = targetCanvas.getContext("2d");
  targetCanvas.width = targetW;
  targetCanvas.height = targetH;

  const image = state.previewImage;
  if (!image) {
    tctx.fillStyle = BG_FILL;
    tctx.fillRect(0, 0, targetW, targetH);
    return 1;
  }

  if (opencvReady) {
    try {
      return renderImageWithOpenCv(tctx, targetW, targetH, image);
    } catch (err) {
      console.warn("[renderImage] opencv failed, falling back:", err);
    }
  }
  return renderImageFallback(tctx, targetW, targetH, image);
}

function renderImageWithOpenCv(tctx, targetW, targetH, image) {
  const cv_mod = window.cv;
  const mats = [];
  const track = (m) => { mats.push(m); return m; };
  try {
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = image.width;
    srcCanvas.height = image.height;
    srcCanvas.getContext("2d").drawImage(image, 0, 0);
    const srcMat = track(cv_mod.imread(srcCanvas));

    const rotMat = track(new cv_mod.Mat());
    if (state.rotation === 90) cv_mod.rotate(srcMat, rotMat, cv_mod.ROTATE_90_CLOCKWISE);
    else if (state.rotation === 180) cv_mod.rotate(srcMat, rotMat, cv_mod.ROTATE_180);
    else if (state.rotation === 270) cv_mod.rotate(srcMat, rotMat, cv_mod.ROTATE_90_COUNTERCLOCKWISE);
    else srcMat.copyTo(rotMat);

    const rotW = rotMat.cols;
    const rotH = rotMat.rows;
    const fitScale = Math.min(targetW / rotW, targetH / rotH);
    const fitW = Math.round(rotW * fitScale);
    const fitH = Math.round(rotH * fitScale);
    const resizedMat = track(new cv_mod.Mat());
    cv_mod.resize(rotMat, resizedMat, new cv_mod.Size(fitW, fitH), 0, 0, cv_mod.INTER_LINEAR);

    const bg = new cv_mod.Scalar(246, 240, 229, 255);
    const vpMat = track(new cv_mod.Mat(targetH, targetW, cv_mod.CV_8UC4, bg));
    const pasteX = Math.round((targetW - fitW) / 2);
    const pasteY = Math.round((targetH - fitH) / 2);
    const roi = track(vpMat.roi(new cv_mod.Rect(pasteX, pasteY, fitW, fitH)));
    resizedMat.copyTo(roi);

    const cx = targetW / 2 + state.offsetX * targetW;
    const cy = targetH / 2 + state.offsetY * targetH;
    const M = track(cv_mod.getRotationMatrix2D(new cv_mod.Point(cx, cy), state.microRotation, state.zoom));
    const outMat = track(new cv_mod.Mat());
    cv_mod.warpAffine(vpMat, outMat, M, new cv_mod.Size(targetW, targetH),
      cv_mod.INTER_LINEAR, cv_mod.BORDER_CONSTANT, bg);

    const offCanvas = document.createElement("canvas");
    cv_mod.imshow(offCanvas, outMat);
    tctx.clearRect(0, 0, targetW, targetH);
    tctx.drawImage(offCanvas, 0, 0);

    return fitScale;
  } finally {
    for (const m of mats) { try { m.delete(); } catch (_) {} }
  }
}

function renderImageFallback(tctx, targetW, targetH, image) {
  const swapAxes = state.rotation === 90 || state.rotation === 270;
  const rotW = swapAxes ? image.height : image.width;
  const rotH = swapAxes ? image.width : image.height;
  const fitScale = Math.min(targetW / rotW, targetH / rotH);

  const padX = Math.round(image.width * TRANSFORM_PAD_RATIO);
  const padY = Math.round(image.height * TRANSFORM_PAD_RATIO);
  const padCanvas = document.createElement("canvas");
  padCanvas.width = image.width + padX * 2;
  padCanvas.height = image.height + padY * 2;
  const padCtx = padCanvas.getContext("2d");
  padCtx.imageSmoothingEnabled = true;
  padCtx.imageSmoothingQuality = "high";
  padCtx.drawImage(image, padX, padY);

  tctx.clearRect(0, 0, targetW, targetH);
  tctx.fillStyle = BG_FILL;
  tctx.fillRect(0, 0, targetW, targetH);
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = "high";
  tctx.save();
  tctx.translate(targetW / 2, targetH / 2);
  tctx.scale(fitScale, fitScale);
  tctx.translate(state.offsetX * rotW, state.offsetY * rotH);
  tctx.rotate((state.microRotation * Math.PI) / 180);
  tctx.scale(state.zoom, state.zoom);
  if (state.rotation === 90) tctx.rotate(Math.PI / 2);
  else if (state.rotation === 180) tctx.rotate(Math.PI);
  else if (state.rotation === 270) tctx.rotate(-Math.PI / 2);
  tctx.drawImage(padCanvas, -padCanvas.width / 2, -padCanvas.height / 2);
  tctx.restore();

  return fitScale;
}

// ── Preview canvas (display resolution) ────────────────────────────
// Every frame: measure container, set drawing resolution, compute
// "contain" baseScale, then draw with translate → rotate → scale → drawImage.
function renderCanvas() {
  const canvasW = els.viewerFrame.clientWidth;
  const canvasH = els.viewerFrame.clientHeight;
  els.canvas.width = canvasW;
  els.canvas.height = canvasH;

  if (!state.previewImage) {
    els.viewerFrame.classList.add("empty");
    ctx.fillStyle = BG_FILL;
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.fillStyle = "#67757c";
    ctx.font = "600 18px Segoe UI";
    ctx.textAlign = "center";
    ctx.fillText("Load a document to preview it here.", canvasW / 2, canvasH / 2);
    return;
  }

  els.viewerFrame.classList.remove("empty");
  const img = state.previewImage;
  const totalAngle = (state.rotation + state.microRotation) * Math.PI / 180;

  // Rotated bounding box for "contain" letterbox fit
  const cosA = Math.abs(Math.cos(totalAngle));
  const sinA = Math.abs(Math.sin(totalAngle));
  const rotW = img.width * cosA + img.height * sinA;
  const rotH = img.width * sinA + img.height * cosA;
  const baseScale = Math.min(canvasW / rotW, canvasH / rotH);

  ctx.clearRect(0, 0, canvasW, canvasH);
  ctx.fillStyle = BG_FILL;
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.save();
  ctx.translate(canvasW / 2, canvasH / 2);
  ctx.rotate(totalAngle);
  ctx.scale(baseScale * state.zoom, baseScale * state.zoom);
  const dragX = state.offsetX * img.width;
  const dragY = state.offsetY * img.height;
  ctx.drawImage(img, -img.width / 2 + dragX, -img.height / 2 + dragY);
  ctx.restore();

  state.canvasScale = baseScale;
  state.canvasBounds = { x: 0, y: 0, width: canvasW, height: canvasH };

  // Overlays on preview canvas
  drawWorkingFrameOverlay(canvasW, canvasH);
  drawGuidanceOverlays(canvasW, canvasH);

  // Schedule throttled guidance detection
  scheduleGuidance();
}

function getCanvasPointer(event) {
  const rect = els.canvas.getBoundingClientRect();
  const x = clamp(event.clientX - rect.left, 0, rect.width);
  const y = clamp(event.clientY - rect.top, 0, rect.height);
  return {
    x: rect.width === 0 ? 0 : x / rect.width,
    y: rect.height === 0 ? 0 : y / rect.height,
  };
}

async function loadPreviewImage(documentId) {
  const image = new Image();
  image.decoding = "async";
  image.src = `${getPreviewUrl(documentId)}?t=${Date.now()}`;
  await image.decode();
  return image;
}

function loadLocalImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image."));
    };
    image.src = url;
  });
}

// ── Export canvas (full original resolution, rendered once on click) ─
function renderExportCanvas() {
  if (!state.previewImage) return;
  const image = state.previewImage;
  const swapAxes = state.rotation === 90 || state.rotation === 270;
  const rotW = swapAxes ? image.naturalHeight : image.naturalWidth;
  const rotH = swapAxes ? image.naturalWidth : image.naturalHeight;
  renderImage(els.exportCanvas, rotW, rotH);
}

async function loadFileIntoPreview(file) {
  state.isBusy = true;
  updateControls();
  setStatus(`Loading ${file.name} locally...`);

  try {
    const image = await loadLocalImage(file);
    state.localFile = file;
    state.previewImage = image;
    state.upload = null;
    state.documentId = null;
    state.rotation = 0;
    state.microRotation = 0;
    state.zoom = 1;
    state.offsetX = 0;
    state.offsetY = 0;
    state.dragStart = null;
    state.dragCurrent = null;

    els.uploadJson.textContent = "Not uploaded yet. Click Run Extraction to upload and extract.";
    els.resultJson.textContent = "No extraction yet.";
    renderAnalysis(null);
    renderCropAnalysis();
    updateDocumentSummary();
    renderCanvas();
    setStatus(`Loaded ${file.name}. Adjust rotation/crop, then run extraction.`);
  } catch (error) {
    setStatus(error.message || "Failed to load image.", true);
  } finally {
    state.isBusy = false;
    updateControls();
  }
}

async function handleLoadImage(event) {
  event.preventDefault();
  const file = els.fileInput.files[0];
  if (!file) {
    setStatus("Choose a file before loading.", true);
    return;
  }
  await loadFileIntoPreview(file);
}

function rotate(delta) {
  if (!state.previewImage) {
    return;
  }
  state.rotation = (state.rotation + delta + 360) % 360;
  resetAdjustments();
  renderCanvas();
  renderCropAnalysis();
  updateControls();
  setStatus(`Rotation set to ${state.rotation} degrees.`);
}


async function handleExtraction() {
  if (!state.previewImage || !state.localFile) {
    return;
  }

  state.isBusy = true;
  updateControls();

  try {
    // Step 1: Render the export canvas and encode as JPEG
    setStatus("Rendering full-resolution export image...");
    renderExportCanvas();
    const dataUrl = els.exportCanvas.toDataURL("image/jpeg", 0.95);
    const blob = dataUrlToBlob(dataUrl);

    // Step 2: Upload the JPEG blob
    setStatus("Uploading processed image...");
    const baseName = state.localFile.name.replace(/\.[^.]+$/, "");
    const filename = `${baseName}_frontend.jpg`;
    const formData = new FormData();
    formData.append("file", blob, filename);

    const uploadResponse = await fetch(`${BASE_API_URL}/api/uploads`, {
      method: "POST",
      body: formData,
    });
    const uploadPayload = await uploadResponse.json();
    if (!uploadResponse.ok) {
      throw new Error(uploadPayload.detail || "Upload failed.");
    }

    state.upload = uploadPayload;
    state.documentId = uploadPayload.document_id;
    els.uploadJson.textContent = formatJson(uploadPayload);
    updateDocumentSummary();
    updateControls();

    // Step 3: Run extraction
    setStatus("Running extraction...");
    const extractionPayload = {
      document_id: state.documentId,
      input_mode: "frontend",
      enable_correction: false,
      use_face_hint: false,
    };
    const extractionResponse = await fetch(`${BASE_API_URL}/api/extractions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(extractionPayload),
    });
    const result = await extractionResponse.json();
    if (!extractionResponse.ok) {
      throw new Error(result.detail || "Extraction failed.");
    }

    els.resultJson.textContent = formatJson(result);
    renderAnalysis(result);
    setStatus(`Extraction completed with status=${result.status}.`);
    const isSuccess = result.status === "success";
    showToast(
      isSuccess ? "Extraction successful" : `Extraction ${result.status || "failed"}`,
      isSuccess ? "success" : "error"
    );
  } catch (error) {
    setStatus(error.message || "Extraction failed.", true);
    showToast(error.message || "Extraction failed", "error");
  } finally {
    state.isBusy = false;
    updateControls();
  }
}

function handlePointerDown(event) {
  if (!state.previewImage || state.isBusy) {
    return;
  }
  event.preventDefault();
  state.dragStart = getCanvasPointer(event);
  state.dragCurrent = state.dragStart;
  renderCanvas();
}

function handlePointerMove(event) {
  if (!state.dragStart) {
    return;
  }
  event.preventDefault();
  const next = getCanvasPointer(event);
  const rawDx = (next.x - state.dragCurrent.x) * DRAG_SENSITIVITY;
  const rawDy = (next.y - state.dragCurrent.y) * DRAG_SENSITIVITY;
  // The canvas renders with ctx.rotate(totalAngle) applied before drawing the
  // image offset, so the offset lives in the rotated (image) coordinate frame.
  // Inverse-rotate the screen-space drag delta so dragging always matches the
  // visual direction regardless of how the image is rotated.
  const angle = -((state.rotation + state.microRotation) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = rawDx * cos - rawDy * sin;
  const dy = rawDx * sin + rawDy * cos;
  state.offsetX = clamp(state.offsetX + dx, -OFFSET_LIMIT, OFFSET_LIMIT);
  state.offsetY = clamp(state.offsetY + dy, -OFFSET_Y_LIMIT, OFFSET_Y_LIMIT);
  state.dragCurrent = next;
  renderCanvas();
  renderCropAnalysis();
  updateControls();
}

function handlePointerUp(event) {
  if (!state.dragStart) {
    return;
  }
  state.dragStart = null;
  state.dragCurrent = null;
  renderCanvas();
  renderCropAnalysis();
  updateControls();
  setStatus("Image adjustment updated.");
}

function handleResize() {
  renderCanvas();
}

// ── Guidance canvas (off-screen, display resolution, OpenCV reads only here) ─
function updateGuidance() {
  if (!state.previewImage) return;
  const w = state.canvasBounds.width || 320;
  const h = state.canvasBounds.height || 240;
  renderImage(guidanceCanvas, w, h);

  if (!opencvReady) return;
  try {
    runGuidanceDetection();
  } catch (err) {
    console.warn("[guidance] detection error:", err);
  }
}

function runGuidanceDetection() {
  // OpenCV reads ONLY from guidanceCanvas — never from preview or export.
  // CascadeClassifier requires pre-loaded cascade XML files.
  // To enable: load haarcascade XMLs via cv.FS_createDataFile,
  // create cv.CascadeClassifier, and call detectMultiScale here.
  const cv_mod = window.cv;
  const mats = [];
  const track = (m) => { mats.push(m); return m; };
  try {
    const src = track(cv_mod.imread(guidanceCanvas));
    const gray = track(new cv_mod.Mat());
    cv_mod.cvtColor(src, gray, cv_mod.COLOR_RGBA2GRAY);

    // Example integration point:
    // const faces = new cv_mod.RectVector();
    // faceClassifier.detectMultiScale(gray, faces);
    // state.guidance.faceRects = rectVectorToArray(faces);
    // faces.delete();

    state.guidance.imageSize = { width: gray.cols, height: gray.rows };
  } finally {
    for (const m of mats) { try { m.delete(); } catch (_) {} }
  }
}

function scheduleGuidance() {
  if (guidanceTimer) return;
  guidanceTimer = setTimeout(() => {
    guidanceTimer = null;
    updateGuidance();
  }, GUIDANCE_INTERVAL);
}

function drawGuidanceOverlays(targetW, targetH) {
  if (!state.guidance.faceRects && !state.guidance.mrzRect) return;
  ctx.save();
  if (state.guidance.faceRects) {
    ctx.strokeStyle = "rgba(255, 165, 0, 0.8)";
    ctx.lineWidth = 2;
    for (const r of state.guidance.faceRects) {
      ctx.strokeRect(r.x, r.y, r.width, r.height);
    }
  }
  if (state.guidance.mrzRect) {
    const r = state.guidance.mrzRect;
    ctx.strokeStyle = "rgba(0, 200, 100, 0.8)";
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.width, r.height);
  }
  ctx.restore();
}

// ── rAF loop ────────────────────────────────────────────────────────
// Re-measures the container and redraws every frame — handles
// responsiveness automatically without ResizeObserver.
function animationFrame() {
  renderCanvas();
  requestAnimationFrame(animationFrame);
}

function scheduleRender() {
  renderNeeded = true;
}

function _markOpenCvReady() {
  opencvReady = true;
  if (els.opencvChip) {
    els.opencvChip.textContent = "opencv: ready";
    els.opencvChip.style.color = "";
  }
  if (state.previewImage) renderCanvas();
}

window.onOpenCvReady = function () {
  if (typeof cv === "undefined") return;
  // WASM may already be initialized or still loading
  if (cv.Mat) {
    _markOpenCvReady();
  } else {
    cv["onRuntimeInitialized"] = _markOpenCvReady;
  }
};

window.onOpenCvError = function () {
  if (els.opencvChip) {
    els.opencvChip.textContent = "opencv: unavailable";
    els.opencvChip.style.color = "var(--danger)";
  }
};

function init() {
  updateDocumentSummary();
  updateControls();
  renderAnalysis(null);
  renderCropAnalysis();
  requestAnimationFrame(animationFrame);
  els.uploadForm.addEventListener("submit", handleLoadImage);
  els.fileInput.addEventListener("change", () => {
    if (els.fileInput.files && els.fileInput.files[0]) {
      els.fileDropLabel.textContent = els.fileInput.files[0].name;
    } else {
      els.fileDropLabel.textContent = "Choose passport image or PDF";
    }
    updateControls();
  });
  els.rotateLeft.addEventListener("click", () => rotate(270));
  els.rotateRight.addEventListener("click", () => rotate(90));
  els.resetAdjust.addEventListener("click", handleResetAdjust);
  els.extractButton.addEventListener("click", handleExtraction);
  els.extractButtonInline.addEventListener("click", handleExtraction);
  els.useFaceHint.addEventListener("change", updatePayloadView);
  els.microRotate.addEventListener("input", () => {
    state.microRotation = Number(els.microRotate.value);
    renderCanvas();
    renderCropAnalysis();
    updateControls();
  });
  els.zoomRange.addEventListener("input", () => {
    state.zoom = Number(els.zoomRange.value);
    renderCanvas();
    renderCropAnalysis();
    updateControls();
  });
  els.zoomOut.addEventListener("click", () => {
    state.zoom = Number(clamp(state.zoom - 0.03, ZOOM_MIN, ZOOM_MAX).toFixed(2));
    renderCanvas();
    renderCropAnalysis();
    updateControls();
  });
  els.zoomIn.addEventListener("click", () => {
    state.zoom = Number(clamp(state.zoom + 0.03, ZOOM_MIN, ZOOM_MAX).toFixed(2));
    renderCanvas();
    renderCropAnalysis();
    updateControls();
  });
  els.offsetXRange.addEventListener("input", () => {
    state.offsetX = Number(els.offsetXRange.value);
    renderCanvas();
    renderCropAnalysis();
    updateControls();
  });
  els.offsetYRange.addEventListener("input", () => {
    state.offsetY = Number(els.offsetYRange.value);
    renderCanvas();
    renderCropAnalysis();
    updateControls();
  });
  // ── File drag-and-drop on the upload zone ──────────────────────────
  els.fileDrop.addEventListener("dragenter", (event) => {
    event.preventDefault();
    els.fileDrop.classList.add("file-drop-active");
  });
  els.fileDrop.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.fileDrop.classList.add("file-drop-active");
  });
  els.fileDrop.addEventListener("dragleave", (event) => {
    if (!els.fileDrop.contains(event.relatedTarget)) {
      els.fileDrop.classList.remove("file-drop-active");
    }
  });
  els.fileDrop.addEventListener("drop", (event) => {
    event.preventDefault();
    els.fileDrop.classList.remove("file-drop-active");
    if (state.isBusy) return;
    const file = event.dataTransfer.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
      showToast("Only image files and PDFs are supported.", "error");
      setStatus("Unsupported file type dropped.", true);
      return;
    }
    // Populate the file input exactly as if the user picked it via the dialog
    const dt = new DataTransfer();
    dt.items.add(file);
    els.fileInput.files = dt.files;
    els.fileDropLabel.textContent = file.name;
    updateControls();
    setStatus(`"${file.name}" ready — click Load Image to preview.`);
  });

  els.canvas.addEventListener("pointerdown", handlePointerDown);
  els.canvas.addEventListener("pointermove", handlePointerMove);
  els.canvas.addEventListener("pointerup", handlePointerUp);
  els.canvas.addEventListener("pointerleave", handlePointerUp);
  els.canvas.addEventListener("wheel", (event) => {
    if (!state.previewImage) {
      return;
    }
    event.preventDefault();
    const nextZoom = clamp(state.zoom + (event.deltaY < 0 ? 0.03 : -0.03), ZOOM_MIN, ZOOM_MAX);
    state.zoom = Number(nextZoom.toFixed(2));
    renderCanvas();
    renderCropAnalysis();
    updateControls();
  }, { passive: false });
}

init();
