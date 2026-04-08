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
  guidance: { faceRects: null, mrzRect: null, lineRects: null, mrzDetected: false, status: null, message: "", zone: null },
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
  opencvChip: document.querySelector("#opencv-chip"),
  cropAnalysisOutput: document.querySelector("#crop-analysis-output"),
  requestJson: document.querySelector("#request-json"),
  uploadJson: document.querySelector("#upload-json"),
  resultJson: document.querySelector("#result-json"),
  analysisOutput: document.querySelector("#analysis-output"),
  liveGuidanceOutput: document.querySelector("#live-guidance-output"),
  microRotateVal: document.querySelector("#micro-rotate-val"),
  zoomVal: document.querySelector("#zoom-val"),
  offsetXVal: document.querySelector("#offset-x-val"),
  offsetYVal: document.querySelector("#offset-y-val"),
  statusText: document.querySelector("#status-text"),
  spinnerOverlay: document.querySelector("#spinner-overlay"),
  toastContainer: document.querySelector("#toast-container"),
  fileDrop: document.querySelector(".file-drop"),
  fileDropLabel: document.querySelector(".file-drop-label"),
  saveExportButton: document.querySelector("#save-export-button"),
};

let opencvReady = false;
let faceCascadeReady = false;
let faceCascade = null;

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
const MRZ_FOCUS_Y_OFFSET = 0.04;
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

function renderLiveGuidance() {
  if (!els.liveGuidanceOutput) return;

  if (!state.previewImage) {
    els.liveGuidanceOutput.innerHTML = '<p class="analysis-empty">Load a document to see live guidance.</p>';
    return;
  }

  const mrzReady = state.guidance.status === "READY";
  const faceCount = Array.isArray(state.guidance.faceRects) ? state.guidance.faceRects.length : 0;
  const faceDetected = faceCount > 0;

  const mrzDot = mrzReady ? "guidance-dot-ok" : "guidance-dot-warn";
  const mrzVal = mrzReady ? "guidance-value-ok" : "guidance-value-warn";
  const mrzMsg = mrzReady ? "Ready \u2713" : (state.guidance.message || "Not detected");

  let faceDot, faceVal, faceMsg;
  if (!faceCascadeReady) {
    faceDot = "guidance-dot-warn";
    faceVal = "guidance-value-muted";
    faceMsg = "Loading cascade\u2026";
  } else if (faceDetected) {
    faceDot = "guidance-dot-ok";
    faceVal = "guidance-value-ok";
    faceMsg = `Detected (${faceCount})`;
  } else {
    faceDot = "guidance-dot-warn";
    faceVal = "guidance-value-warn";
    faceMsg = "Not detected";
  }

  els.liveGuidanceOutput.innerHTML = `
    <div class="guidance-row">
      <span class="guidance-dot ${mrzDot}"></span>
      <span class="guidance-label">MRZ Lines</span>
      <span class="${mrzVal}">${escapeHtml(mrzMsg)}</span>
    </div>
    <div class="guidance-row">
      <span class="guidance-dot ${faceDot}"></span>
      <span class="guidance-label">Face</span>
      <span class="${faceVal}">${escapeHtml(faceMsg)}</span>
    </div>
  `;
}

