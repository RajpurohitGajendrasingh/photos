// paddle-test.js

import {
  recognizeWithPaddleOCR,
} from "./src/ocr/paddle-engine.js";

import {
  preparePaddleEditor,
  applyPaddleOCRToEditor,
} from "./src/ocr/paddle-editor-bridge.js";


import {
  registerDocumentGlyphRuntime,
} from "./src/ocr/glyph-graphics/document-glyph-store.js";

import {
  createDocumentGlyphSvg,
} from "./src/ocr/glyph-graphics/document-glyph-renderer.js";

const imageInput = document.getElementById("imageInput");
const runButton = document.getElementById("runButton");
const status = document.getElementById("status");
const workerTestButton =
  document.getElementById("workerTestButton");
const preview = document.getElementById("preview");
const resultsList = document.getElementById("results");

const progressWrap = document.getElementById("progressWrap");
const progressLabel = document.getElementById("progressLabel");
const progressBar = document.getElementById("progressBar");
const progressPercent = document.getElementById("progressPercent");

let selectedFile = null;
let selectedBitmap = null;

let paddleEditorPageId = null;
function setStatus(message) {
  status.textContent = message;
}

function setProgress(label, percent = null) {
  progressWrap.hidden = false;
  progressLabel.textContent = label;

  if (percent === null) {
    // Indeterminate bar while PaddleOCR runs.
    progressBar.removeAttribute("value");
    progressPercent.textContent = "Running…";
    return;
  }

  const safePercent = Math.max(
    0,
    Math.min(100, Number(percent) || 0)
  );

  progressBar.value = safePercent;
  progressPercent.textContent =
    `${Math.round(safePercent)}%`;
}

function getPolygonPoints(poly) {
  if (!Array.isArray(poly)) return [];

  if (poly.length && typeof poly[0] === "number") {
    const points = [];

    for (let i = 0; i + 1 < poly.length; i += 2) {
      points.push([
        Number(poly[i]),
        Number(poly[i + 1]),
      ]);
    }

    return points;
  }

  return poly
    .map((point) => {
      if (Array.isArray(point)) {
        return [
          Number(point[0]),
          Number(point[1]),
        ];
      }

      return [
        Number(point?.x),
        Number(point?.y),
      ];
    })
    .filter(([x, y]) =>
      Number.isFinite(x) &&
      Number.isFinite(y)
    );
}

function polygonToBounds(points) {
  if (points.length < 3) return null;

  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);

  const left = Math.floor(Math.min(...xs));
  const top = Math.floor(Math.min(...ys));
  const right = Math.ceil(Math.max(...xs));
  const bottom = Math.ceil(Math.max(...ys));

  const x = Math.max(0, left);
  const y = Math.max(0, top);

  const boundedRight = Math.min(
    selectedBitmap.width,
    right
  );

  const boundedBottom = Math.min(
    selectedBitmap.height,
    bottom
  );

  if (boundedRight <= x || boundedBottom <= y) {
    return null;
  }

  return {
    x,
    y,
    width: boundedRight - x,
    height: boundedBottom - y,
  };
}


function renderCharacterZoomDiagnostics(inkResults) {
  if (!selectedBitmap || !Array.isArray(inkResults)) return;

  let panel = document.getElementById(
    "characterZoomDiagnostics"
  );

  if (!panel) {
    panel = document.createElement("section");
    panel.id = "characterZoomDiagnostics";
    preview.insertAdjacentElement("afterend", panel);
  }

  panel.replaceChildren();

  panel.style.cssText = [
    "box-sizing:border-box",
    "margin:16px 0",
    "padding:14px",
    "border:1px solid #999",
    "border-radius:8px",
    "background:#fff",
    "color:#222",
    "font:14px/1.45 Arial,sans-serif"
  ].join(";");

  const heading = document.createElement("h3");

  heading.textContent =
    "STEP 24 — All procurement occurrences (8×)";

  heading.style.margin = "0 0 8px";
  panel.appendChild(heading);

  const explanation = document.createElement("p");

  explanation.textContent =
    "Every OCR occurrence of procurement is displayed separately. " +
    "Original image pixels are enlarged 8×. Magenta outlines show " +
    "the existing character measurements.";

  explanation.style.margin = "0 0 14px";
  panel.appendChild(explanation);

  const summary = document.createElement("div");

  summary.style.cssText =
    "margin-bottom:14px;font-weight:bold;";

  panel.appendChild(summary);

  const grid = document.createElement("div");

  grid.style.cssText =
    "display:flex;flex-direction:column;gap:14px;";

  panel.appendChild(grid);

  const failures = [];

  let occurrenceCount = 0;
  let renderedCount = 0;

  const scale = 8;

  for (let lineIndex = 0; lineIndex < inkResults.length; lineIndex++) {
    const record = inkResults[lineIndex];
    const recordText = String(record.text || "");

    const regex = /procurement/gi;
    let match;
    let occurrenceInLine = 0;

    while ((match = regex.exec(recordText)) !== null) {
      occurrenceCount++;
      occurrenceInLine++;

      const wordStart = Array.from(
        recordText.slice(0, match.index)
      ).length;

      const wordEnd =
        wordStart + Array.from(match[0]).length;

      const allCharacters =
        record.characterMeasurements?.characters || [];

      const tokens = allCharacters.filter(
        (character, arrayIndex) => {
          const tokenIndex = Number.isInteger(character.index)
            ? character.index
            : arrayIndex;

          return (
            tokenIndex >= wordStart &&
            tokenIndex < wordEnd
          );
        }
      );

      const glyphs = tokens
        .map((character) => ({
          character,
          points: getPolygonPoints(character.polygon)
        }))
        .filter((item) => item.points.length >= 3);

      if (glyphs.length === 0) {
        failures.push({
          line: lineIndex + 1,
          occurrence: occurrenceInLine,
          text: recordText,
          reason: "No character polygons"
        });

        continue;
      }

      const allPoints = glyphs.flatMap(
        (glyph) => glyph.points
      );

      const xs = allPoints.map((point) => point[0]);

      const verticalBounds =
        record.inkBounds || record.ocrBounds;

      if (
        !verticalBounds ||
        !Number.isFinite(Number(verticalBounds.y)) ||
        !Number.isFinite(Number(verticalBounds.height)) ||
        Number(verticalBounds.height) <= 0
      ) {
        failures.push({
          line: lineIndex + 1,
          occurrence: occurrenceInLine,
          text: recordText,
          reason: "Missing vertical line bounds"
        });

        continue;
      }

      const cropLeft = Math.max(
        0,
        Math.floor(Math.min(...xs) - 6)
      );

      const cropRight = Math.min(
        selectedBitmap.width,
        Math.ceil(Math.max(...xs) + 6)
      );

      const cropTop = Math.max(
        0,
        Math.floor(Number(verticalBounds.y) - 4)
      );

      const cropBottom = Math.min(
        selectedBitmap.height,
        Math.ceil(
          Number(verticalBounds.y) +
          Number(verticalBounds.height) + 4
        )
      );

      const cropWidth = cropRight - cropLeft;
      const cropHeight = cropBottom - cropTop;

      if (cropWidth <= 0 || cropHeight <= 0) {
        failures.push({
          line: lineIndex + 1,
          occurrence: occurrenceInLine,
          text: recordText,
          reason: "Invalid crop dimensions"
        });

        continue;
      }

      const card = document.createElement("div");

      card.style.cssText = [
        "box-sizing:border-box",
        "width:100%",
        "padding:12px",
        "border:1px solid #bbb",
        "border-radius:7px",
        "background:#fafafa",
        "overflow:hidden"
      ].join(";");

      const title = document.createElement("div");

      title.textContent =
        "Line " + (lineIndex + 1) +
        " | Occurrence " + occurrenceInLine +
        " | " + match[0];

      title.style.cssText =
        "font-weight:bold;margin-bottom:5px;";

      card.appendChild(title);

      const context = document.createElement("div");

      context.textContent = recordText;

      context.style.cssText =
        "font-size:12px;color:#555;margin-bottom:9px;" +
        "overflow-wrap:anywhere;";

      card.appendChild(context);

      const canvas = document.createElement("canvas");

      canvas.width = cropWidth * scale;
      canvas.height = cropHeight * scale;

      canvas.style.cssText =
        "display:block;max-width:100%;height:auto;" +
        "image-rendering:pixelated;border:1px solid #777;";

      const ctx = canvas.getContext("2d");

      if (!ctx) {
        failures.push({
          line: lineIndex + 1,
          occurrence: occurrenceInLine,
          text: recordText,
          reason: "Canvas context unavailable"
        });

        continue;
      }

      ctx.imageSmoothingEnabled = false;

      // Original image pixels.
      ctx.drawImage(
        selectedBitmap,
        cropLeft,
        cropTop,
        cropWidth,
        cropHeight,
        0,
        0,
        canvas.width,
        canvas.height
      );

      // Existing magenta character polygons.
      ctx.save();

      ctx.strokeStyle = "#e000ff";
      ctx.lineWidth = 0.9;
      ctx.lineJoin = "round";

      for (const glyph of glyphs) {
        const points = glyph.points;

        ctx.beginPath();

        ctx.moveTo(
          (points[0][0] - cropLeft) * scale,
          (points[0][1] - cropTop) * scale
        );

        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(
            (points[i][0] - cropLeft) * scale,
            (points[i][1] - cropTop) * scale
          );
        }

        ctx.closePath();
        ctx.stroke();
      }

      ctx.restore();

      card.appendChild(canvas);

      const heightDetails = tokens.map((character) => {
        const original = character.unrefinedCropHeight;
        const refined = character.refinedCropHeight;

        const originalText =
          Number.isFinite(original) ? original : "?";

        const refinedText =
          Number.isFinite(refined) ? refined : "?";

        return (
          String(character.text || "?") +
          ": " +
          originalText +
          " -> " +
          refinedText +
          " px" +
          " [" +
          (character.heightRefinement || "unknown") +
          "; components=" +
          (character.heightComponentCount ?? "?") +
          "]"
        );
      });

      const caption = document.createElement("div");

      caption.textContent =
        "Original -> refined heights: " +
        heightDetails.join(" | ");

      caption.style.cssText =
        "margin-top:9px;font-size:12px;overflow-wrap:anywhere;";

      card.appendChild(caption);

      grid.appendChild(card);

      renderedCount++;
    }
  }

  summary.textContent =
    "Occurrences found: " + occurrenceCount +
    " | Rendered: " + renderedCount +
    " | Not rendered: " + failures.length;

  if (occurrenceCount === 0) {
    const message = document.createElement("p");

    message.textContent =
      'No OCR text containing "procurement" was found.';

    panel.appendChild(message);
  }

  console.log(
    "[Step 24] Total procurement occurrences:",
    occurrenceCount
  );

  console.log(
    "[Step 24] Successfully rendered:",
    renderedCount
  );

  console.log(
    "[Step 24] Rendering failures:",
    failures
  );
}

/* -------------------------------------------------------
   OpenCV measurement worker communication
------------------------------------------------------- */

async function measureInkWithWorker(
  imageSource,
  jobs,
  options,
  onProgress
) {
  // Create a separate bitmap so the original selectedBitmap
  // remains available for preview drawing.
  const workerBitmap = await createImageBitmap(imageSource);

  let worker;

  try {
    worker = new Worker(
      "/workers/opencv-ink.worker.js"
    );
  } catch (error) {
    workerBitmap.close();
    throw error;
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    let bitmapTransferred = false;

    // Safety timeout for a worker that stops responding.
    // This does not reduce the number of measurements.
    const timeout = setTimeout(() => {
      finish(
        new Error(
          "OpenCV measurement worker did not finish within 30 minutes."
        )
      );
    }, 30 * 60 * 1000);

    function finish(error, value) {
      if (finished) return;

      finished = true;

      clearTimeout(timeout);

      worker.terminate();

      // If transfer never occurred, release the local bitmap.
      if (!bitmapTransferred) {
        workerBitmap.close();
      }

      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    }

   worker.onmessage = (event) => {
  const data = event.data || {};

  // Log every message received from the actual test worker.
  console.info(
    "[Paddle Test] OpenCV worker message:",
    data.type,
    data.details || data.message || ""
  );

  // OpenCV initialized inside the worker.
  if (data.type === "ready") {

    console.info(
      "[Paddle Test] OpenCV runtime capabilities:",
      data.details || {}
    );
        if (bitmapTransferred) return;

        try {
          worker.postMessage(
            {
              type: "measure",
              imageBitmap: workerBitmap,
              jobs,
              options,
            },
            [workerBitmap]
          );

          bitmapTransferred = true;

        } catch (error) {
          finish(error);
        }

        return;
      }

      // Progress from each processed OCR rectangle.
      if (data.type === "progress") {
        if (typeof onProgress === "function") {
          onProgress(
            data.completed,
            data.total
          );
        }

        return;
      }

      // All measurements completed.
      if (data.type === "complete") {
        finish(
          null,
          Array.isArray(data.results)
            ? data.results
            : []
        );

        return;
      }

      // OpenCV initialization or measurement error.
      if (data.type === "error") {
        finish(
          new Error(
            data.message || "Unknown OpenCV worker error."
          )
        );
      }
    };

    worker.onerror = (event) => {
      finish(
        new Error(
          event.message ||
          "OpenCV measurement worker execution failed."
        )
      );
    };

    worker.onmessageerror = () => {
      finish(
        new Error(
          "Could not read a message from the OpenCV worker."
        )
      );
    };
  });
}


function drawDetections(items, inkResults) {
  if (!selectedBitmap) return;

  const ctx = preview.getContext("2d");

  if (!ctx) {
    throw new Error("Could not create preview context.");
  }

  preview.width = selectedBitmap.width;
  preview.height = selectedBitmap.height;

  ctx.clearRect(0, 0, preview.width, preview.height);
  ctx.drawImage(selectedBitmap, 0, 0);

  // GREEN: text-line polygons returned by PaddleOCR.
  ctx.strokeStyle = "#00a651";
  ctx.lineWidth = 2;

  for (const item of items) {
    const points = getPolygonPoints(item.poly);

    if (points.length < 3) continue;

    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);

    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i][0], points[i][1]);
    }

    ctx.closePath();
    ctx.stroke();
  }

  // ORANGE: visible-ink rectangles measured by OpenCV.
  ctx.strokeStyle = "#ff6500";
  ctx.lineWidth = 2;

  for (const result of inkResults) {
    if (!result?.inkBounds) continue;

    const ink = result.inkBounds;

    ctx.strokeRect(
      ink.x,
      ink.y,
      ink.width,
      ink.height
    );
  }



  // BLUE: individual word regions proposed by segmentation.
  ctx.save();

  ctx.strokeStyle = "#008cff";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);

  for (const result of inkResults) {
    const words =
      result?.wordSegmentation?.words || [];

    for (const word of words) {
      const points = word.polygon;

      if (!Array.isArray(points) || points.length < 3) {
        continue;
      }

      ctx.beginPath();

      ctx.moveTo(points[0][0], points[0][1]);

      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
      }

      ctx.closePath();
      ctx.stroke();
    }
  }

  ctx.restore();



  // MAGENTA: individual character ink polygons measured by OpenCV.
  ctx.save();

  ctx.strokeStyle = "#e000ff";
  ctx.lineWidth = 0.65;
  ctx.setLineDash([]);

  let characterPolygonCount = 0;

  for (const result of inkResults) {
    const characters =
      result?.characterMeasurements?.characters || [];

    for (const character of characters) {
      if (
        character.status !== "measured" &&
        character.status !== "measured-low-pixel-count"
      ) {
        continue;
      }

      const points = character.polygon;

      if (
        !Array.isArray(points) ||
        points.length !== 4 ||
        !points.every(
          (point) =>
            Array.isArray(point) &&
            Number.isFinite(Number(point[0])) &&
            Number.isFinite(Number(point[1]))
        )
      ) {
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);

      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
      }

      ctx.closePath();
      ctx.stroke();

      characterPolygonCount++;
    }
  }

  ctx.restore();

  console.log(
    "Character polygons drawn:",
    characterPolygonCount
  );


  // STEP 22: Inspect vertical measurements in Procurement lines.
  const procurementDiagnostics = inkResults
    .map((record, lineIndex) => {
      if (!/procurement/i.test(String(record.text ?? ""))) {
        return null;
      }

      const characters =
        record.characterMeasurements?.characters || [];

      return {
        line: lineIndex + 1,
        text: record.text,
        measurementStatus:
          record.characterMeasurements?.status,

        characters: characters
          .filter((character) => character.status !== "space")
          .map((character) => ({
            index: character.index,
            character: character.text,

            status: character.status,

            centerX: Number(
              character.centerX?.toFixed?.(2) ??
              character.centerX
            ),

            estimatedRegion: character.estimatedRegion,

            inkBounds: character.inkBounds,

            cropBounds: character.cropBounds,

            heightRefinement: character.heightRefinement,
            heightComponentCount: character.heightComponentCount,

            originalHeight: character.unrefinedCropHeight,
            refinedHeight: character.refinedCropHeight,
            heightReduction: character.heightReductionPixels,

            pixelCount: character.pixelCount,
            acceptedComponents: character.acceptedComponents,
          }))
      };
    })
    .filter(Boolean);

  console.log("\\n========== PROCUREMENT HEIGHT DIAGNOSTICS ==========");

  console.log(
    "Matching OCR lines:",
    procurementDiagnostics.length
  );

  console.log(
    "PROCUREMENT CHARACTER TABLES:",
    procurementDiagnostics
  );

  for (const record of procurementDiagnostics) {
    console.log(
      "\\nLINE " + record.line + ": " + record.text
    );

    console.table(record.characters);
  }

  console.log(
    "FULL PROCUREMENT HEIGHT DATA:",
    JSON.stringify(procurementDiagnostics, null, 2)
  );

  console.log(
    "====================================================\\n"
  );

  renderCharacterZoomDiagnostics(inkResults);
  preview.hidden = false;
}

imageInput.addEventListener("change", async () => {
  selectedFile = imageInput.files?.[0] || null;
  runButton.disabled = true;
  resultsList.replaceChildren();
  preview.hidden = true;

  if (selectedBitmap) {
    selectedBitmap.close();
    selectedBitmap = null;
  }
  paddleEditorPageId = null;

  if (!selectedFile) {
    setStatus("Choose an image to begin.");
    return;
  }

  try {
   selectedBitmap = await createImageBitmap(selectedFile);

// Load the same original image into the editable document renderer.
const editorContext = await preparePaddleEditor(
  selectedFile
);

paddleEditorPageId = editorContext.page.id;

console.log(
  "[Paddle Editor] Image page registered:",
  {
    pageId: paddleEditorPageId,
    sourceWidth: editorContext.page.sourceWidth,
    sourceHeight: editorContext.page.sourceHeight,
    renderedWidth: editorContext.renderedPage.backgroundElement.naturalWidth,
    renderedHeight: editorContext.renderedPage.backgroundElement.naturalHeight,
  }
);

runButton.disabled = false;
    setStatus(
      `Image loaded successfully.\n` +
      `Dimensions: ${selectedBitmap.width} × ` +
      `${selectedBitmap.height}\n` +
      `Click "Run PaddleOCR + OpenCV" to begin.`
    );
  } catch (error) {
    setStatus(`Could not load image: ${error.message}`);
  }
});

runButton.textContent = "Run PaddleOCR + OpenCV";