function updateControls() {
  const hasImage = Boolean(state.previewImage);
  els.rotateLeft.disabled = !hasImage || state.isBusy;
  els.rotateRight.disabled = !hasImage || state.isBusy;
  els.resetAdjust.disabled = !hasImage || state.isBusy;
  els.extractButton.disabled = !hasImage || state.isBusy;
  els.saveExportButton.disabled = !hasImage || state.isBusy;
  const hasFile = els.fileInput.files && els.fileInput.files.length > 0;
  els.uploadButton.disabled = !hasFile || state.isBusy;
  els.fileInput.disabled = state.isBusy;
  els.microRotate.disabled = !hasImage || state.isBusy;
  els.zoomOut.disabled = !hasImage || state.isBusy;
  els.zoomIn.disabled = !hasImage || state.isBusy;
  els.zoomRange.disabled = !hasImage || state.isBusy;
  els.offsetXRange.disabled = !hasImage || state.isBusy;
  els.offsetYRange.disabled = !hasImage || state.isBusy;
  els.rotationChip.textContent = `Rotation: ${state.rotation}`;
  els.docIdChip.textContent = `Document: ${state.documentId || "-"}`;
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
    els.docMeta.textContent = `Uploaded | ${state.upload.preview_width}x${state.upload.preview_height}`;
  } else if (state.localFile) {
    els.docName.textContent = state.localFile.name;
    const img = state.previewImage;
    els.docMeta.textContent = img
      ? `Local Image | ${img.naturalWidth}x${img.naturalHeight}`
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
  renderLiveGuidance();
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
  const zoneY = targetHeight * (1 - MRZ_FOCUS_HEIGHT) - bottomPad - (targetHeight * MRZ_FOCUS_Y_OFFSET);
  const zoneW = targetWidth * 0.98;
  const zoneH = targetHeight * MRZ_FOCUS_HEIGHT;

ctx.save();
ctx.setLineDash([8, 6]);
ctx.strokeStyle = "rgba(0, 80, 40, 0.45)";
ctx.lineWidth = 3;
ctx.fillStyle = "rgba(0, 143, 76, 0.08)";
ctx.fillRect(zoneX, zoneY, zoneW, zoneH);
ctx.setLineDash([]);
ctx.strokeStyle = "#008f4c";
ctx.strokeRect(zoneX, zoneY, zoneW, zoneH);

ctx.restore();
}
// ── Shared render function for all three canvases ──────────────────
// ── Shared image render ─────────────────────────────────────────────────────
// Identical transform pipeline to renderCanvas. Used by the export canvas and
// the guidance canvas so all three always agree on geometry.
function renderToCanvas(targetCanvas, targetW, targetH) {
  const tctx = targetCanvas.getContext("2d");
  targetCanvas.width = targetW;
  targetCanvas.height = targetH;

  const img = state.previewImage;
  if (!img) {
    tctx.fillStyle = BG_FILL;
    tctx.fillRect(0, 0, targetW, targetH);
    return;
  }

  const totalAngle = (state.rotation + state.microRotation) * Math.PI / 180;
  const cosA = Math.abs(Math.cos(totalAngle));
  const sinA = Math.abs(Math.sin(totalAngle));
  const rotW = img.width * cosA + img.height * sinA;
  const rotH = img.width * sinA + img.height * cosA;
  const baseScale = Math.min(targetW / rotW, targetH / rotH);

  tctx.clearRect(0, 0, targetW, targetH);
  tctx.fillStyle = BG_FILL;
  tctx.fillRect(0, 0, targetW, targetH);
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = "high";

  tctx.save();
  tctx.translate(targetW / 2, targetH / 2);
  tctx.rotate(totalAngle);
  tctx.scale(baseScale * state.zoom, baseScale * state.zoom);
  const dragX = state.offsetX * img.width;
  const dragY = state.offsetY * img.height;
  tctx.drawImage(img, -img.width / 2 + dragX, -img.height / 2 + dragY);
  tctx.restore();
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
// Canvas is sized to the rotated bounding box at native resolution so
// baseScale inside renderToCanvas equals 1 and no letterboxing occurs.
function renderExportCanvas() {
  if (!state.previewImage) return;
  const img = state.previewImage;
  const totalAngle = (state.rotation + state.microRotation) * Math.PI / 180;
  const cosA = Math.abs(Math.cos(totalAngle));
  const sinA = Math.abs(Math.sin(totalAngle));
  const canvasW = Math.round(img.naturalWidth * cosA + img.naturalHeight * sinA);
  const canvasH = Math.round(img.naturalWidth * sinA + img.naturalHeight * cosA);
  renderToCanvas(els.exportCanvas, canvasW, canvasH);
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
    state.guidance.faceRects = null;
    state.guidance.status = null;
    state.guidance.mrzDetected = false;
    state.guidance.mrzRect = null;
    state.guidance.lineRects = null;

    els.uploadJson.textContent = "Not uploaded yet. Click Run Extraction to upload and extract.";
    els.resultJson.textContent = "No extraction yet.";
    renderAnalysis(null);
    renderCropAnalysis();
    renderLiveGuidance();
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


function handleSaveExport() {
  if (!state.previewImage) return;
  renderExportCanvas();
  const baseName = state.localFile ? state.localFile.name.replace(/\.[^.]+$/, "") : "export";
  const filename = `${baseName}_adjusted.jpg`;
  const dataUrl = els.exportCanvas.toDataURL("image/jpeg", 0.95);
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.click();
  setStatus(`Saved export as ${filename}.`);
  showToast(`Saved ${filename}`, "success");
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
  renderToCanvas(guidanceCanvas, w, h);

  if (!opencvReady) return;
  try {
    runGuidanceDetection();
  } catch (err) {
    console.warn("[guidance] detection error:", err);
  }
  renderLiveGuidance();
}

// ── MRZ projection-profile peak finder ─────────────────────────────────────
// Scans a 1-D Float32Array for distinct "runs" of values above
// (maxVal * minRelHeight). Runs closer than minGapRows are merged.
// Returns an array of { row, value, start, end } objects, one per peak.
function findProjectionPeaks(profile, minRelHeight, minGapRows) {
  let maxVal = 0;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] > maxVal) maxVal = profile[i];
  }
  if (maxVal === 0) return [];

  const threshold = maxVal * minRelHeight;
  const raw = [];
  let inRun = false;
  let runStart = 0;
  let runPeakVal = 0;
  let runPeakRow = 0;

  for (let i = 0; i < profile.length; i++) {
    if (profile[i] >= threshold) {
      if (!inRun) {
        inRun = true;
        runStart = i;
        runPeakVal = profile[i];
        runPeakRow = i;
      } else if (profile[i] > runPeakVal) {
        runPeakVal = profile[i];
        runPeakRow = i;
      }
    } else if (inRun) {
      raw.push({ row: runPeakRow, value: runPeakVal, start: runStart, end: i - 1 });
      inRun = false;
    }
  }
  if (inRun) {
    raw.push({ row: runPeakRow, value: runPeakVal, start: runStart, end: profile.length - 1 });
  }

  // Merge adjacent runs that are closer than minGapRows
  const merged = [];
  for (const p of raw) {
    if (merged.length > 0 && p.start - merged[merged.length - 1].end < minGapRows) {
      const prev = merged[merged.length - 1];
      if (p.value > prev.value) {
        merged[merged.length - 1] = { ...p, start: prev.start };
      } else {
        merged[merged.length - 1] = { ...prev, end: p.end };
      }
    } else {
      merged.push({ ...p });
    }
  }
  return merged;
}