runButton.addEventListener("click", async () => {
  if (!selectedFile || !selectedBitmap) {
    setStatus("Choose an image first.");
    return;
  }

  runButton.disabled = true;
  imageInput.disabled = true;
  resultsList.replaceChildren();

  let result;
  let inkResults = [];
  let openCVErrors = 0;

  try {
    const start = performance.now();

 setProgress("PaddleOCR: detecting and recognizing text", null);

setStatus(
  "PaddleOCR is running.\n" +
  "Its current inference percentage is not exposed by the SDK."
);

    result = await recognizeWithPaddleOCR(
      selectedFile,
      {
        lang: "en",
        ocrVersion: "PP-OCRv6",
      }
    );

// TEMPORARY: Validate PaddleOCR CTC character records.
const ctcDiagnostics = result.items.map((item, index) => {
  const characters = Array.isArray(item.characters)
    ? item.characters
    : [];

  const reconstructedText = characters
    .map((character) => String(character.text ?? ""))
    .join("");

  const validSpans = characters.every((character, charIndex) => {
    const start = character.startStep;
    const end = character.endStep;

    const validNumbers =
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 0 &&
      end >= start;

    const followsPrevious =
      charIndex === 0 ||
      start > characters[charIndex - 1].endStep;

    const validConfidence =
      Number.isFinite(character.meanScore);

    return validNumbers && followsPrevious && validConfidence;
  });

  return {
    line: index + 1,
    recognizedText: item.text,
    characterCount: characters.length,
    reconstructedText,
    textMatches: reconstructedText === item.text,
    validSpans,
  };
});

console.log("CTC CHARACTER DIAGNOSTICS:");
console.table(ctcDiagnostics);

const mismatches = ctcDiagnostics.filter(
  (item) => !item.textMatches || !item.validSpans
);

console.log(
  `CTC validation: ${ctcDiagnostics.length - mismatches.length}/${ctcDiagnostics.length} lines passed.`
);

console.log(
  "First five character records:",
  result.items.slice(0, 5).map((item) => ({
    text: item.text,
    characters: item.characters,
  }))
);

// STEP 11: Validate recognizer geometry metadata.
const geometryDiagnostics = result.items.map((item, index) => {
  const geometry = item.geometry ?? {};

  const characters = Array.isArray(item.characters)
    ? item.characters
    : [];

  const validDimensions =
    Number.isFinite(geometry.sourceWidth) &&
    Number.isFinite(geometry.sourceHeight) &&
    Number.isFinite(geometry.resizedWidth) &&
    Number.isFinite(geometry.inputWidth) &&
    Number.isFinite(geometry.timeSteps) &&
    geometry.sourceWidth > 0 &&
    geometry.sourceHeight > 0 &&
    geometry.resizedWidth > 0 &&
    geometry.inputWidth >= geometry.resizedWidth &&
    geometry.timeSteps > 0;

  const validCharacterSteps = characters.every((character) =>
    Number.isInteger(character.startStep) &&
    Number.isInteger(character.endStep) &&
    character.startStep >= 0 &&
    character.endStep >= character.startStep &&
    character.endStep < geometry.timeSteps
  );

  return {
    line: index + 1,
    text: item.text,
    sourceWidth: geometry.sourceWidth,
    sourceHeight: geometry.sourceHeight,
    resizedWidth: geometry.resizedWidth,
    inputWidth: geometry.inputWidth,
    timeSteps: geometry.timeSteps,
    characterCount: characters.length,
    validDimensions,
    validCharacterSteps,
  };
});

console.log("RECOGNIZER GEOMETRY DIAGNOSTICS:");
console.table(geometryDiagnostics);

const geometryFailures = geometryDiagnostics.filter(
  (item) =>
    !item.validDimensions ||
    !item.validCharacterSteps ||
    item.characterCount === 0
);

console.log(
  `Geometry validation: ${geometryDiagnostics.length - geometryFailures.length}/${geometryDiagnostics.length} lines passed.`
);

console.log(
  "FIRST FIVE GEOMETRY RECORDS:",
  geometryDiagnostics.slice(0, 5)
);

setProgress("OpenCV: measuring visible ink", 0);

setStatus(
  `PaddleOCR detected ${result.items.length} text lines.\n` +
  "OpenCV is measuring each detected line."
);

   
const jobs = [];

const lineRecords = result.items.map((item, index) => {
  const points = getPolygonPoints(item.poly);
  const ocrBounds = polygonToBounds(points);

  if (ocrBounds) {
    jobs.push({
      index,
      text: String(item.text ?? ""),
      score: Number(item.score ?? 0),

      // CTC character timing records from PaddleOCR.
      characters: Array.isArray(item.characters) ? item.characters : [],
      geometry: item.geometry ?? null,
        cropGeometry: item.cropGeometry ?? null,

      // Original PaddleOCR line polygon.
      points,

      // Existing axis-aligned OCR rectangle.
      bounds: ocrBounds,
    });
  }

return {
  text: item.text,
  score: item.score,

  // Preserve original PaddleOCR geometry.
  poly: item.poly ?? null,
  points,

  // Preserve character timing data.
  characters: Array.isArray(item.characters)
    ? item.characters
    : [],

  geometry: item.geometry ?? null,
  cropGeometry: item.cropGeometry ?? null,

  ocrBounds,
    inkBounds: null,
    wordSegmentation: null,
    errorMessage: null,
    characterMeasurements: null,
    characterMeasurementError: null,
  };
});

// ==========================================================
// TEMPORARY: ORIGINAL PADDLEOCR LINE-CROP GEOMETRY AUDIT
// ==========================================================

const lineGeometryTargets = [
  "202-555-0120",
  "Feb 2020 - Aug 2023",
  "Aug 2013 - Apr 2016",
];

function calculateGeometryBounds(points) {
  if (!Array.isArray(points) || points.length < 3) {
    return null;
  }

  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);

  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

window.__PADDLE_LINE_GEOMETRY_DEBUG__ =
  lineGeometryTargets.map(targetText => {
    const lineIndex = lineRecords.findIndex(
      record => record.text === targetText
    );

    const record = lineRecords[lineIndex];

    if (!record) {
      return {
        text: targetText,
        found: false,
      };
    }

    const crop = record.cropGeometry || {};
    const geometry = record.geometry || {};

    const polygon = getPolygonPoints(record.poly).map(
      ([x, y]) => ({ x, y })
    );

    const orderedCorners = Array.isArray(crop.ordered)
      ? crop.ordered.map(point => ({
          x: Number(point[0]),
          y: Number(point[1]),
        }))
      : [];

    return {
      found: true,

      lineIndex,
      text: record.text,
      score: record.score,

      // Original PaddleOCR detection geometry.
      paddlePolygon: polygon,
      paddlePolygonBounds: calculateGeometryBounds(polygon),
      paddleRectBounds: record.ocrBounds,

      // Exact crop geometry supplied by PaddleOCR engine.
      cropOrderedCorners: orderedCorners,
      cropCornerBounds: calculateGeometryBounds(orderedCorners),

      cropWidth: crop.cropWidth ?? null,
      cropHeight: crop.cropHeight ?? null,

      rotated: crop.rotated ?? null,

      finalWidth: crop.finalWidth ?? null,
      finalHeight: crop.finalHeight ?? null,

      // Recognition geometry.
      recognizerSourceWidth: geometry.sourceWidth ?? null,
      recognizerSourceHeight: geometry.sourceHeight ?? null,

      resizedWidth: geometry.resizedWidth ?? null,
      inputWidth: geometry.inputWidth ?? null,
      timeSteps: geometry.timeSteps ?? null,

      cropGeometryKeys: Object.keys(crop),
      recognizerGeometryKeys: Object.keys(geometry),
    };
  });

console.group("[Original PaddleOCR Line Crop Geometry Audit]");

console.table(
  window.__PADDLE_LINE_GEOMETRY_DEBUG__.map(item => ({
    lineIndex: item.lineIndex,
    text: item.text,
    found: item.found,

    polygonBounds: item.paddlePolygonBounds
      ? JSON.stringify(item.paddlePolygonBounds)
      : null,

    cropCornerBounds: item.cropCornerBounds
      ? JSON.stringify(item.cropCornerBounds)
      : null,

    cropWidth: item.cropWidth,
    cropHeight: item.cropHeight,

    rotated: item.rotated,

    finalWidth: item.finalWidth,
    finalHeight: item.finalHeight,
  }))
);

for (const item of window.__PADDLE_LINE_GEOMETRY_DEBUG__) {
  console.log(
    `[Original Line Geometry] ${item.text}`,
    item
  );
}

console.groupEnd();

// ==========================================================
// STEP 17: Validate exact PaddleOCR crop geometry.
const cropGeometryDiagnostics = result.items.map((item, index) => {
  const crop = item.cropGeometry;
  const recognition = item.geometry;

  const orderedValid =
    Array.isArray(crop?.ordered) &&
    crop.ordered.length === 4 &&
    crop.ordered.every(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        Number.isFinite(Number(point[0])) &&
        Number.isFinite(Number(point[1]))
    );

  const cropDimensionsValid =
    Number.isInteger(crop?.cropWidth) &&
    crop.cropWidth > 0 &&
    Number.isInteger(crop?.cropHeight) &&
    crop.cropHeight > 0;

  const rotationDimensionsValid =
    cropDimensionsValid &&
    typeof crop?.rotated === "boolean" &&
    Number(crop.finalWidth) ===
      (crop.rotated ? crop.cropHeight : crop.cropWidth) &&
    Number(crop.finalHeight) ===
      (crop.rotated ? crop.cropWidth : crop.cropHeight);

  const recognizerDimensionsMatch =
    !!recognition &&
    Number(crop?.finalWidth) === Number(recognition.sourceWidth) &&
    Number(crop?.finalHeight) === Number(recognition.sourceHeight);

  const passed =
    orderedValid &&
    cropDimensionsValid &&
    rotationDimensionsValid &&
    recognizerDimensionsMatch;

  return {
    index,
    text: String(item.text ?? "").slice(0, 55),
    hasCropGeometry: !!crop,
    orderedValid,
    cropDimensionsValid,
    rotationDimensionsValid,
    recognizerDimensionsMatch,
    rotated: crop?.rotated ?? null,
    cropWidth: crop?.cropWidth ?? null,
    cropHeight: crop?.cropHeight ?? null,
    finalWidth: crop?.finalWidth ?? null,
    finalHeight: crop?.finalHeight ?? null,
    sourceWidth: recognition?.sourceWidth ?? null,
    sourceHeight: recognition?.sourceHeight ?? null,
    passed
  };
});

const cropGeometryPassed =
  cropGeometryDiagnostics.filter((item) => item.passed);

const cropGeometryFailed =
  cropGeometryDiagnostics.filter((item) => !item.passed);

const rotatedCropCount =
  cropGeometryDiagnostics.filter((item) => item.rotated === true).length;

const workerJobsWithCropGeometry =
  jobs.filter((job) => !!job.cropGeometry).length;

console.log("\n========== CROP GEOMETRY DIAGNOSTICS SUMMARY ==========");
console.log("Total OCR lines:", cropGeometryDiagnostics.length);
console.log("Lines with valid crop geometry:", cropGeometryPassed.length);
console.log("Lines failed:", cropGeometryFailed.length);
console.log("Rotated crops:", rotatedCropCount);
console.log("Worker jobs:", jobs.length);
console.log("Worker jobs with crop geometry:", workerJobsWithCropGeometry);

console.log(
  "Valid ordered corner sets:",
  cropGeometryDiagnostics.filter((item) => item.orderedValid).length
);

console.log(
  "Valid crop dimensions:",
  cropGeometryDiagnostics.filter((item) => item.cropDimensionsValid).length
);

console.log(
  "Valid rotation dimensions:",
  cropGeometryDiagnostics.filter((item) => item.rotationDimensionsValid).length
);

console.log(
  "Recognizer dimension matches:",
  cropGeometryDiagnostics.filter(
    (item) => item.recognizerDimensionsMatch
  ).length
);

console.log(
  "FIRST FIVE CROP GEOMETRY RECORDS:",
  cropGeometryDiagnostics.slice(0, 5)
);

console.log(
  "CROP GEOMETRY FAILURES:",
  cropGeometryFailed
);

console.log("=======================================================\n");

// STEP 13: Validate CTC character center coordinates.
const characterCenterDiagnostics = jobs.slice(0, 5).map((job) => {
  const geometry = job.geometry;
  const characters = Array.isArray(job.characters)
    ? job.characters
    : [];

  if (
    !geometry ||
    !geometry.timeSteps ||
    !geometry.inputWidth ||
    !geometry.resizedWidth ||
    !geometry.sourceWidth
  ) {
    return {
      line: job.index + 1,
      error: "Missing recognizer geometry",
    };
  }

  const stepScale =
    geometry.inputWidth / geometry.timeSteps;

  const cropScale =
    geometry.sourceWidth / geometry.resizedWidth;

  const centers = characters.map((character) => {
    const stepCenter =
      (character.startStep + character.endStep + 1) / 2;

    const recognizerX =
      stepCenter * stepScale;

    const cropX =
      recognizerX * cropScale;

    return {
      character: character.text,
      startStep: character.startStep,
      endStep: character.endStep,
      recognizerX: Number(recognizerX.toFixed(2)),
      cropX: Number(cropX.toFixed(2)),
      insideContent:
        recognizerX >= 0 &&
        recognizerX <= geometry.resizedWidth,
    };
  });

  const strictlyIncreasing = centers.every(
    (center, index) =>
      index === 0 ||
      center.cropX > centers[index - 1].cropX
  );

  const allInsideContent = centers.every(
    (center) => center.insideContent
  );

  return {
    line: job.index + 1,
    text: job.text,
    sourceWidth: geometry.sourceWidth,
    resizedWidth: geometry.resizedWidth,
    inputWidth: geometry.inputWidth,
    timeSteps: geometry.timeSteps,
    strictlyIncreasing,
    allInsideContent,
    centers: centers.slice(0, 12),
  };
});

console.log(
  "CHARACTER CENTER COORDINATE DIAGNOSTICS:",
  characterCenterDiagnostics
);

console.log(
  "FULL CHARACTER CENTER DATA:",
  JSON.stringify(characterCenterDiagnostics, null, 2)
);

console.log(
  "CHARACTER CENTER TABLE:",
  characterCenterDiagnostics.map((line) => ({
    line: line.line,
    text: line.text,
    strictlyIncreasing: line.strictlyIncreasing,
    allInsideContent: line.allInsideContent,
    firstCenters: line.centers,
  }))
);

// STEP 14: Estimate individual character regions.
// Spaces participate in boundary calculations but
// are excluded from the final glyph regions.

function calculateCharacterIntervals(job) {
  const geometry = job.geometry;
  const characters = Array.isArray(job.characters)
    ? job.characters
    : [];

  if (!geometry || characters.length === 0) {
    return {
      status: "missing-data",
      characters: [],
    };
  }

  const stepScale =
    geometry.inputWidth / geometry.timeSteps;

  const cropScale =
    geometry.sourceWidth / geometry.resizedWidth;

  // Calculate each character's approximate center
  // in the original PaddleOCR recognition crop.
  const centers = characters.map((character) => {
    const stepCenter =
      (character.startStep + character.endStep + 1) / 2;

    return stepCenter * stepScale * cropScale;
  });

  // Validate that all center positions are ordered.
  for (let i = 1; i < centers.length; i++) {
    if (centers[i] <= centers[i - 1]) {
      return {
        status: "invalid-center-order",
        characters: [],
      };
    }
  }

  const boundaries = new Array(characters.length + 1);

  // Include the full crop boundaries.
  boundaries[0] = 0;
  boundaries[characters.length] = geometry.sourceWidth;

  // Calculate midpoint boundaries between tokens.
  for (let i = 1; i < characters.length; i++) {
    boundaries[i] =
      (centers[i - 1] + centers[i]) / 2;
  }

  const regions = characters.map((character, index) => {
    const left = boundaries[index];
    const right = boundaries[index + 1];

    return {
      index,
      text: character.text,
      centerX: centers[index],

      left,
      right,
      width: right - left,

      meanScore: character.meanScore,

      isSpace: /^\s+$/u.test(
        String(character.text ?? "")
      ),
    };
  });

  const invalidRegions = regions.filter(
    (region) =>
      !Number.isFinite(region.left) ||
      !Number.isFinite(region.right) ||
      region.width <= 0 ||
      region.left < 0 ||
      region.right > geometry.sourceWidth
  );

  return {
    status: invalidRegions.length === 0
      ? "estimated"
      : "invalid-regions",

    cropWidth: geometry.sourceWidth,
    characters: regions.filter(
      (region) => !region.isSpace
    ),

    tokenCount: regions.length,
    spaceCount: regions.filter(
      (region) => region.isSpace
    ).length,

    invalidCount: invalidRegions.length,
  };
}

// Calculate regions for the first five lines.
const characterRegionDiagnostics = jobs
  .slice(0, 5)
  .map((job) => {
    const result = calculateCharacterIntervals(job);

    return {
      line: job.index + 1,
      text: job.text,
      status: result.status,
      cropWidth: result.cropWidth,
      tokenCount: result.tokenCount,
      spaceCount: result.spaceCount,
      characterCount: result.characters.length,
      invalidCount: result.invalidCount,

      // Display the first 15 glyph regions.
      regions: result.characters.slice(0, 15),
    };
  });

console.log(
  "CHARACTER REGION DIAGNOSTICS:",
  characterRegionDiagnostics
);

console.log(
  "FULL CHARACTER REGIONS:",
  JSON.stringify(characterRegionDiagnostics, null, 2)
);

setProgress(
  "OpenCV worker: initializing and measuring",
  null
);

setStatus(
  `PaddleOCR detected ${result.items.length} text lines.\n` +
  `Sending ${jobs.length} rectangles to the OpenCV worker.\n` +
  `OpenCV processing is running in the background worker.`
);

if (jobs.length > 0) {

console.table(
  jobs.map(({ index, text }) => ({
    lineIndex: index,
    text,
  }))
);

  const workerResults = await measureInkWithWorker(
    selectedBitmap,
    jobs,
   {
  padding: 4,
  minComponentArea: 2,

  // Extract original glyph shapes from every valid OCR line.
  originalGlyphShapeLineIndices:
    jobs.map(job => job.index),
},
    (completed, total) => {
      const percent =
        total > 0
          ? (completed / total) * 100
          : 100;

      setProgress(
        `OpenCV worker: line ${completed} of ${total}`,
        percent
      );

      setStatus(
        `PaddleOCR completed.\n` +
        `OpenCV worker measurements: ${completed}/${total} lines processed.`
      );
    }
  );
// =====================================================
// FULL-DOCUMENT ORIGINAL GLYPH EXTRACTION AUDIT
// =====================================================

const fullDocumentGlyphAudit = workerResults.map(
  workerResult => {
    const measurement =
      workerResult.characterMeasurements;

    const extraction =
      measurement?.originalGlyphShapeExtraction ??
      workerResult.originalGlyphShapeExtraction ??
      null;

    const summary =
      measurement?.originalGlyphShapeSummary ??
      null;

    return {
      lineIndex: workerResult.index,

      text:
        jobs.find(job => job.index === workerResult.index)?.text ?? "",

      extractionStatus:
        summary?.status ??
        extraction?.status ??
        "missing",

      extractedGlyphCount:
        summary?.extractedGlyphCount ??
        extraction?.extractedGlyphCount ??
        0,

      emptyGlyphCount:
        summary?.emptyGlyphCount ?? 0,

      integrityFailures:
        summary?.integrityFailures ??
        extraction?.integrityFailures ??
        null,

      extractionPresent: !!extraction,
    };
  }
);

console.group(
  "[Full Document Original Glyph Extraction Audit]"
);

console.table(fullDocumentGlyphAudit);

console.log(
  "Total OCR lines:",
  fullDocumentGlyphAudit.length
);

console.log(
  "Lines with extraction objects:",
  fullDocumentGlyphAudit.filter(
    row => row.extractionPresent
  ).length
);

console.log(
  "Total extracted glyphs:",
  fullDocumentGlyphAudit.reduce(
    (sum, row) => sum + row.extractedGlyphCount,
    0
  )
);

console.log(
  "Total integrity failures:",
  fullDocumentGlyphAudit.reduce(
    (sum, row) => sum + (row.integrityFailures ?? 0),
    0
  )
);


/*
 * DOCUMENT GLYPH LIBRARY
 *
 * Collects every original glyph occurrence from all worker results.
 * Preserves:
 *   - Visible glyphs and whitespace slots
 *   - Original RGBA pixel data
 *   - Original binary masks
 *   - Glyph and cell coordinates
 *   - SVG paths and contour diagnostics
 *   - Source OCR line and crop metadata
 *
 * Does not deduplicate or modify the extracted glyphs.
 */

// ------------------------------------------------------------
// 1. SAFE DATA HELPERS
// ------------------------------------------------------------

function glyphLibraryClonePlain(value) {
  if (value === undefined || value === null) {
    return value ?? null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    console.warn(
      "[Document Glyph Library] Could not clone metadata:",
      error
    );
    return null;
  }
}

function glyphLibraryCopyTypedArray(value) {
  if (!ArrayBuffer.isView(value)) {
    return null;
  }

  return value.slice();
}

function glyphLibraryBytesToBase64(value) {
  if (!ArrayBuffer.isView(value)) {
    return null;
  }

  const bytes = new Uint8Array(
    value.buffer,
    value.byteOffset,
    value.byteLength
  );

  const chunkSize = 0x8000;
  let binary = "";

  for (
    let offset = 0;
    offset < bytes.length;
    offset += chunkSize
  ) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + chunkSize, bytes.length)
    );

    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

// ------------------------------------------------------------
// 2. INDEX SOURCE OCR JOBS
// ------------------------------------------------------------

const glyphLibraryJobsByIndex = new Map(
  jobs.map(job => [job.index, job])
);

// ------------------------------------------------------------
// 3. COLLECT EVERY LINE AND GLYPH
// ------------------------------------------------------------

const documentGlyphLibraryLines = [];

let libraryTotalGlyphRecords = 0;
let libraryTotalExtractedGlyphs = 0;
let libraryTotalWhitespaceSlots = 0;
let libraryTotalNoVisibleInkGlyphs = 0;
let libraryTotalGlyphsWithPixelData = 0;
let libraryTotalMissingPixelData = 0;
let libraryTotalMaskBytes = 0;
let libraryTotalRgbaBytes = 0;
let libraryTotalAppearanceRgbaBytes = 0;
let libraryTotalGlyphsWithAppearanceData = 0;
let libraryTotalMissingAppearanceData = 0;
let libraryTotalIntegrityFailures = 0;
let libraryLinesWithExtraction = 0;
let libraryLinesMissingExtraction = 0;

const glyphLibraryDiscrepancies = [];

for (const workerResult of workerResults) {
  const lineIndex = workerResult.index;

  const job = glyphLibraryJobsByIndex.get(lineIndex) ?? null;

  const measurement =
    workerResult.characterMeasurements ?? null;

  const extraction =
    measurement?.originalGlyphShapeExtraction ??
    workerResult.originalGlyphShapeExtraction ??
    null;

  if (!extraction) {
    libraryLinesMissingExtraction++;

    documentGlyphLibraryLines.push({
      lineIndex,
      text: job?.text ?? "",
      extractionStatus: "missing",
      glyphs: [],
    });

    continue;
  }

  libraryLinesWithExtraction++;

  const sourceGlyphs = Array.isArray(extraction.glyphs)
    ? extraction.glyphs
    : [];

  const lineGlyphs = [];

  let lineExtractedCount = 0;
  let lineWhitespaceCount = 0;
  let lineMissingPixelData = 0;

  for (
    let glyphPosition = 0;
    glyphPosition < sourceGlyphs.length;
    glyphPosition++
  ) {
    const sourceGlyph = sourceGlyphs[glyphPosition];

    const glyphIndex = Number.isInteger(sourceGlyph.index)
      ? sourceGlyph.index
      : glyphPosition;

    const character = String(sourceGlyph.text ?? "");

    const status = String(
      sourceGlyph.status ?? "unknown"
    );

    const mask = glyphLibraryCopyTypedArray(
      sourceGlyph.mask
    );

    const rgba = glyphLibraryCopyTypedArray(
      sourceGlyph.rgba
    );

// Preserve the independent original-grayscale appearance crop.
const appearanceCandidate = glyphLibraryCopyTypedArray(
  sourceGlyph.appearanceRgba
);

const appearanceWidth = Number(
  sourceGlyph.appearanceWidth ?? 0
);

const appearanceHeight = Number(
  sourceGlyph.appearanceHeight ?? 0
);

const hasAppearanceData =
  appearanceCandidate !== null &&
  Number.isInteger(appearanceWidth) &&
  Number.isInteger(appearanceHeight) &&
  appearanceWidth > 0 &&
  appearanceHeight > 0 &&
  appearanceCandidate.length ===
    appearanceWidth * appearanceHeight * 4;

const appearanceRgba = hasAppearanceData
  ? appearanceCandidate
  : null;

    const hasPixelData =
      mask !== null &&
      rgba !== null &&
      mask.length > 0 &&
      rgba.length > 0;

    const isWhitespace =
      status === "space" ||
      /^\s+$/u.test(character);

    if (status === "complete") {
      lineExtractedCount++;
      libraryTotalExtractedGlyphs++;
    }

    if (isWhitespace) {
      lineWhitespaceCount++;
      libraryTotalWhitespaceSlots++;
    }

    if (status === "no-visible-ink") {
      libraryTotalNoVisibleInkGlyphs++;
    }

    if (status === "complete") {
  if (hasAppearanceData) {
    libraryTotalGlyphsWithAppearanceData++;

    libraryTotalAppearanceRgbaBytes +=
      appearanceRgba.byteLength;
  } else {
    libraryTotalMissingAppearanceData++;
  }
}

    if (hasPixelData) {
      libraryTotalGlyphsWithPixelData++;

      libraryTotalMaskBytes += mask.byteLength;
      libraryTotalRgbaBytes += rgba.byteLength;
    } else if (!isWhitespace) {
      lineMissingPixelData++;
      libraryTotalMissingPixelData++;
    }

    lineGlyphs.push({
      glyphId: `${lineIndex}:${glyphIndex}`,

      lineIndex,
      glyphIndex,
      occurrenceIndex: glyphPosition,

      character,
      status,
      isWhitespace,
      hasPixelData,

      width: Number(sourceGlyph.width ?? 0),
      height: Number(sourceGlyph.height ?? 0),

      // Preserve original geometry.
      cellBounds: glyphLibraryClonePlain(
        sourceGlyph.cellBounds
      ),

      cropBounds: glyphLibraryClonePlain(
        sourceGlyph.cropBounds
      ),

      svgViewBox: sourceGlyph.svgViewBox ?? null,

      // Preserve original pixel data as typed arrays.
      // These are copied so the library owns its pixel data.
      mask,
      rgba,

      maskFormat: mask ? "GRAY8" : null,
      rgbaFormat: rgba ? "RGBA8" : null,

      maskByteLength: mask?.byteLength ?? 0,
      rgbaByteLength: rgba?.byteLength ?? 0,

// Independent original grayscale appearance representation.
appearanceRgba,

appearanceWidth,
appearanceHeight,

appearanceCropBounds: glyphLibraryClonePlain(
  sourceGlyph.appearanceCropBounds
),

appearanceContextPadding:
  sourceGlyph.appearanceContextPadding ?? null,

appearanceMethod:
  sourceGlyph.appearanceMethod ?? null,

appearanceStatus:
  sourceGlyph.appearanceStatus ?? "missing",

appearanceFormat:
  appearanceRgba ? "RGBA8" : null,

appearanceByteLength:
  appearanceRgba?.byteLength ?? 0,

hasAppearanceData,

      pixelCount: Number(sourceGlyph.pixelCount ?? 0),

      contourCount: Number(sourceGlyph.contourCount ?? 0),
      contourPointCount: Number(
        sourceGlyph.contourPointCount ?? 0
      ),
      holeCount: Number(sourceGlyph.holeCount ?? 0),

      pixelBoundaryLoopCount: Number(
        sourceGlyph.pixelBoundaryLoopCount ?? 0
      ),

      pixelBoundaryEdgeCount: Number(
        sourceGlyph.pixelBoundaryEdgeCount ?? 0
      ),

      pixelBoundaryIncompleteLoopCount: Number(
        sourceGlyph.pixelBoundaryIncompleteLoopCount ?? 0
      ),

      pixelBoundaryUntracedEdgeCount: Number(
        sourceGlyph.pixelBoundaryUntracedEdgeCount ?? 0
      ),

      // Preserve vector representations.
      contourSvgPath: sourceGlyph.contourSvgPath ?? null,

      opencvContourSvgPath:
        sourceGlyph.opencvContourSvgPath ?? null,

      pixelBoundaryContourSvgPath:
        sourceGlyph.pixelBoundaryContourSvgPath ?? null,

      pixelCellSvgPath:
        sourceGlyph.pixelCellSvgPath ?? null,

      maskSource: sourceGlyph.maskSource ?? null,
    });
  }

  libraryTotalGlyphRecords += lineGlyphs.length;

  const reportedExtractedCount = Number(
    extraction.extractedGlyphCount ?? 0
  );

  if (lineExtractedCount !== reportedExtractedCount) {
    glyphLibraryDiscrepancies.push({
      lineIndex,
      issue: "extracted-glyph-count-mismatch",
      reported: reportedExtractedCount,
      collected: lineExtractedCount,
    });
  }

  const reportedIntegrityFailures = Number(
    extraction.integrityFailures ?? 0
  );

  libraryTotalIntegrityFailures +=
    reportedIntegrityFailures;

  documentGlyphLibraryLines.push({
    lineIndex,

    text: job?.text ?? "",

    ocrScore: job?.score ?? null,

    extractionStatus: extraction.status ?? "unknown",

    coordinateSpace:
      extraction.coordinateSpace ?? null,

    maskSource:
      extraction.maskSource ?? null,

    extractionSummary: {
      tokenCount: extraction.tokenCount ?? null,

      extractedGlyphCount:
        extraction.extractedGlyphCount ?? 0,

      emptyGlyphCount:
        extraction.emptyGlyphCount ?? 0,

      totalMaskPixels:
        extraction.totalMaskPixels ?? 0,

      totalContours:
        extraction.totalContours ?? 0,

      totalContourPoints:
        extraction.totalContourPoints ?? 0,

      totalHoles:
        extraction.totalHoles ?? 0,

      totalPixelBoundaryLoops:
        extraction.totalPixelBoundaryLoops ?? 0,

      totalPixelBoundaryEdges:
        extraction.totalPixelBoundaryEdges ?? 0,

      incompletePixelBoundaryLoops:
        extraction.incompletePixelBoundaryLoops ?? 0,

      integrityFailures:
        extraction.integrityFailures ?? 0,
    },

    // Preserve source-line geometry and OCR timing information.
    // This is important for later page positioning and advances.
    source: {
      jobMetadata: glyphLibraryClonePlain(job),

      inkBounds: glyphLibraryClonePlain(
        workerResult.inkBounds
      ),

      measurementCrop: glyphLibraryClonePlain(
        measurement?.crop
      ),

      cropGeometry: glyphLibraryClonePlain(
        job?.cropGeometry
      ),

      characterTimings: glyphLibraryClonePlain(
        job?.characterTimings
      ),

      wordSegmentation: glyphLibraryClonePlain(
        workerResult.wordSegmentation
      ),
    },

    glyphs: lineGlyphs,
  });

  if (lineMissingPixelData > 0) {
    console.warn(
      "[Document Glyph Library] Non-space glyphs missing pixel data:",
      {
        lineIndex,
        text: job?.text ?? "",
        count: lineMissingPixelData,
      }
    );
  }
}

// ------------------------------------------------------------
// 4. BUILD DOCUMENT-LEVEL LIBRARY
// ------------------------------------------------------------

const documentGlyphLibrary = {
  schema: "document-original-glyph-library",
  version: 1,

  documentId: `document-${Date.now()}`,

  createdAt: new Date().toISOString(),

  extractionMethod: "opencv-ctc-cell-mask-contours",

  coordinateSpace: "paddle-final-rectified-crop",

  pixelDataEncoding: "typed-arrays-in-memory",

  summary: {
    workerLineCount: workerResults.length,

    linesWithExtraction:
      libraryLinesWithExtraction,

    linesMissingExtraction:
      libraryLinesMissingExtraction,

    totalGlyphRecords:
      libraryTotalGlyphRecords,

    totalExtractedGlyphs:
      libraryTotalExtractedGlyphs,

    totalWhitespaceSlots:
      libraryTotalWhitespaceSlots,

    totalNoVisibleInkGlyphs:
      libraryTotalNoVisibleInkGlyphs,

    totalGlyphsWithPixelData:
      libraryTotalGlyphsWithPixelData,

    totalNonSpaceGlyphsMissingPixelData:
      libraryTotalMissingPixelData,

    totalMaskBytes:
      libraryTotalMaskBytes,

    totalRgbaBytes:
      libraryTotalRgbaBytes,

      totalAppearanceRgbaBytes:
  libraryTotalAppearanceRgbaBytes,

totalGlyphsWithAppearanceData:
  libraryTotalGlyphsWithAppearanceData,

totalMissingAppearanceData:
  libraryTotalMissingAppearanceData,

    totalBinaryBytes:
      libraryTotalMaskBytes + libraryTotalRgbaBytes,

    totalIntegrityFailures:
      libraryTotalIntegrityFailures,

    countDiscrepancies:
      glyphLibraryDiscrepancies.length,
  },

  validation: {
    allWorkerLinesCollected:
      libraryLinesWithExtraction === workerResults.length,

    noMissingExtractions:
      libraryLinesMissingExtraction === 0,

    noIntegrityFailures:
      libraryTotalIntegrityFailures === 0,

      allCompleteGlyphsHaveAppearanceData:
  libraryTotalMissingAppearanceData === 0,

    noCountDiscrepancies:
      glyphLibraryDiscrepancies.length === 0,

    noMissingNonSpacePixelData:
      libraryTotalMissingPixelData === 0,
  },

  discrepancies: glyphLibraryDiscrepancies,

  lines: documentGlyphLibraryLines,
};

// Keep the library accessible from the browser console.
window.__DOCUMENT_GLYPH_LIBRARY__ =
  documentGlyphLibrary;

// ------------------------------------------------------------
// 5. PRINT LIBRARY VALIDATION
// ------------------------------------------------------------

console.log(
  "[Document Glyph Library] Inventory created:",
  documentGlyphLibrary.summary
);

console.log(
  "[Document Glyph Library] Validation:",
  documentGlyphLibrary.validation
);

console.log(
  "[Document Glyph Library] First line sample:",
  {
    lineIndex:
      documentGlyphLibrary.lines[0]?.lineIndex,

    text:
      documentGlyphLibrary.lines[0]?.text,

    glyphRecordCount:
      documentGlyphLibrary.lines[0]?.glyphs.length,

    glyphs:
      documentGlyphLibrary.lines[0]?.glyphs.map(glyph => ({
        glyphId: glyph.glyphId,
        character: glyph.character,
        status: glyph.status,
        width: glyph.width,
        height: glyph.height,
        maskByteLength: glyph.maskByteLength,
        rgbaByteLength: glyph.rgbaByteLength,
        cellBounds: glyph.cellBounds,
        cropBounds: glyph.cropBounds,
      })),
  }
);

// ------------------------------------------------------------
// 6. CREATE A JSON EXPORT WITH BASE64 PIXEL DATA
// ------------------------------------------------------------

function createExportableDocumentGlyphLibrary(library) {
  return {
    ...library,

    pixelDataEncoding: "base64",

    lines: library.lines.map(line => ({
      ...line,

      glyphs: line.glyphs.map(glyph => ({
        ...glyph,

        mask: glyph.mask
          ? {
              encoding: "base64",
              data: glyphLibraryBytesToBase64(glyph.mask),
              byteLength: glyph.mask.byteLength,
              typedArray: glyph.mask.constructor.name,
            }
          : null,

        rgba: glyph.rgba
          ? {
              encoding: "base64",
              data: glyphLibraryBytesToBase64(glyph.rgba),
              byteLength: glyph.rgba.byteLength,
              typedArray: glyph.rgba.constructor.name,
            }
          : null,

appearanceRgba: glyph.appearanceRgba
  ? {
      encoding: "base64",
      data: glyphLibraryBytesToBase64(
        glyph.appearanceRgba
      ),
      byteLength: glyph.appearanceRgba.byteLength,
      typedArray: glyph.appearanceRgba.constructor.name,
    }
  : null,

      })),
    })),
  };
}

// ------------------------------------------------------------
// 7. DOWNLOAD FUNCTION
// ------------------------------------------------------------

window.downloadDocumentGlyphLibrary = function () {
  const library = window.__DOCUMENT_GLYPH_LIBRARY__;

  if (!library || !Array.isArray(library.lines)) {
    console.error(
      "[Document Glyph Library] Library is unavailable."
    );
    return;
  }

  console.log(
    "[Document Glyph Library] Preparing JSON export..."
  );

  const exportData =
    createExportableDocumentGlyphLibrary(library);

  const json = JSON.stringify(exportData);

  const blob = new Blob(
    [json],
    { type: "application/json;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");

  anchor.href = url;

  anchor.download =
    `document-glyph-library-${Date.now()}.json`;

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 2000);

  console.log(
    "[Document Glyph Library] JSON export started:",
    {
      fileName: anchor.download,
      jsonBytes: new Blob([json]).size,
      glyphRecords: library.summary.totalGlyphRecords,
      extractedGlyphs: library.summary.totalExtractedGlyphs,
    }
  );
};

console.log(
  "[Document Glyph Library] Ready.",
  "Run downloadDocumentGlyphLibrary() in the browser console to export."
);


/*
 * DOCUMENT CHARACTER INDEX
 *
 * Groups all original glyph occurrences by exact character.
 * Keeps every specimen independent.
 * Does not duplicate or modify pixel data.
 */

// ------------------------------------------------------------
// 1. GET THE VERIFIED DOCUMENT LIBRARY
// ------------------------------------------------------------

const sourceLibrary = window.__DOCUMENT_GLYPH_LIBRARY__;

if (
  !sourceLibrary ||
  !Array.isArray(sourceLibrary.lines)
) {
  throw new Error(
    "[Character Index] Document glyph library is unavailable."
  );
}

const occurrencesByCharacter = Object.create(null);
const glyphRecordsById = new Map();

const lineHeightCounts = new Map();

let totalOccurrences = 0;
let visibleOccurrences = 0;
let whitespaceOccurrences = 0;

let missingAlignmentCount = 0;
let alignmentLengthMismatchCount = 0;
let alignmentCharacterMismatchCount = 0;

const alignmentIssues = [];

// ------------------------------------------------------------
// 2. COLLECT EVERY CHARACTER OCCURRENCE
// ------------------------------------------------------------

for (const line of sourceLibrary.lines) {
  const lineIndex = line.lineIndex;

  const jobMetadata =
    line.source?.jobMetadata ?? {};

  const ctcCharacters =
    Array.isArray(jobMetadata.characters)
      ? jobMetadata.characters
      : [];

  const lineHeight = Number(
    jobMetadata.geometry?.sourceHeight ??
    line.source?.cropGeometry?.finalHeight ??
    line.source?.measurementCrop?.height ??
    0
  );

  lineHeightCounts.set(
    lineHeight,
    (lineHeightCounts.get(lineHeight) ?? 0) + 1
  );

  if (ctcCharacters.length !== line.glyphs.length) {
    alignmentLengthMismatchCount++;

    alignmentIssues.push({
      lineIndex,
      issue: "alignment-length-mismatch",
      glyphCount: line.glyphs.length,
      alignmentCount: ctcCharacters.length,
    });
  }

  for (
    let occurrenceIndex = 0;
    occurrenceIndex < line.glyphs.length;
    occurrenceIndex++
  ) {
    const glyph = line.glyphs[occurrenceIndex];

    const character = String(
      glyph.character ?? ""
    );

    const glyphId = glyph.glyphId;

    const alignment =
      ctcCharacters[occurrenceIndex] ?? null;

    if (
      alignment &&
      alignment.text !== character
    ) {
      alignmentCharacterMismatchCount++;

      if (alignmentIssues.length < 25) {
        alignmentIssues.push({
          lineIndex,
          occurrenceIndex,
          issue: "alignment-character-mismatch",
          glyphCharacter: character,
          alignmentCharacter: alignment.text,
        });
      }
    }

    if (!alignment) {
      missingAlignmentCount++;
    }

    const width = Number(glyph.width ?? 0);
    const height = Number(glyph.height ?? 0);

    const pixelCount = Number(
      glyph.pixelCount ?? 0
    );

    const cellBounds =
      glyph.cellBounds ?? null;

    const cropBounds =
      glyph.cropBounds ?? null;

    const cellAdvance =
      cellBounds &&
      Number.isFinite(Number(cellBounds.left)) &&
      Number.isFinite(Number(cellBounds.right))
        ? Number(cellBounds.right) -
          Number(cellBounds.left)
        : null;

    const inkOffsetX =
      cropBounds && cellBounds
        ? Number(cropBounds.x) -
          Number(cellBounds.left)
        : null;

    const inkOffsetY =
      cropBounds && cellBounds
        ? Number(cropBounds.y) -
          Number(cellBounds.top)
        : null;

    const occurrence = {
      glyphId,

      character,

      lineIndex,
      lineText: line.text,

      glyphIndex: glyph.glyphIndex,
      occurrenceIndex,

      status: glyph.status,
      isWhitespace: glyph.isWhitespace,

      // Original visible glyph dimensions.
      width,
      height,
      pixelCount,

      // Shape-density descriptor.
      inkDensity:
        width > 0 && height > 0
          ? pixelCount / (width * height)
          : null,

      // Original line dimensions.
      lineHeight,

      // Size normalized against the source line height.
      normalizedWidth:
        lineHeight > 0
          ? width / lineHeight
          : null,

      normalizedHeight:
        lineHeight > 0
          ? height / lineHeight
          : null,

      // Observed CTC cell advance estimate.
      cellAdvance,

      normalizedCellAdvance:
        lineHeight > 0 &&
        cellAdvance !== null
          ? cellAdvance / lineHeight
          : null,

      // Glyph ink placement within its character cell.
      inkOffsetWithinCell: {
        x: inkOffsetX,
        y: inkOffsetY,
      },

      cellBounds,
      cropBounds,

      // Mapping back to the original OCR crop.
      sourceCrop: {
        ordered:
          line.source?.cropGeometry?.ordered ?? null,

        rotated:
          line.source?.cropGeometry?.rotated ?? null,

        sourceBounds:
          jobMetadata.bounds ?? null,

        finalWidth:
          line.source?.cropGeometry?.finalWidth ?? null,

        finalHeight:
          line.source?.cropGeometry?.finalHeight ?? null,
      },

      // Actual CTC alignment data.
      ctcAlignment: alignment
        ? {
            text: alignment.text,
            startStep: alignment.startStep,
            endStep: alignment.endStep,
            meanScore: alignment.meanScore,
          }
        : null,
    };

    if (!occurrencesByCharacter[character]) {
      occurrencesByCharacter[character] = [];
    }

    occurrencesByCharacter[character].push(
      occurrence
    );

    // Keep the original glyph record accessible,
    // including its original mask and RGBA pixel arrays.
    glyphRecordsById.set(glyphId, glyph);

    totalOccurrences++;

    if (glyph.status === "complete") {
      visibleOccurrences++;
    }

    if (glyph.isWhitespace) {
      whitespaceOccurrences++;
    }
  }
}

// ------------------------------------------------------------
// 3. BUILD CHARACTER PROFILES
// ------------------------------------------------------------

const characterProfiles = Object.entries(
  occurrencesByCharacter
)
.map(([character, occurrences]) => {
  const visible = occurrences.filter(
    item => item.status === "complete"
  );

  const lineHeights = [
    ...new Set(
      occurrences
        .map(item => item.lineHeight)
        .filter(value => value > 0)
    ),
  ].sort((a, b) => a - b);

  const sizeVariants = new Set(
    visible.map(item =>
      `${item.width}x${item.height}@${item.lineHeight}`
    )
  );

  const distinctLines = new Set(
    occurrences.map(item => item.lineIndex)
  );

  const normalizedWidths = visible
    .map(item => item.normalizedWidth)
    .filter(Number.isFinite);

  const normalizedHeights = visible
    .map(item => item.normalizedHeight)
    .filter(Number.isFinite);

  const mean = values =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) /
        values.length
      : null;

  return {
    character,

    occurrenceCount: occurrences.length,

    visibleOccurrenceCount: visible.length,

    whitespaceOccurrenceCount:
      occurrences.filter(item => item.isWhitespace).length,

    distinctLineCount: distinctLines.size,

    lineHeights,

    distinctSizeVariantCount: sizeVariants.size,

    meanNormalizedWidth: mean(normalizedWidths),

    meanNormalizedHeight: mean(normalizedHeights),

    // IDs only: original pixel data remains in the library.
    glyphIds: occurrences.map(item => item.glyphId),
  };
})
.sort((a, b) =>
  a.character.localeCompare(b.character)
);

// ------------------------------------------------------------
// 4. CHECK STANDARD CHARACTER COVERAGE
// ------------------------------------------------------------

const uppercaseCharacters =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const lowercaseCharacters =
  "abcdefghijklmnopqrstuvwxyz".split("");

const digitCharacters =
  "0123456789".split("");

const availableCharacters = new Set(
  Object.keys(occurrencesByCharacter)
);

const missingUppercase = uppercaseCharacters.filter(
  character => !availableCharacters.has(character)
);

const missingLowercase = lowercaseCharacters.filter(
  character => !availableCharacters.has(character)
);

const missingDigits = digitCharacters.filter(
  character => !availableCharacters.has(character)
);

// ------------------------------------------------------------
// 5. BUILD THE INDEX SUMMARY
// ------------------------------------------------------------

const lineHeightDistribution = Object.fromEntries(
  [...lineHeightCounts.entries()]
    .sort((a, b) => a[0] - b[0])
);

const characterIndex = {
  schema: "document-character-index",
  version: 1,

  documentId: sourceLibrary.documentId,

  createdAt: new Date().toISOString(),

  summary: {
    sourceLineCount: sourceLibrary.lines.length,

    totalOccurrences,

    visibleOccurrences,

    whitespaceOccurrences,

    uniqueCharacterCount:
      characterProfiles.length,

    allGlyphOccurrencesIndexed:
      totalOccurrences ===
      sourceLibrary.summary.totalGlyphRecords,

    alignmentLengthMismatchCount,

    alignmentCharacterMismatchCount,

    missingAlignmentCount,
  },

  coverage: {
    missingUppercase,
    missingLowercase,
    missingDigits,
  },

  lineHeightDistribution,

  characterProfiles,

  occurrencesByCharacter,
};

window.__DOCUMENT_CHARACTER_INDEX__ =
  characterIndex;

window.__DOCUMENT_GLYPH_RECORDS_BY_ID__ =
  glyphRecordsById;

// ------------------------------------------------------------
// 6. ACCESS ORIGINAL PIXEL DATA BY GLYPH ID
// ------------------------------------------------------------

window.getOriginalGlyphRecord = function (glyphId) {
  return glyphRecordsById.get(glyphId) ?? null;
};

window.getDocumentGlyphOccurrences = function (character) {
  return occurrencesByCharacter[character] ?? [];
};

// ------------------------------------------------------------
// 7. LOG VALIDATION RESULTS
// ------------------------------------------------------------

console.log(
  "[Document Character Index] Summary:",
  characterIndex.summary
);

console.log(
  "[Document Character Index] Coverage:",
  characterIndex.coverage
);

console.log(
  "[Document Character Index] Line height distribution:",
  lineHeightDistribution
);

console.table(
  characterProfiles.map(profile => ({
    character:
      profile.character === " "
        ? "[SPACE]"
        : profile.character,

    occurrences:
      profile.occurrenceCount,

    visible:
      profile.visibleOccurrenceCount,

    lines:
      profile.distinctLineCount,

    sizeVariants:
      profile.distinctSizeVariantCount,

    lineHeights:
      profile.lineHeights.join(", "),
  }))
);

console.log(
  "[Document Character Index] Alignment issues:",
  alignmentIssues
);

// ------------------------------------------------------------
// 8. EXPORT A LIGHTWEIGHT CHARACTER INDEX
// ------------------------------------------------------------

window.downloadDocumentCharacterIndex = function () {
  const index = window.__DOCUMENT_CHARACTER_INDEX__;

  if (!index) {
    console.error(
      "[Document Character Index] Index is unavailable."
    );
    return;
  }

  const json = JSON.stringify(index, null, 2);

  const blob = new Blob(
    [json],
    { type: "application/json;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");

  anchor.href = url;

  anchor.download =
    `document-character-index-${Date.now()}.json`;

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(
    () => URL.revokeObjectURL(url),
    2000
  );

  console.log(
    "[Document Character Index] Export started:",
    {
      characters: index.summary.uniqueCharacterCount,
      occurrences: index.summary.totalOccurrences,
      jsonBytes: new Blob([json]).size,
    }
  );
};

console.log(
  "[Document Character Index] Ready."
);


/*
 * DOCUMENT GLYPH SPECIMEN ANALYZER
 *
 * Builds an appearance-aware catalog from the current,
 * verified full document glyph library.
 *
 * Preserves all original glyph occurrences.
 * Does not modify original RGBA or binary masks.
 */

(() => {
  // ----------------------------------------------------------
  // 1. VALIDATE THE SOURCE LIBRARIES
  // ----------------------------------------------------------

  const library = window.__DOCUMENT_GLYPH_LIBRARY__;
  const characterIndex = window.__DOCUMENT_CHARACTER_INDEX__;

  if (!library || !Array.isArray(library.lines)) {
    throw new Error(
      "[Glyph Specimens] Full document glyph library is unavailable."
    );
  }

  if (
    characterIndex &&
    characterIndex.documentId !== library.documentId
  ) {
    throw new Error(
      "[Glyph Specimens] Document ID mismatch. " +
      "Refusing to combine different OCR runs."
    );
  }

  console.log(
    "[Glyph Specimens] Analyzing document:",
    library.documentId
  );

  // ----------------------------------------------------------
  // 2. STATISTICAL HELPERS
  // ----------------------------------------------------------

  function histogramQuantile(histogram, total, quantile) {
    if (!total) return null;

    const target = Math.floor(
      (total - 1) * quantile
    );

    let cumulative = 0;

    for (let value = 0; value < histogram.length; value++) {
      cumulative += histogram[value];

      if (cumulative > target) {
        return value;
      }
    }

    return histogram.length - 1;
  }

  function mean(sum, count) {
    return count > 0 ? sum / count : null;
  }

  function round(value, digits = 4) {
    if (!Number.isFinite(value)) return null;

    const factor = 10 ** digits;

    return Math.round(value * factor) / factor;
  }

  function median(values) {
    if (!values.length) return null;

    const sorted = [...values].sort((a, b) => a - b);

    return sorted[Math.floor(sorted.length / 2)];
  }

  // ----------------------------------------------------------
  // 3. ANALYZE ORIGINAL GLYPH PIXELS
  // ----------------------------------------------------------

  function analyzeOriginalGlyphPixels(glyph) {
    const mask = glyph.mask;
    const rgba = glyph.rgba;

    if (
      !ArrayBuffer.isView(mask) ||
      !ArrayBuffer.isView(rgba)
    ) {
      throw new Error(
        `Missing typed pixel arrays for ${glyph.glyphId}`
      );
    }

    const width = Number(glyph.width);
    const height = Number(glyph.height);

    if (
      width <= 0 ||
      height <= 0 ||
      mask.length !== width * height ||
      rgba.length !== width * height * 4
    ) {
      throw new Error(
        `Invalid glyph dimensions for ${glyph.glyphId}`
      );
    }

    const redHistogram = new Uint32Array(256);
    const greenHistogram = new Uint32Array(256);
    const blueHistogram = new Uint32Array(256);
    const luminanceHistogram = new Uint32Array(256);
    const saturationHistogram = new Uint32Array(256);

    const rowInkCounts = new Uint32Array(height);
    const columnInkCounts = new Uint32Array(width);

    let foregroundPixelCount = 0;

    let redSum = 0;
    let greenSum = 0;
    let blueSum = 0;
    let luminanceSum = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;

        if (mask[index] === 0) continue;

        const rgbaIndex = index * 4;

        const red = rgba[rgbaIndex];
        const green = rgba[rgbaIndex + 1];
        const blue = rgba[rgbaIndex + 2];

        const luminance = Math.round(
          0.2126 * red +
          0.7152 * green +
          0.0722 * blue
        );

        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);

        const saturation = maximum > 0
          ? Math.round(
              ((maximum - minimum) / maximum) * 255
            )
          : 0;

        redHistogram[red]++;
        greenHistogram[green]++;
        blueHistogram[blue]++;

        luminanceHistogram[luminance]++;
        saturationHistogram[saturation]++;

        redSum += red;
        greenSum += green;
        blueSum += blue;
        luminanceSum += luminance;

        rowInkCounts[y]++;
        columnInkCounts[x]++;

        foregroundPixelCount++;
      }
    }

    if (foregroundPixelCount === 0) {
      throw new Error(
        `No foreground pixels in ${glyph.glyphId}`
      );
    }

    const redMedian = histogramQuantile(
      redHistogram,
      foregroundPixelCount,
      0.5
    );

    const greenMedian = histogramQuantile(
      greenHistogram,
      foregroundPixelCount,
      0.5
    );

    const blueMedian = histogramQuantile(
      blueHistogram,
      foregroundPixelCount,
      0.5
    );

    const luminanceMedian = histogramQuantile(
      luminanceHistogram,
      foregroundPixelCount,
      0.5
    );

    const channelSpread =
      Math.max(redMedian, greenMedian, blueMedian) -
      Math.min(redMedian, greenMedian, blueMedian);

    let colorFamily;

    if (channelSpread <= 8) {
      colorFamily = "neutral-grayscale";
    } else if (
      redMedian - greenMedian >= 18 &&
      Math.abs(greenMedian - blueMedian) <= 32
    ) {
      colorFamily = "warm-red-accent";
    } else {
      colorFamily = "other-chromatic";
    }

    const rowInkProfile = Array.from(
      rowInkCounts,
      count => round(count / width)
    );

    const columnInkProfile = Array.from(
      columnInkCounts,
      count => round(count / height)
    );

    return {
      foregroundPixelCount,

      inkDensity: round(
        foregroundPixelCount / (width * height)
      ),

      color: {
        family: colorFamily,

        medianRGB: [
          redMedian,
          greenMedian,
          blueMedian,
        ],

        meanRGB: [
          round(mean(redSum, foregroundPixelCount), 2),
          round(mean(greenSum, foregroundPixelCount), 2),
          round(mean(blueSum, foregroundPixelCount), 2),
        ],

        medianLuminance: luminanceMedian,

        meanLuminance: round(
          mean(luminanceSum, foregroundPixelCount), 2
        ),

        medianSaturation: histogramQuantile(
          saturationHistogram,
          foregroundPixelCount,
          0.5
        ),

        channelSpread,
      },

      // Compact geometric shape descriptors.
      // Original full-resolution masks remain untouched.
      rowInkProfile,
      columnInkProfile,
    };
  }

  // ----------------------------------------------------------
  // 4. BUILD SPECIMEN COLLECTIONS
  // ----------------------------------------------------------

  const specimensByCharacter = Object.create(null);
  const specimensByGlyphId = Object.create(null);

  const whitespaceSlots = [];
  const lineProfiles = [];

  const colorFamilyCounts = Object.create(null);
  const colorFamilyLines = Object.create(null);

  const lineHeightCounts = Object.create(null);

  const issues = [];

  let totalVisibleGlyphs = 0;
  let totalWhitespaceSlots = 0;
  let totalPixelBytes = 0;

  let ctcMissing = 0;
  let ctcMismatches = 0;

  for (const line of library.lines) {
    const lineIndex = line.lineIndex;

    const jobMetadata =
      line.source?.jobMetadata ?? {};

    const ctcCharacters =
      Array.isArray(jobMetadata.characters)
        ? jobMetadata.characters
        : [];

    const lineHeight = Number(
      jobMetadata.geometry?.sourceHeight ??
      line.source?.cropGeometry?.finalHeight ??
      0
    );

    lineHeightCounts[lineHeight] =
      (lineHeightCounts[lineHeight] ?? 0) + 1;

    const currentLineFamilies = Object.create(null);

    for (
      let position = 0;
      position < line.glyphs.length;
      position++
    ) {
      const glyph = line.glyphs[position];

      const character = String(glyph.character ?? "");

      const glyphId = glyph.glyphId;

      const ctc =
        ctcCharacters[position] ?? null;

      if (!ctc) {
        ctcMissing++;
      } else if (ctc.text !== character) {
        ctcMismatches++;

        issues.push({
          glyphId,
          issue: "ctc-character-mismatch",
        });
      }

      // Preserve whitespace slots separately.
      // They remain important for original layout spacing.
      if (glyph.isWhitespace || glyph.status === "space") {
        whitespaceSlots.push({
          glyphId,
          lineIndex,
          occurrenceIndex: position,
          character,
          cellBounds: glyph.cellBounds,
          ctcAlignment: ctc,
        });

        totalWhitespaceSlots++;
        continue;
      }

      if (glyph.status !== "complete") {
        issues.push({
          glyphId,
          issue: "unexpected-non-complete-visible-glyph",
          status: glyph.status,
        });

        continue;
      }

      const pixelAnalysis =
        analyzeOriginalGlyphPixels(glyph);

      const width = Number(glyph.width);
      const height = Number(glyph.height);

      const cellBounds =
        glyph.cellBounds ?? null;

      const cropBounds =
        glyph.cropBounds ?? null;

      const cellAdvance = cellBounds
        ? Number(cellBounds.right) -
          Number(cellBounds.left)
        : null;

      const topBearing = cropBounds && cellBounds
        ? Number(cropBounds.y) -
          Number(cellBounds.top)
        : null;

      const leftBearing = cropBounds && cellBounds
        ? Number(cropBounds.x) -
          Number(
            cellBounds.pixelLeft ??
            cellBounds.left
          )
        : null;

      const bottomGap = cropBounds && cellBounds
        ? Number(cellBounds.bottomExclusive) -
          (
            Number(cropBounds.y) +
            height
          )
        : null;

      const specimen = {
        glyphId,

        character,

        lineIndex,
        lineText: line.text,

        occurrenceIndex: position,

        // Original glyph geometry.
        width,
        height,

        aspectRatio: round(width / height),

        lineHeight,

        normalizedWidth: round(
          width / Math.max(1, lineHeight)
        ),

        normalizedHeight: round(
          height / Math.max(1, lineHeight)
        ),

        cellAdvance: round(cellAdvance),

        normalizedCellAdvance: cellAdvance !== null
          ? round(cellAdvance / Math.max(1, lineHeight))
          : null,

        bearings: {
          left: round(leftBearing),
          top: round(topBearing),
          bottom: round(bottomGap),
        },

        pixelCount: glyph.pixelCount,

        // Original pixel-derived measurements.
        appearance: pixelAnalysis,

        // Original recognition alignment.
        ctcAlignment: ctc
          ? {
              startStep: ctc.startStep,
              endStep: ctc.endStep,
              meanScore: ctc.meanScore,
            }
          : null,

        // Reference to original pixel data.
        // No masks or RGBA buffers are copied here.
        source: {
          glyphId,
          coordinateSpace: library.coordinateSpace,
          maskSource: glyph.maskSource,
        },
      };

      if (!specimensByCharacter[character]) {
        specimensByCharacter[character] = [];
      }

      specimensByCharacter[character].push(specimen);

      specimensByGlyphId[glyphId] = specimen;

      currentLineFamilies[
        pixelAnalysis.color.family
      ] = (currentLineFamilies[
        pixelAnalysis.color.family
      ] ?? 0) + 1;

      colorFamilyCounts[
        pixelAnalysis.color.family
      ] = (colorFamilyCounts[
        pixelAnalysis.color.family
      ] ?? 0) + 1;

      if (!colorFamilyLines[pixelAnalysis.color.family]) {
        colorFamilyLines[pixelAnalysis.color.family] = new Set();
      }

      colorFamilyLines[
        pixelAnalysis.color.family
      ].add(lineIndex);

      totalPixelBytes +=
        glyph.mask.byteLength +
        glyph.rgba.byteLength;

      totalVisibleGlyphs++;
    }

    const dominantFamily = Object.entries(
      currentLineFamilies
    ).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    lineProfiles.push({
      lineIndex,
      text: line.text,
      lineHeight,
      visibleGlyphCount:
        line.extractionSummary?.extractedGlyphCount ?? 0,

      dominantColorFamily: dominantFamily,

      colorFamilyCounts: {
        ...currentLineFamilies,
      },
    });
  }

  // ----------------------------------------------------------
  // 5. BUILD CHARACTER-LEVEL SPECIMEN PROFILES
  // ----------------------------------------------------------

  const characterProfiles = [];

  for (const [character, specimens] of Object.entries(
    specimensByCharacter
  )) {
    const colorFamilies = Object.create(null);
    const dimensions = new Set();
    const lineHeights = new Set();
    const lines = new Set();

    for (const specimen of specimens) {
      const family = specimen.appearance.color.family;

      colorFamilies[family] =
        (colorFamilies[family] ?? 0) + 1;

      dimensions.add(
        `${specimen.width}x${specimen.height}`
      );

      lineHeights.add(specimen.lineHeight);
      lines.add(specimen.lineIndex);
    }

    characterProfiles.push({
      character,

      occurrenceCount: specimens.length,

      distinctLineCount: lines.size,

      distinctDimensions: dimensions.size,

      lineHeights: [...lineHeights].sort((a, b) => a - b),

      colorFamilies,
    });
  }

  characterProfiles.sort(
    (a, b) => a.character.localeCompare(b.character)
  );

  // ----------------------------------------------------------
  // 6. CREATE DOCUMENT-LEVEL SPECIMEN CATALOG
  // ----------------------------------------------------------

  const specimenCatalog = {
    schema: "document-glyph-specimen-catalog",
    version: 1,

    documentId: library.documentId,

    createdAt: new Date().toISOString(),

    coordinateSpace: library.coordinateSpace,

    summary: {
      sourceLineCount: library.lines.length,

      visibleGlyphCount: totalVisibleGlyphs,

      whitespaceSlotCount: totalWhitespaceSlots,

      uniqueCharacterCount:
        characterProfiles.length,

      originalPixelBytesReferenced:
        totalPixelBytes,

      ctcMissing,

      ctcMismatches,

      analysisIssueCount: issues.length,
    },

    appearanceFamilies: {
      glyphCounts: {
        ...colorFamilyCounts,
      },

      lineCounts: Object.fromEntries(
        Object.entries(colorFamilyLines).map(
          ([family, lineSet]) => [
            family,
            lineSet.size,
          ]
        )
      ),
    },

    lineHeightDistribution: lineHeightCounts,

    characterProfiles,

    // Every visible occurrence stays separate.
    specimensByCharacter,

    // Reference lookup by original glyph ID.
    specimensByGlyphId,

    // Preserve original character-cell spacing.
    whitespaceSlots,

    lineProfiles,

    validation: {
      matchesSourceDocument:
        library.documentId ===
        window.__DOCUMENT_GLYPH_LIBRARY__.documentId,

      allVisibleGlyphsAnalyzed:
        totalVisibleGlyphs ===
        library.summary.totalExtractedGlyphs,

      allWhitespaceSlotsPreserved:
        totalWhitespaceSlots ===
        library.summary.totalWhitespaceSlots,

      noMissingCTC:
        ctcMissing === 0,

      noCTCMismatches:
        ctcMismatches === 0,

      noAnalysisIssues:
        issues.length === 0,
    },

    issues,
  };

 // ----------------------------------------------------------
// 7. PUBLISH CATALOG AND LOOKUP HELPERS
// ----------------------------------------------------------

window.__DOCUMENT_GLYPH_SPECIMENS__ =
  specimenCatalog;

window.getGlyphSpecimensByCharacter = function (
  character,
  colorFamily = null
) {
  const specimens =
    specimenCatalog.specimensByCharacter[character] ?? [];

  if (!colorFamily) {
    return specimens;
  }

  return specimens.filter(
    specimen =>
      specimen.appearance.color.family === colorFamily
  );
};

window.getGlyphSpecimen = function (glyphId) {
  return specimenCatalog.specimensByGlyphId[glyphId] ?? null;
};

window.getOriginalGlyphPixels = function (glyphId) {
  const line = library.lines.find(item =>
    item.glyphs.some(glyph => glyph.glyphId === glyphId)
  );

  return line?.glyphs.find(
    glyph => glyph.glyphId === glyphId
  ) ?? null;
};


registerDocumentGlyphRuntime({
  documentId: window.__DOCUMENT_GLYPH_LIBRARY__?.documentId,

  getGlyphRecord: window.getOriginalGlyphRecord,

  getGlyphSpecimensByCharacter:
    window.getGlyphSpecimensByCharacter,

  getGlyphSpecimen: window.getGlyphSpecimen,
});

console.log(
  "[Document Glyph Store] Registration completed."
);

window.createDocumentGlyphSvgPreview =
  createDocumentGlyphSvg;

  // ----------------------------------------------------------
  // 8. PRINT REPORTS
  // ----------------------------------------------------------

  console.log(
    "[Glyph Specimens] Summary:",
    specimenCatalog.summary
  );

  console.log(
    "[Glyph Specimens] Appearance families:",
    specimenCatalog.appearanceFamilies
  );

  console.log(
    "[Glyph Specimens] Validation:",
    specimenCatalog.validation
  );

  console.table(
    characterProfiles.map(profile => ({
      character:
        profile.character === " "
          ? "[SPACE]"
          : profile.character,

      occurrences:
        profile.occurrenceCount,

      lines:
        profile.distinctLineCount,

      dimensionVariants:
        profile.distinctDimensions,

      grayscale:
        profile.colorFamilies["neutral-grayscale"] ?? 0,

      warmAccent:
        profile.colorFamilies["warm-red-accent"] ?? 0,

      otherChromatic:
        profile.colorFamilies["other-chromatic"] ?? 0,
    }))
  );

  // ----------------------------------------------------------
  // 9. EXPORT LIGHTWEIGHT SPECIMEN CATALOG
  // ----------------------------------------------------------

  window.downloadDocumentGlyphSpecimenCatalog = function () {
    const catalog = window.__DOCUMENT_GLYPH_SPECIMENS__;

    if (!catalog) {
      console.error(
        "[Glyph Specimens] Specimen catalog unavailable."
      );

      return;
    }

    const exportData = {
      ...catalog,

      // Keep the JSON lightweight.
      // Original masks and RGBA pixels remain in the
      // separate full document glyph library.
      specimensByGlyphId: undefined,
    };

    const blob = new Blob(
      [JSON.stringify(exportData, null, 2)],
      { type: "application/json;charset=utf-8" }
    );

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;

    anchor.download =
      `document-glyph-specimen-catalog-${Date.now()}.json`;

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(
      () => URL.revokeObjectURL(url),
      2000
    );

    console.log(
      "[Glyph Specimens] Export started:",
      {
        documentId: catalog.documentId,
        characters: catalog.summary.uniqueCharacterCount,
        visibleGlyphs: catalog.summary.visibleGlyphCount,
      }
    );
  };

  console.log(
    "[Glyph Specimens] Catalog ready.",
    "Use getGlyphSpecimensByCharacter('a') to inspect specimens."
  );
})();


console.groupEnd();
// TEMPORARY: Verify selected original glyph extraction results.
const selectedGlyphLineIndices = [0, 5, 12];

console.group(
  "[Original Glyph Extraction — Selected Worker Results]"
);

console.table(
  selectedGlyphLineIndices.map((index) => {
    const job = jobs.find(
      (item) => item.index === index
    );

    const result = workerResults.find(
      (item) => item.index === index
    );

    const measurement = result?.characterMeasurements;

    const extraction =
      measurement?.originalGlyphShapeExtraction ??
      result?.originalGlyphShapeExtraction ??
      null;

    const summary =
      measurement?.originalGlyphShapeSummary ??
      null;

    return {
      lineIndex: index,
      text: job?.text ?? "JOB NOT FOUND",
      measurementStatus: measurement?.status ?? "missing",
      extractionStatus: extraction?.status ?? summary?.status ?? "missing",
      extractedGlyphCount:
        extraction?.extractedGlyphCount ??
        summary?.extractedGlyphCount ??
        null,
      emptyGlyphCount:
        extraction?.emptyGlyphCount ?? null,
      integrityFailures:
        extraction?.integrityFailures ??
        summary?.integrityFailures ??
        null,
      extractionObjectPresent: !!extraction,
    };
  })
);

console.log(
  "Full selected worker results:",
  workerResults.filter((result) =>
    selectedGlyphLineIndices.includes(result.index)
  )
);