// ── MRZ guidance detection ──────────────────────────────────────────────────
// Reads ONLY from guidanceCanvas. Full pipeline:
//   ROI → greyscale → Otsu (invert) → raw profile (density check)
//   → horizontal dilation → dilated profile → peak detection
//   → per-peak width + density filter → TD3 structural validation
//   → directional edge-touch check → status + message.
//
// Filtering rejects false-positives (headers, signatures) by requiring every
// candidate bar to span ≥ MIN_WIDTH_RATIO of the zone width AND carry enough
// raw ink (MIN_DENSITY). Only bars that pass both filters are counted as MRZ lines.
//
// Sets: state.guidance.{status, message, mrzDetected, mrzRect, lineRects, zone}
function runGuidanceDetection() {
  const cv_mod = window.cv;
  const w = guidanceCanvas.width;
  const h = guidanceCanvas.height;
  if (w === 0 || h === 0) return;

  // ── 1. ROI geometry — keep in sync with drawWorkingFrameOverlay() ──────────
  const bottomPad = h * 0.04;
  const zoneX = Math.round(w * 0.01);
  const zoneY = Math.max(0, Math.round(
    h * (1 - MRZ_FOCUS_HEIGHT) - bottomPad - h * MRZ_FOCUS_Y_OFFSET
  ));
  const zoneW = Math.min(Math.round(w * 0.98), w - zoneX);
  const zoneH = Math.min(Math.round(h * MRZ_FOCUS_HEIGHT), h - zoneY);

  // Always reset so any early-return leaves consistent state
  state.guidance.mrzDetected = false;
  state.guidance.mrzRect     = null;
  state.guidance.lineRects   = null;
  state.guidance.status      = "NONE";
  state.guidance.message     = "No MRZ detected";
  state.guidance.zone        = { x: zoneX, y: zoneY, width: zoneW, height: zoneH };

  if (zoneW <= 0 || zoneH <= 0) return;

  // Detection thresholds
  const MIN_WIDTH_RATIO       = 0.75; // bar must span ≥ 75 % of zone width
  const MIN_DENSITY           = 0.03; // ≥ 3 % ink fill (rejects watermarks/noise)
  const EDGE_PX               = 5;    // hard pixel margin for edge-touch detection (cut-off threshold)
  const MAX_LINE_HEIGHT_RATIO = 0.30; // bar taller than 30 % of zone = header/logo
  const TD3_MIN_SPAN_RATIO    = 0.90; // single bar must be ≥ 90 % wide to warn
  const MIN_SYMMETRY          = 0.80; // both MRZ lines must match in width (±20 %)

  let full = null, roi = null, gray = null, binary = null,
      kernel = null, dilated = null, grayFull = null;

  try {
    // ── 2. Read full frame → greyscale ────────────────────────────────────
    full = cv_mod.imread(guidanceCanvas);
    grayFull = new cv_mod.Mat();
    cv_mod.cvtColor(full, grayFull, cv_mod.COLOR_RGBA2GRAY);
    full.delete(); full = null;

    // ── 2a. Face detection on full-frame grey ─────────────────────────────
    if (faceCascadeReady && faceCascade) {
      const imgW = grayFull.cols;
      const imgH = grayFull.rows;

      // Equalise histogram so detection is robust to dark/bright scans
      const eqGray = new cv_mod.Mat();
      cv_mod.equalizeHist(grayFull, eqGray);

      // Size bounds: face must be ≥10 % and ≤60 % of the shorter image dimension
      const shortSide = Math.min(imgW, imgH);
      const minFacePx = Math.max(50, Math.round(shortSide * 0.10));
      const maxFacePx = Math.round(shortSide * 0.60);

      const faces = new cv_mod.RectVector();
      faceCascade.detectMultiScale(
        eqGray, faces,
        1.15,  // scaleFactor  — fewer borderline scale hits than 1.1
        6,     // minNeighbors — each candidate must be confirmed 6 times (was 3)
        0,
        new cv_mod.Size(minFacePx, minFacePx),
        new cv_mod.Size(maxFacePx, maxFacePx)
      );
      eqGray.delete();

      const rects = [];
      for (let i = 0; i < faces.size(); i++) {
        const f = faces.get(i);

        // Aspect-ratio guard: real faces are roughly square (width/height 0.65–1.55)
        const aspect = f.width / f.height;
        if (aspect < 0.65 || aspect > 1.55) continue;

        // Position guard: passport photo is always in the upper ~70 % of the page.
        // Anything whose centre falls below that is a logo, stamp, or the MRZ zone.
        const cy = f.y + f.height / 2;
        if (cy > imgH * 0.70) continue;

        rects.push({ x: f.x, y: f.y, width: f.width, height: f.height });
      }
      faces.delete();

      // A passport has exactly one face — keep the largest surviving detection only.
      rects.sort((a, b) => (b.width * b.height) - (a.width * a.height));
      state.guidance.faceRects = rects.slice(0, 1);
    }

    // ── 3. Extract grey ROI for MRZ detection ────────────────────────────
    const grayRoiView = grayFull.roi(new cv_mod.Rect(zoneX, zoneY, zoneW, zoneH));
    gray = grayRoiView.clone();
    grayRoiView.delete();
    grayFull.delete(); grayFull = null;

    // ── 4. Otsu threshold, inverted (dark ink → white) ────────────────────
    binary = new cv_mod.Mat();
    cv_mod.threshold(
      gray, binary, 0, 255,
      cv_mod.THRESH_BINARY_INV + cv_mod.THRESH_OTSU
    );
    gray.delete(); gray = null;

    const cols = binary.cols;
    const rows = binary.rows;

    // ── 5. Raw vertical profile from binary (used for density filter) ─────
    // Keep binaryData in scope until rawProfile is fully built, then delete binary.
    const binaryData = binary.data; // Uint8Array view — read BEFORE binary.delete()
    const rawProfile = new Float32Array(rows);
    for (let r = 0; r < rows; r++) {
      let sum = 0;
      const base = r * cols;
      for (let c = 0; c < cols; c++) sum += binaryData[base + c];
      rawProfile[r] = sum;
    }
    // rawProfile is now a standalone Float32Array — binary can be released.

    // ── 6. Horizontal dilation — smear characters into solid bars ─────────
    // Kernel width ≈ 4 % of zone width, minimum 15 px.
    const kernelWidth = Math.max(15, Math.round(zoneW * 0.04));
    kernel = cv_mod.getStructuringElement(
      cv_mod.MORPH_RECT,
      new cv_mod.Size(kernelWidth, 1)
    );
    dilated = new cv_mod.Mat();
    cv_mod.dilate(binary, dilated, kernel);
    binary.delete(); binary = null;
    kernel.delete(); kernel = null;

    // ── 7. Dilated vertical profile — used for peak detection ─────────────
    const pxData = dilated.data; // Uint8Array view — read BEFORE dilated.delete()
    const dilatedProfile = new Float32Array(rows);
    for (let r = 0; r < rows; r++) {
      let sum = 0;
      const base = r * cols;
      for (let c = 0; c < cols; c++) sum += pxData[base + c];
      dilatedProfile[r] = sum;
    }

    // ── 8. Peak detection ─────────────────────────────────────────────────
    const minGap = Math.max(2, Math.round(zoneH * 0.06));
    const rawPeaks = findProjectionPeaks(dilatedProfile, 0.25, minGap);

    // ── 9. Per-peak metrics (span + ink density) ──────────────────────────
    //
    // getBarSpan: leftmost and rightmost non-zero dilated column in the row band.
    // Must be called while pxData (dilated.data) is still valid.
    const getBarSpan = (startRow, endRow) => {
      let left = cols;
      let right = -1;
      const endBound = Math.min(endRow, rows - 1);
      for (let r = startRow; r <= endBound; r++) {
        const base = r * cols;
        for (let c = 0; c < cols; c++) {
          if (pxData[base + c] > 0) {
            if (c < left)  left  = c;
            if (c > right) right = c;
          }
        }
      }
      return right >= 0 ? { left, right, span: right - left + 1 } : null;
    };

    // getBarDensity: average raw-ink fill ratio across the band (full zone width).
    // Uses rawProfile (pre-dilation), which is already a Float32Array, so it
    // remains valid regardless of when binary was deleted.
    const getBarDensity = (startRow, endRow) => {
      const endBound = Math.min(endRow, rows - 1);
      const bandH = endBound - startRow + 1;
      if (bandH <= 0 || cols === 0) return 0;
      let total = 0;
      for (let r = startRow; r <= endBound; r++) total += rawProfile[r];
      return total / (255 * cols * bandH);
    };

    // ── 10. Multi-filter: reject headers, logos, signatures, and noise ─────
    // Filter 1 (Width):   bar must span ≥ MIN_WIDTH_RATIO of zone width.
    // Filter 2 (Density): must carry enough raw ink — rejects watermarks/noise.
    // Filter 3 (Height):  bar taller than MAX_LINE_HEIGHT_RATIO × zoneH is a
    //                     header, emblem, or photo region — reject it.
    const validPeaks = rawPeaks
      .map((p) => ({
        ...p,
        spanInfo:   getBarSpan(p.start, p.end),
        density:    getBarDensity(p.start, p.end),
        lineHeight: p.end - p.start,
      }))
      .filter((p) =>
        p.spanInfo !== null &&
        p.spanInfo.span / cols >= MIN_WIDTH_RATIO &&
        p.density >= MIN_DENSITY &&
        p.lineHeight / zoneH <= MAX_LINE_HEIGHT_RATIO
      );

    // pxData accesses are complete — release dilated now
    dilated.delete(); dilated = null;

    // ── 11. Status logic on validated peaks ──────────────────────────────
    if (validPeaks.length === 0) {
      state.guidance.status  = "NONE";
      state.guidance.message = "No MRZ detected";

    } else if (validPeaks.length === 1) {
      const p = validPeaks[0];
      // TD3 or Nothing: a lone bar must reach ≥ TD3_MIN_SPAN_RATIO of the zone
      // width to earn an INCOMPLETE warning. Narrower bars are incidental text
      // (e.g. a partial header) — silence them with NONE to avoid false alerts.
      if (p.spanInfo.span / cols >= TD3_MIN_SPAN_RATIO) {
        state.guidance.status  = "INCOMPLETE";
        state.guidance.message = "Align MRZ — only 1 line visible";
        state.guidance.mrzRect = {
          x: zoneX, y: zoneY + p.start,
          width: zoneW, height: Math.max(1, p.end - p.start),
        };
      } else {
        state.guidance.status  = "NONE";
        state.guidance.message = "No MRZ detected";
      }

    } else {
      // Use the topmost two valid peaks
      const [p1, p2] = validPeaks.slice(0, 2);
      const relGap    = (p2.row - p1.row) / zoneH;
      const similarity = Math.min(p1.value, p2.value) / Math.max(p1.value, p2.value);

      // Spanning rect covering both bands (used for non-READY states)
      state.guidance.mrzRect = {
        x: zoneX, y: zoneY + p1.start,
        width: zoneW, height: Math.max(1, p2.end - p1.start),
      };

      // Symmetry check: TD3 line 1 and line 2 have 44 characters each, so their
      // pixel widths should be nearly identical. A ratio below MIN_SYMMETRY means
      // one bar is significantly shorter — reject as misaligned / not a real MRZ.
      const spanSymmetry = Math.min(p1.spanInfo.span, p2.spanInfo.span) /
                           Math.max(p1.spanInfo.span, p2.spanInfo.span);

      if (spanSymmetry < MIN_SYMMETRY) {
        state.guidance.status  = "INCOMPLETE";
        state.guidance.message = "Align MRZ \u2014 lines uneven";

      } else if (relGap >= 0.15 && relGap <= 0.85 && similarity >= 0.20) {
        // ── 12. Containment check ────────────────────────────────────────
        // READY as long as both bars sit fully inside the guide zone (5 px margin).
        // At minimum zoom the MRZ naturally spans the full box width, so BOTH
        // edges touching simultaneously is not an error. However a single-side
        // horizontal cut-off is always a panning mistake — flag it regardless of zoom.
        const VERT_MARGIN  = 5;   // px from top/bottom of ROI
        const atMinZoom    = state.zoom < 1.1;
        const canZoomOut   = state.zoom > 1.2;

        const minX    = Math.min(p1.spanInfo.left,  p2.spanInfo.left);
        const maxX    = Math.max(p1.spanInfo.right, p2.spanInfo.right);
        const topY    = p1.start; // relative to ROI top (0 = top of zone)
        const bottomY = p2.end;

        const leftTouching   = minX < EDGE_PX;
        const rightTouching  = maxX > cols - 1 - EDGE_PX;
        const topTouching    = topY < VERT_MARGIN;
        const bottomTouching = bottomY > rows - 1 - VERT_MARGIN;

        // Suppress the both-sides-touching case only at minimum zoom (natural fill).
        // Any single-side cut-off is a pan error — always flagged.
        const naturalFill = atMinZoom && leftTouching && rightTouching;
        const hasCutOff   = !naturalFill && (leftTouching || rightTouching || topTouching || bottomTouching);

        if (hasCutOff) {
          // Give the most actionable message for the cut-off direction.
          state.guidance.status = "CUT_OFF";
          if (leftTouching && !rightTouching) {
            state.guidance.message = "Move Image Right \u2192";
          } else if (rightTouching && !leftTouching) {
            state.guidance.message = "\u2190 Move Image Left";
          } else if (leftTouching && rightTouching) {
            state.guidance.message = canZoomOut ? "Zoom out \u2014 MRZ too wide" : "Move Image Down \u2193";
          } else if (topTouching) {
            state.guidance.message = "Move Image Down \u2193";
          } else {
            state.guidance.message = "Move Image Up \u2191";
          }
        } else {
          // Both lines fully contained within the guide zone — ready to extract.
          state.guidance.status      = "READY";
          state.guidance.message     = "MRZ Ready \u2713";
          state.guidance.mrzDetected = true;
          state.guidance.lineRects = [
            { x: zoneX, y: zoneY + p1.start, width: zoneW, height: Math.max(1, p1.end - p1.start) },
            { x: zoneX, y: zoneY + p2.start, width: zoneW, height: Math.max(1, p2.end - p2.start) },
          ];
        }
      } else {
        // Two wide, symmetrical bars found but structural gap/similarity check
        // still fails. Treat as INCOMPLETE without a rotation-specific message.
        const hasBottomFace = Array.isArray(state.guidance.faceRects) &&
          state.guidance.faceRects.some((r) => (r.y + r.height / 2) > h * 0.5);
        state.guidance.status  = "INCOMPLETE";
        state.guidance.message = hasBottomFace
          ? "Passport upside down \u2014 please rotate"
          : "Align MRZ inside the box";
      }
    }

  } finally {
    // Null-guarded cleanup — every Mat is freed even if an exception fires mid-pipeline.
    try { if (full)     full.delete();     } catch (_) {}
    try { if (roi)      roi.delete();      } catch (_) {}
    try { if (grayFull) grayFull.delete(); } catch (_) {}
    try { if (gray)     gray.delete();     } catch (_) {}
    try { if (binary)   binary.delete();   } catch (_) {}
    try { if (kernel)   kernel.delete();   } catch (_) {}
    try { if (dilated)  dilated.delete();  } catch (_) {}
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
  const status = state.guidance.status;
  // Nothing to draw until the first detection pass has run
  if (!status) return;

  ctx.save();

  // Face rects — drawn first so MRZ overlay appears on top
  if (state.guidance.faceRects) {
    ctx.strokeStyle = "rgba(255, 165, 0, 0.8)";
    ctx.lineWidth = 2;
    for (const r of state.guidance.faceRects) {
      ctx.strokeRect(r.x, r.y, r.width, r.height);
    }
  }

  // Status-driven colour palette
  const PALETTES = {
    NONE:       { stroke: "rgba(220,  53,  69, 0.90)", fill: "rgba(220,  53,  69, 0.10)", pill: "rgba(160,  20,  35, 0.85)" },
    INCOMPLETE: { stroke: "rgba(255, 193,   7, 0.90)", fill: "rgba(255, 193,   7, 0.10)", pill: "rgba(140, 100,   0, 0.85)" },
    CUT_OFF:    { stroke: "rgba(255, 140,   0, 0.90)", fill: "rgba(255, 140,   0, 0.10)", pill: "rgba(160,  80,   0, 0.85)" },
    READY:      { stroke: "rgba(  0, 210, 100, 0.95)", fill: "rgba(  0, 210, 100, 0.13)", pill: "rgba(  0, 110,  55, 0.85)" },
  };
  const pal = PALETTES[status] || PALETTES.NONE;

  // ── Highlight rects ────────────────────────────────────────────────────────
  // READY: draw each detected line separately (tighter, more informative).
  // All other states: draw the single spanning mrzRect, or fall back to the
  // full guide zone so there is always a visible colour cue.
  ctx.fillStyle   = pal.fill;
  ctx.strokeStyle = pal.stroke;
  ctx.lineWidth   = 2.5;

  if (status === "READY" && state.guidance.lineRects) {
    ctx.setLineDash([]);
    for (const r of state.guidance.lineRects) {
      ctx.fillRect(r.x, r.y, r.width, r.height);
      ctx.strokeRect(r.x, r.y, r.width, r.height);
    }
  } else {
    const rect = state.guidance.mrzRect || state.guidance.zone;
    if (rect) {
      ctx.setLineDash([6, 4]);
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      ctx.setLineDash([]);
    }
  }

  // ── Status pill ────────────────────────────────────────────────────────────
  // Painted above the guide zone — overwrites the static "Align MRZ lines"
  // label from drawWorkingFrameOverlay (called before this function).
  const zone    = state.guidance.zone;
  const message = state.guidance.message;
  if (zone && message) {
    const textX = targetW / 2;
    const textY = zone.y - 15;
    ctx.font = '600 13px "Segoe UI", sans-serif';
    const textW = ctx.measureText(message).width;
    const padX  = 10;
    const padH  = 25;
    ctx.fillStyle = pal.pill;
    ctx.beginPath();
    ctx.roundRect(textX - textW / 2 - padX, textY - padH + 4, textW + padX * 2, padH + 4, 6);
    ctx.fill();
    ctx.fillStyle    = "#ffffff";
    ctx.textAlign    = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(message, textX, textY);
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

async function loadFaceCascade() {
  try {
    const response = await fetch(
      "assets/haarcascade_frontalface_default.xml"
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const cv_mod = window.cv;
    cv_mod.FS_createDataFile(
      "/", "haarcascade_frontalface_default.xml",
      new Uint8Array(buffer), true, false, false
    );
    faceCascade = new cv_mod.CascadeClassifier();
    faceCascade.load("haarcascade_frontalface_default.xml");
    faceCascadeReady = true;
  } catch (err) {
    console.warn("[face] Haar cascade unavailable:", err);
  }
}

async function _markOpenCvReady() {
  opencvReady = true;
  if (els.opencvChip) {
    els.opencvChip.textContent = "OpenCV: Ready";
    els.opencvChip.style.color = "";
  }
  await loadFaceCascade();
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
    els.opencvChip.textContent = "OpenCV: Unavailable";
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
  els.saveExportButton.addEventListener("click", handleSaveExport);
  if (els.useFaceHint) els.useFaceHint.addEventListener("change", updatePayloadView);
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