console.groupEnd();

  // Match worker results to their original OCR records.
  for (const workerResult of workerResults) {
    const record = lineRecords[workerResult.index];

    if (!record) continue;

      record.inkBounds = workerResult.inkBounds || null;

    record.wordSegmentation =
      workerResult.wordSegmentation || null;

    record.errorMessage = workerResult.errorMessage || null;

    // Preserve individual character measurements from OpenCV.
    record.characterMeasurements =
      workerResult.characterMeasurements || null;
  record.originalGlyphShapeExtraction =
    workerResult.originalGlyphShapeExtraction ?? null;

    record.characterMeasurementError =
      workerResult.characterMeasurementError || null;

    if (record.errorMessage) {
      openCVErrors++;

      console.error(
        `OpenCV worker failed on line ${workerResult.index + 1}:`,
        record.errorMessage
      );
    }
  }
} else {
  setProgress("No valid OCR rectangles to measure", 100);
}

inkResults = lineRecords;

// ----------------------------------------------------------
// TEMPORARY: VERIFY WIDER GLYPH DIAGNOSTIC DATA FLOW
// ----------------------------------------------------------

const diagnosticTargets = [
  {
    lineText: "202-555-0120",
    characterIndex: 11,
    glyphId: "7:11",
  },
  {
    lineText: "Feb 2020 - Aug 2023",
    characterIndex: 5,
    glyphId: "19:5",
  },
  {
    lineText: "Aug 2013 - Apr 2016",
    characterIndex: 5,
    glyphId: "51:5",
  },
];

for (const target of diagnosticTargets) {
  const lineRecord = lineRecords.find(
    record => record.text === target.lineText
  );

  const measurement =
    lineRecord?.characterMeasurements;

  const character = measurement?.characters?.find(
    item => item.index === target.characterIndex
  );

  const shape = character?.originalGlyphShape;

  const context = shape?.diagnosticContext;

  console.log(
    "[Glyph Diagnostic Data Flow]",
    target.glyphId,
    {
      lineFound: !!lineRecord,
      measurementFound: !!measurement,
      characterFound: !!character,
      shapeFound: !!shape,
      diagnosticContextFound: !!context,

      diagnosticStatus: context?.status,
      contextWidth: context?.width,
      contextHeight: context?.height,

      rgbaLength: context?.rgba?.length,
      maskLength: context?.mask?.length,

      cellBounds: context?.cellBounds,
      tightMaskBounds: context?.tightMaskBounds,
    }
  );
}

// ----------------------------------------------------------
// TEMPORARY: EXPOSE DIAGNOSTIC CONTEXTS FOR VISUAL REVIEW
// ----------------------------------------------------------

window.__PADDLE_GLYPH_DIAGNOSTIC_CONTEXTS__ =
  Object.fromEntries(
    diagnosticTargets.map(target => {
      const lineRecord = lineRecords.find(
        record => record.text === target.lineText
      );

      const character =
        lineRecord?.characterMeasurements?.characters?.find(
          item => item.index === target.characterIndex
        );

      const shape = character?.originalGlyphShape;

      return [
        target.glyphId,
        {
          glyphId: target.glyphId,
          lineText: target.lineText,
          character: character?.text,

          width: shape?.width,
          height: shape?.height,

          context: shape?.diagnosticContext,
componentDiagnostics: shape?.componentDiagnostics,
originalMask: shape?.mask,
          originalCropBounds: shape?.cropBounds,
          originalCellBounds: shape?.cellBounds,
        }
      ];
    })
  );

console.log(
  "[Glyph Diagnostic Contexts] Ready:",
  Object.keys(window.__PADDLE_GLYPH_DIAGNOSTIC_CONTEXTS__)
);

window.__PADDLE_ZERO_COMPONENT_AUDIT__ = lineRecords.flatMap(
  (lineRecord) => {
    const lineIndex = lineRecords.indexOf(lineRecord);

    return (
      lineRecord.characterMeasurements?.characters || []
    )
      .filter((character) => character.text === "0")
      .map((character) => {
        const shape = character.originalGlyphShape;
        const diagnostics = shape?.componentDiagnostics;
        const context = shape?.diagnosticContext;

        // Recover the exact original mask from the wider context.
        let originalMask = null;

        const source = context?.mask;
        const bounds = context?.tightMaskBounds;

        if (source && bounds && context?.width && context?.height) {
          const {
            x,
            y,
            width,
            height
          } = bounds;

          const contextWidth = context.width;
          const contextHeight = context.height;

          if (
            source.length === contextWidth * contextHeight &&
            x >= 0 &&
            y >= 0 &&
            x + width <= contextWidth &&
            y + height <= contextHeight
          ) {
            originalMask = new Uint8Array(width * height);

            for (let row = 0; row < height; row++) {
              for (let col = 0; col < width; col++) {
                originalMask[row * width + col] =
                  source[
                    (y + row) * contextWidth + x + col
                  ];
              }
            }
          }
        }

        return {
          glyphId: `${lineIndex}:${character.index}`,
          lineIndex,
          lineText: lineRecord.text,
          characterIndex: character.index,

          width: shape?.width,
          height: shape?.height,

          componentCount: diagnostics?.componentCount,
          sourcePixelCount: diagnostics?.sourcePixelCount,
          retainedPixelCount: diagnostics?.retainedPixelCount,
          removedPixelCount: diagnostics?.removedPixelCount,
          retainedRatio: diagnostics?.retainedRatio,

          originalMask,
          candidateMask: diagnostics?.largestComponentMask,

          components: diagnostics?.components
        };
      });
  }
);

console.log(
  "[All Zero Component Audit]",
  window.__PADDLE_ZERO_COMPONENT_AUDIT__
);

// =======================================================
// PADDLEOCR -> EDITABLE DOCUMENT INTEGRATION
// =======================================================

if (!paddleEditorPageId) {
  throw new Error(
    "The PaddleOCR editor page has not been registered."
  );
}

const editorResult = {
  imageWidth: selectedBitmap.width,
  imageHeight: selectedBitmap.height,
  items: inkResults,
};

const editorReport = applyPaddleOCRToEditor({
  result: editorResult,
  pageId: paddleEditorPageId,
});

console.log(
  "[PADDLE EDITOR] TEXT BLOCK INTEGRATION:",
  {
    pageId: editorReport.pageId,
    totalLines: editorReport.totalLines,
    createdLines: editorReport.createdLines,
    skippedLines: editorReport.skippedLines.length,
    measuredLines: editorReport.measuredLines,
    totalCharacterRecords:
      editorReport.totalCharacterRecords,
    renderedElementCount:
      editorReport.renderedElementCount,
    sourceWidth: editorReport.sourceWidth,
    sourceHeight: editorReport.sourceHeight,
  }
);

console.table(editorReport.skippedLines);

const characterStatusCounts = {};
const characterLineStatusCounts = {};

let totalCharacterRecords = 0;
let measuredCharacterCount = 0;
let measuredLowPixelCount = 0;
let spaceRecordCount = 0;
let noVisibleInkCount = 0;

for (const record of inkResults) {
  const measurement = record.characterMeasurements;

  const lineStatus =
    measurement?.status ||
    (record.characterMeasurementError ? "worker-error" : "missing");

  characterLineStatusCounts[lineStatus] =
    (characterLineStatusCounts[lineStatus] || 0) + 1;

  const characters = Array.isArray(measurement?.characters)
    ? measurement.characters
    : [];

  totalCharacterRecords += characters.length;

  for (const character of characters) {
    const characterStatus = character.status || "unknown";

    characterStatusCounts[characterStatus] =
      (characterStatusCounts[characterStatus] || 0) + 1;

    if (characterStatus === "measured") {
      measuredCharacterCount++;
    } else if (characterStatus === "measured-low-pixel-count") {
      measuredLowPixelCount++;
    } else if (characterStatus === "space") {
      spaceRecordCount++;
    } else if (characterStatus === "no-visible-ink") {
      noVisibleInkCount++;
    }
  }
}

console.log("\n========== CHARACTER MEASUREMENT SUMMARY ==========");
console.log("OCR line records:", inkResults.length);

console.log(
  "Lines with character results:",
  inkResults.filter((record) => !!record.characterMeasurements).length
);

console.log("Line measurement statuses:", characterLineStatusCounts);
console.log("Character statuses:", characterStatusCounts);

console.log("Total returned token records:", totalCharacterRecords);
console.log("Measured characters:", measuredCharacterCount);
console.log("Low-pixel-count characters:", measuredLowPixelCount);
console.log("Spaces:", spaceRecordCount);
console.log("Characters with no visible ink:", noVisibleInkCount);

console.log(
  "Character measurement errors:",
  inkResults
    .filter((record) => record.characterMeasurementError)
    .map((record) => ({
      text: record.text,
      error: record.characterMeasurementError,
    }))
);

console.log(
  "FIRST FIVE CHARACTER MEASUREMENT RECORDS:",
  inkResults.slice(0, 5).map((record) => ({
    text: record.text,
    status: record.characterMeasurements?.status,
    crop: record.characterMeasurements?.crop,
    characterCount:
      record.characterMeasurements?.characterCount ?? 0,
    spaceCount:
      record.characterMeasurements?.spaceCount ?? 0,
    noInkCount:
      record.characterMeasurements?.noInkCount ?? 0,
    characters:
      record.characterMeasurements?.characters
        ?.slice(0, 12)
        .map((character) => ({
          index: character.index,
          text: character.text,
          status: character.status,
          inkBounds: character.inkBounds,
          pixelCount: character.pixelCount,
          acceptedComponents: character.acceptedComponents,
        })) ?? [],
  }))
);

console.log("===================================================\n");



    // STEP 19: Diagnose character centers outside the exact crop.

    // STEP 19B: Compare possible CTC horizontal output strides.
    const strideHypothesisSummary = [4, 8, 12].map((stride) => {
      let sequenceLengthMatches = 0;
      let linesWithValidCenters = 0;
      let outsideTokenCount = 0;
      const outsideLines = [];

      for (const record of inkResults) {
        const g = record.geometry || {};
        const characters = Array.isArray(record.characters)
          ? record.characters
          : [];

        if (!characters.length) continue;

        const inputWidth = Number(g.inputWidth);
        const timeSteps = Number(g.timeSteps);
        const resizedWidth = Number(g.resizedWidth);
        const sourceWidth = Number(g.sourceWidth);

        if (
          !Number.isFinite(inputWidth) ||
          !Number.isFinite(timeSteps) ||
          !Number.isFinite(resizedWidth) ||
          !Number.isFinite(sourceWidth) ||
          resizedWidth <= 0 ||
          timeSteps <= 0
        ) {
          continue;
        }

        if (timeSteps === Math.floor(inputWidth / stride)) {
          sequenceLengthMatches++;
        }

        const cropScale = sourceWidth / resizedWidth;
        const outsideTokens = [];

        for (let i = 0; i < characters.length; i++) {
          const ch = characters[i];

          const stepCenter =
            (Number(ch.startStep) + Number(ch.endStep) + 1) / 2;

          const recognizerX = stepCenter * stride;
          const cropX = recognizerX * cropScale;

          if (
            cropX < -0.001 ||
            cropX > sourceWidth + 0.001
          ) {
            outsideTokens.push({
              index: i,
              text: ch.text,
              startStep: ch.startStep,
              endStep: ch.endStep,
              cropX: Number(cropX.toFixed(3)),
              cropWidth: sourceWidth
            });
          }
        }

        if (outsideTokens.length === 0) {
          linesWithValidCenters++;
        } else {
          outsideTokenCount += outsideTokens.length;

          outsideLines.push({
            text: record.text,
            inputWidth,
            timeSteps,
            resizedWidth,
            sourceWidth,
            outsideTokens
          });
        }
      }

      return {
        stride,
        sequenceLengthMatches,
        totalLines: inkResults.length,
        linesWithValidCenters,
        outsideTokenCount,
        outsideLines
      };
    });

    console.log(
      "\n========== CTC STRIDE HYPOTHESIS =========="
    );

    console.table(
      strideHypothesisSummary.map((item) => ({
        stride: item.stride,
        sequenceLengthMatches: item.sequenceLengthMatches,
        totalLines: item.totalLines,
        linesWithValidCenters: item.linesWithValidCenters,
        outsideTokenCount: item.outsideTokenCount
      }))
    );

    console.log(
      "FULL STRIDE DIAGNOSTICS:",
      JSON.stringify(strideHypothesisSummary, null, 2)
    );

    // STEP 19C: Inspect lines where timeSteps differs from floor(inputWidth / 8).
    const stride8Exceptions = inkResults
      .map((record, index) => {
        const g = record.geometry || {};

        const inputWidth = Number(g.inputWidth);
        const resizedWidth = Number(g.resizedWidth);
        const timeSteps = Number(g.timeSteps);

        return {
          line: index + 1,
          text: record.text,
          inputWidth,
          resizedWidth,
          timeSteps,
          floorWidthOver8: Math.floor(inputWidth / 8),
          ceilWidthOver8: Math.ceil(inputWidth / 8),
          inputWidthPerStep: Number(
            (inputWidth / timeSteps).toFixed(5)
          ),
          resizedWidthPerStep: Number(
            (resizedWidth / timeSteps).toFixed(5)
          ),
          batchPadding: inputWidth - resizedWidth
        };
      })
      .filter((item) =>
        item.timeSteps !== item.floorWidthOver8
      );

    console.log("\n========== STRIDE-8 LENGTH EXCEPTIONS ==========");
    console.table(stride8Exceptions);
    console.log("Exception count:", stride8Exceptions.length);
    console.log("===============================================\n");


    console.log(
      "===========================================\n"
    );

    const outsideCropDiagnostics = inkResults
      .map((record, index) => {
        const measurement = record.characterMeasurements;

        if (
          measurement?.status !== "character-center-outside-crop"
        ) {
          return null;
        }

        const geometry = record.geometry || {};
        const crop = record.cropGeometry || {};
        const characters = Array.isArray(record.characters)
          ? record.characters
          : [];

        const stepScale =
          Number(geometry.inputWidth) /
          Number(geometry.timeSteps);

        const cropScale =
          Number(geometry.sourceWidth) /
          Number(geometry.resizedWidth);

        const centers = characters.map((character, charIndex) => {
          const startStep = Number(character.startStep);
          const endStep = Number(character.endStep);

          const stepCenter =
            (startStep + endStep + 1) / 2;

          const recognizerX = stepCenter * stepScale;
          const cropX = recognizerX * cropScale;

          return {
            index: charIndex,
            text: character.text,
            startStep,
            endStep,
            recognizerX: Number(recognizerX.toFixed(3)),
            cropX: Number(cropX.toFixed(3)),
            cropWidth: geometry.sourceWidth,
            outside:
              cropX < 0 ||
              cropX > Number(geometry.sourceWidth),
          };
        });

        return {
          line: index + 1,
          text: record.text,
          measurementStatus: measurement.status,
          geometry,
          cropGeometry: crop,
          tokenCount: characters.length,
          outsideTokens: centers.filter((item) => item.outside),
          firstTokens: centers.slice(0, 5),
          lastTokens: centers.slice(-10),
          allCenters: centers,
        };
      })
      .filter(Boolean);

    console.log(
      "\\n========== OUTSIDE-CROP DIAGNOSTIC =========="
    );

    console.log(
      "Failed line count:",
      outsideCropDiagnostics.length
    );

    console.log(
      "FAILED LINE DETAILS:",
      JSON.stringify(outsideCropDiagnostics, null, 2)
    );

    console.log(
      "=============================================\\n"
    );

    drawDetections(result.items, inkResults);

    let measuredCount = 0;

    for (let i = 0; i < inkResults.length; i++) {
      const measurement = inkResults[i];

      const li = document.createElement("li");

      const score = Number(measurement.score);

      const confidenceText = Number.isFinite(score)
        ? ` — confidence ${(score * 100).toFixed(1)}%`
        : "";

      const title = document.createElement("div");

      title.textContent =
        `${measurement.text}${confidenceText}`;

      li.appendChild(title);

      const details = document.createElement("pre");

      details.style.whiteSpace = "pre-wrap";
      details.style.overflowWrap = "anywhere";

      if (measurement.inkBounds) {
        measuredCount++;

        const ocr = measurement.ocrBounds;
        const ink = measurement.inkBounds;

        details.textContent =
          `Paddle box: ${ocr.width} × ${ocr.height}\n` +
          `OpenCV ink: ${ink.width} × ${ink.height}\n` +
          `Ink position: x=${ink.x}, y=${ink.y}\n` +
          `Foreground pixels: ${ink.pixelCount}\n` +
          `Components: ${ink.acceptedComponents}\n` +
          `Polarity: ${ink.polarity}`;
      } else {
        details.textContent = measurement.errorMessage
          ? `OpenCV error: ${measurement.errorMessage}`
          : "OpenCV could not find a reliable ink rectangle.";
      }

      li.appendChild(details);
      
      // Show the word-level segmentation results.
      const segmentation = measurement.wordSegmentation;

      if (segmentation) {
        details.textContent +=
          `\n\nWord segmentation: ${segmentation.status}`;

        if (segmentation.confidence) {
          details.textContent +=
            `\nSegmentation confidence: ${segmentation.confidence}`;
        }

        if (Array.isArray(segmentation.words)) {
          details.textContent +=
            `\nWord count: ${segmentation.words.length}`;

          for (const word of segmentation.words) {
            details.textContent +=
              `\n\n  ${word.text}` +
              `\n  Position: x=${word.bounds.x}, y=${word.bounds.y}` +
              `\n  OCR region: ${word.bounds.width} × ${word.bounds.height}` +
              `\n  Gap before: ${word.gapBefore ?? "-"}` +
              `\n  Gap after: ${word.gapAfter ?? "-"}`;
          }
        }

        if (segmentation.message) {
          details.textContent +=
            `\nSegmentation error: ${segmentation.message}`;
        }
      }

      if (
        segmentation?.status === "insufficient-word-gaps"
      ) {
        details.textContent +=
          `\nExpected words: ${segmentation.expectedWordCount}` +
          `\nAvailable gaps: ${segmentation.detectedGapCount}`;
      }

      resultsList.appendChild(li);
    }

  

    const elapsed = Math.round(performance.now() - start);

    const segmentedLines = inkResults.filter(
      (item) =>
        item.wordSegmentation?.status === "segmented" ||
        item.wordSegmentation?.status === "single-word"
    ).length;

    const segmentedWords = inkResults.reduce(
      (total, item) =>
        total +
        (item.wordSegmentation?.words?.length || 0),
      0
    );

    const lowConfidenceLines = inkResults.filter(
      (item) =>
        item.wordSegmentation?.confidence === "low"
    ).length;

    setStatus(
      `PaddleOCR + OpenCV test completed.\n` +
      `Image: ${selectedBitmap.width} × ${selectedBitmap.height}\n` +
      `PaddleOCR text lines: ${result.items.length}\n` +
      `OpenCV ink rectangles: ${measuredCount}/${result.items.length}\n` +
      `OpenCV errors: ${openCVErrors}\n` +
      `Successfully segmented lines: ${segmentedLines}/${result.items.length}\n` +
      `Candidate word regions: ${segmentedWords}\n` +
      `Low-confidence segmentations: ${lowConfidenceLines}\n` +
      `Total elapsed time: ${elapsed} ms\n\n` +
      `GREEN = PaddleOCR lines.\n` +
      `ORANGE = OpenCV line ink.\n` +
      `BLUE = candidate word regions.`
    );


    window.__PADDLE_SOURCE_BITMAP__ = selectedBitmap;

console.log(
  "[Paddle Source Image]",
  selectedBitmap.width,
  selectedBitmap.height
);

setProgress("Processing complete", 100);
    console.log("PaddleOCR results:", result);
    console.log("OpenCV ink measurements:", inkResults);
  } catch (error) {
    console.error("PaddleOCR + OpenCV test failed:", error);
setProgress("Processing failed", 0);
    setStatus(
      `Test failed.\n${error?.stack || error?.message || error}`
    );
  } finally {
    runButton.disabled = false;
    imageInput.disabled = false;
  }
});

let opencvTestWorker = null;
let opencvTestTimeout = null;

workerTestButton.addEventListener("click", () => {
  console.log("[OpenCV Worker Test] Button clicked.");

  setStatus("Starting OpenCV worker test...");

  workerTestButton.disabled = true;

  // Stop any previous test worker.
  if (opencvTestWorker) {
    opencvTestWorker.terminate();
    opencvTestWorker = null;
  }

  if (opencvTestTimeout) {
    clearTimeout(opencvTestTimeout);
    opencvTestTimeout = null;
  }

  let finished = false;

  function finishWorkerTest() {
    if (finished) return;

    finished = true;

    if (opencvTestTimeout) {
      clearTimeout(opencvTestTimeout);
      opencvTestTimeout = null;
    }

    if (opencvTestWorker) {
      opencvTestWorker.terminate();
      opencvTestWorker = null;
    }

    workerTestButton.disabled = false;
  }

  try {
console.log(
  "[OpenCV Worker Test] Creating classic diagnostic worker."
);

opencvTestWorker = new Worker(
  "/workers/opencv-probe.worker.js"
);

console.log(
  "[OpenCV Worker Test] Classic worker created."
);
    console.log("[OpenCV Worker Test] Worker created.");

    setStatus(
      "Worker created successfully.\n" +
      "Waiting for OpenCV.js initialization..."
    );

    opencvTestWorker.onmessage = (event) => {
      const data = event.data;
if (data.type === "progress") {
  console.log("[OpenCV Worker Progress]", data);

  setStatus(
    data.message +
    (
      data.diagnostics
        ? "\n\n" + JSON.stringify(data.diagnostics, null, 2)
        : ""
    )
  );

  return;
}
      console.log(
        "[OpenCV Worker Test] Message received:",
        data
      );

      if (data.type === "log") {
        console.info("[OpenCV worker]", data.message);
        return;
      }

      if (data.type === "warning") {
        console.warn("[OpenCV worker]", data.message);
        return;
      }

      if (data.type === "ready") {
        setStatus(
          "SUCCESS: OpenCV initialized inside the worker.\n\n" +
          JSON.stringify(data.details, null, 2)
        );

        finishWorkerTest();
        return;
      }

      if (data.type === "error") {
        setStatus(
          "WORKER ERROR:\n\n" +
          (data.message || "Unknown worker error") +
          "\n\n" +
          JSON.stringify(data, null, 2)
        );

        console.error("[OpenCV Worker Test] Initialization error:", data);

        finishWorkerTest();
      }
    };

    opencvTestWorker.onerror = (event) => {
      console.error("[OpenCV Worker Test] Worker error:", event);

      setStatus(
        "WORKER SCRIPT ERROR:\n" +
        (event.message || "Unknown worker script error") +
        "\nFile: " + (event.filename || "Unknown") +
        "\nLine: " + (event.lineno || "Unknown")
      );

      finishWorkerTest();
    };

    opencvTestWorker.onmessageerror = (event) => {
      console.error("[OpenCV Worker Test] Message error:", event);

      setStatus(
        "Worker message could not be decoded."
      );

      finishWorkerTest();
    };

    // Do not wait indefinitely.
    opencvTestTimeout = setTimeout(() => {
      console.error(
        "[OpenCV Worker Test] Timed out after 120 seconds."
      );

      setStatus(
        "TIMEOUT: The worker was created, but OpenCV did not report readiness within 120 seconds.\n\n" +
        "Check the Network tab for opencv-init.worker.js, opencv.js and the WASM file."
      );

      finishWorkerTest();
    }, 520000);

  } catch (error) {
    console.error("[OpenCV Worker Test] Creation failed:", error);

    setStatus(
      "FAILED TO CREATE WORKER:\n" +
      (error.stack || error.message || String(error))
    );

    finishWorkerTest();
  }
});
