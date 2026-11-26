
/**
 * src/ocr/glyph-graphics/glyph-vector-preview.js
 *
 * Interactive preview of extracted vector glyphs.
 *
 * Displays:
 *   1. Original RGBA glyph
 *   2. Original binary mask
 *   3. Reconstructed pixel-boundary SVG
 *
 * Allows:
 *   - Selecting individual characters
 *   - Zooming the glyph representations
 *   - Downloading the selected glyph as SVG
 *
 * Read-only with respect to OCR and document state.
 */

import {
  createGlyphSvg,
  downloadGlyphSvg,
} from "./glyph-svg-exporter.js";

import {
  analyzeMeasuredCharacterComponents,
} from "./glyph-component-analysis.js";


import {
  analyzeGlyphComponentReview,
  createGlyphComponentReviewPanel,
} from "./glyph-component-review.js";

/* -------------------------------------------------------
   1. PANEL
------------------------------------------------------- */

const PANEL_ID = "paddle-glyph-vector-export-panel";

const SCALE = 12;

let activePanel = null;
const activeObjectUrls = new Set();

function releaseObjectUrls() {
  for (const url of activeObjectUrls) {
    URL.revokeObjectURL(url);
  }

  activeObjectUrls.clear();
}

function makePanel() {
  let panel = document.getElementById(PANEL_ID);

  if (panel) {
    activePanel = panel;

    return panel;
  }

  panel = document.createElement("div");

  panel.id = PANEL_ID;

  panel.style.cssText = `
    position:fixed;
    inset:16px;
    z-index:2147483647;
    overflow:auto;
    padding:16px;
    background:#eeeeee;
    color:#111;
    border:2px solid #444;
    box-shadow:0 4px 28px rgba(0,0,0,.4);
    font-family:Arial,sans-serif;
  `;

  const header = document.createElement("div");

  header.style.cssText = `
    position:sticky;
    top:0;
    z-index:5;
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:12px;
    padding:12px;
    background:#fff;
    border-bottom:1px solid #aaa;
  `;

  const heading = document.createElement("strong");

  heading.textContent = "Glyph Vector Export Preview";

  const closeButton = document.createElement("button");

  closeButton.type = "button";
  closeButton.textContent = "Close Preview";

  closeButton.style.cssText = `
    padding:8px 14px;
    cursor:pointer;
  `;

  closeButton.addEventListener("click", () => {
    releaseObjectUrls();
    panel.remove();
    console.warn(
  "[Glyph Vector Preview] PANEL REMOVED BY CLOSE BUTTON"
);
    activePanel = null;
  });

  header.append(
    heading,
    closeButton
  );

  const content = document.createElement("div");

  content.className = "glyph-vector-preview-sections";

  panel.append(
    header,
    content
  );

  document.body.appendChild(panel);

console.log("[Glyph Vector Preview] PANEL MOUNTED:", {
  id: panel.id,
  pageUrl: window.location.href,
  isTopFrame: window === window.top,
  bodyContainsPanel: document.body.contains(panel),
  panelRect: panel.getBoundingClientRect().toJSON(),
});

  activePanel = panel;

  return panel;
}

/* -------------------------------------------------------
   2. VALIDATE PREVIEW DATA
------------------------------------------------------- */

function getAvailableGlyphs(measurement) {
  const characters = Array.isArray(measurement?.characters)
    ? measurement.characters
    : [];

  return characters
    .map((character) => ({
      character,
      glyph: character.originalGlyphShape,
    }))
    .filter(({ character, glyph }) =>
      !/^\s+$/u.test(String(character.text ?? "")) &&
      glyph?.status === "complete" &&
      typeof glyph.pixelBoundaryContourSvgPath === "string" &&
      glyph.pixelBoundaryContourSvgPath.length > 0 &&
      glyph.rgba &&
      glyph.mask
    );
}

/* -------------------------------------------------------
   3. CREATE IMAGE CANVAS
------------------------------------------------------- */


function createGlyphCanvas(glyph, mode) {
  const isAppearance = mode === "appearance";

  const width = Number(
    isAppearance
      ? glyph.appearanceWidth
      : glyph.width
  );

  const height = Number(
    isAppearance
      ? glyph.appearanceHeight
      : glyph.height
  );

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error("Invalid glyph preview dimensions.");
  }

  const canvas = document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Could not create glyph preview canvas.");
  }

  const image = new ImageData(width, height);

  if (mode === "original" || isAppearance) {
    const rgba = isAppearance
      ? glyph.appearanceRgba
      : glyph.rgba;

    if (
      !ArrayBuffer.isView(rgba) ||
      rgba instanceof DataView ||
      rgba.length !== width * height * 4
    ) {
      throw new Error(
        isAppearance
          ? "Appearance RGBA glyph data is invalid."
          : "Original RGBA glyph data is invalid."
      );
    }

    image.data.set(rgba);

  } else if (mode === "mask") {
    if (
      !glyph.mask ||
      glyph.mask.length !== width * height
    ) {
      throw new Error("Binary glyph mask is invalid.");
    }

    for (let i = 0; i < width * height; i++) {
      const ink = glyph.mask[i] !== 0;
      const value = ink ? 15 : 255;
      const offset = i * 4;

      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }

  } else {
    throw new Error(`Unknown glyph preview mode: ${mode}`);
  }

  ctx.putImageData(image, 0, 0);

  canvas.style.cssText = `
    display:block;
    width:${width * SCALE}px;
    height:${height * SCALE}px;
    max-width:none;
    image-rendering:pixelated;
    border:1px solid #bbb;
    background:#fff;
  `;

  return canvas;
}



/* -------------------------------------------------------
   3A. CREATE CONNECTED-COMPONENT COLOUR MAP
------------------------------------------------------- */

function createComponentCanvas(analysis, glyph) {
  const labelMap = analysis?.labelMap;
  const width = Number(glyph?.width);
  const height = Number(glyph?.height);

  const isArrayLike =
    Array.isArray(labelMap) ||
    (ArrayBuffer.isView(labelMap) && !(labelMap instanceof DataView));

  if (
    !isArrayLike ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    labelMap.length !== width * height
  ) {
    console.error("[Glyph Component Canvas] Invalid data:", {
      analysisKeys: analysis ? Object.keys(analysis) : null,
      labelMapType: labelMap?.constructor?.name,
      labelMapLength: labelMap?.length,
      glyphWidth: glyph?.width,
      glyphHeight: glyph?.height,
      expectedLabelMapLength: width * height,
      reportedAnalysisWidth: analysis?.width,
      reportedAnalysisHeight: analysis?.height,
      summary: analysis?.summary,
    });

    throw new Error("Invalid connected-component analysis data.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Could not create component canvas context.");
  }

  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const label = Number(labelMap[y * width + x]);

      // Label 0 represents background.
      if (!Number.isFinite(label) || label <= 0) {
        continue;
      }

      const hue = (label * 137.508) % 360;

      ctx.fillStyle = `hsl(${hue}, 70%, 55%)`;
      ctx.fillRect(
        x * SCALE,
        y * SCALE,
        SCALE,
        SCALE
      );
    }
  }

  return canvas;
}
/* -------------------------------------------------------
   3B. READ-ONLY DETACHED COMPONENT CLASSIFICATION
------------------------------------------------------- */

function getMedianIntensity(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}


function attachCtcNeighborOwnershipAudit(glyphRecords = []) {
  const method = "ctc-adjacent-token-ink-distance";
  const sections = new Map();

  // Organize exported glyphs by preview section and original CTC index.
  for (const record of glyphRecords) {
    const data = record.export || record;
    const glyph = data.glyph;

    if (!glyph || !Number.isInteger(Number(glyph.index))) {
      continue;
    }

    const sectionKey = String(record.sectionIndex ?? 0);

    if (!sections.has(sectionKey)) {
      sections.set(sectionKey, new Map());
    }

    sections.get(sectionKey).set(Number(glyph.index), {
      data,
      glyph
    });
  }

  function getAbsolutePixels(glyph, components) {
    const cropX = Number(glyph.cropBounds?.x);
    const cropY = Number(glyph.cropBounds?.y);

    if (
      !Number.isFinite(cropX) ||
      !Number.isFinite(cropY) ||
      !Array.isArray(components)
    ) {
      return null;
    }

    const pixels = [];

    for (const component of components) {
      if (!Array.isArray(component.pixelRuns)) {
        return null;
      }

      for (const run of component.pixelRuns) {
        if (!Array.isArray(run) || run.length < 3) {
          continue;
        }

        const [row, startX, endX] = run;

        if (
          !Number.isFinite(row) ||
          !Number.isFinite(startX) ||
          !Number.isFinite(endX)
        ) {
          continue;
        }

        for (let x = startX; x < endX; x++) {
          pixels.push([
            cropX + x,
            cropY + row
          ]);
        }
      }
    }

    return pixels;
  }

  function nearestChebyshevDistance(first, second) {
    if (!first.length || !second.length) {
      return null;
    }

    let best = Infinity;

    for (const [ax, ay] of first) {
      for (const [bx, by] of second) {
        const distance = Math.max(
          Math.abs(ax - bx),
          Math.abs(ay - by)
        );

        if (distance < best) {
          best = distance;
        }

        if (best === 0) {
          return 0;
        }
      }
    }

    return Number.isFinite(best) ? best : null;
  }

  const summary = {
    status: "complete",
    method,
    auditedComponents: 0,
    neighborProximal: 0,
    nearNeighbor: 0,
    separatedFromNeighbor: 0,
    noAdjacentExportedGlyph: 0,
    neighborMaskUnavailable: 0
  };

  for (const byIndex of sections.values()) {
    const inkCache = new Map();

    function getGlyphInk(entry) {
      const index = Number(entry.glyph.index);

      if (inkCache.has(index)) {
        return inkCache.get(index);
      }

      const analysis = entry.data.componentAnalysis;

      if (
        analysis?.status !== "complete" ||
        !Array.isArray(analysis.components)
      ) {
        inkCache.set(index, null);
        return null;
      }

      const pixels = getAbsolutePixels(
        entry.glyph,
        analysis.components
      );

      inkCache.set(index, pixels);
      return pixels;
    }

    for (const [glyphIndex, entry] of byIndex) {
      const { data, glyph } = entry;

      const classification = data.componentClassification;
      const analysis = data.componentAnalysis;

      if (
        classification?.status !== "complete" ||
        !Array.isArray(classification.components)
      ) {
        continue;
      }

      const analysisById = new Map(
        (analysis?.components || []).map(component => [
          Number(component.id),
          component
        ])
      );

      for (const component of classification.components) {
        if (
          component.classification !==
          "ctc-cell-edge-fragment-candidate"
        ) {
          continue;
        }

        const sourceComponent = analysisById.get(
          Number(component.id)
        );

        const candidatePixels = sourceComponent
          ? getAbsolutePixels(glyph, [sourceComponent])
          : null;

        const requestedSides = [];

        if (component.touchesCtcLeft) {
          requestedSides.push({
            side: "left",
            index: glyphIndex - 1
          });
        }

        if (component.touchesCtcRight) {
          requestedSides.push({
            side: "right",
            index: glyphIndex + 1
          });
        }

        const neighbors = [];

        for (const requested of requestedSides) {
          const neighborEntry = byIndex.get(requested.index);

          if (!neighborEntry) {
            neighbors.push({
              side: requested.side,
              glyphIndex: requested.index,
              status: "not-present-at-adjacent-index",
              distanceChebyshevPx: null
            });

            continue;
          }

          const neighborPixels = getGlyphInk(neighborEntry);

          if (
            !candidatePixels ||
            !neighborPixels ||
            !candidatePixels.length ||
            !neighborPixels.length
          ) {
            neighbors.push({
              side: requested.side,
              glyphIndex: requested.index,
              character: neighborEntry.glyph.text,
              status: "neighbor-mask-unavailable",
              distanceChebyshevPx: null
            });

            continue;
          }

          const distance = nearestChebyshevDistance(
            candidatePixels,
            neighborPixels
          );

          neighbors.push({
            side: requested.side,
            glyphIndex: requested.index,
            character: neighborEntry.glyph.text,
            status: "measured",
            distanceChebyshevPx: distance
          });
        }

        const measured = neighbors.filter(
          neighbor =>
            neighbor.status === "measured" &&
            Number.isFinite(neighbor.distanceChebyshevPx)
        );

        const nearest = measured.reduce(
          (best, neighbor) =>
            !best ||
            neighbor.distanceChebyshevPx <
              best.distanceChebyshevPx
              ? neighbor
              : best,
          null
        );

        let reviewLabel;

        if (nearest) {
          if (nearest.distanceChebyshevPx <= 1) {
            reviewLabel = "neighbor-proximal";
            summary.neighborProximal++;
          } else if (nearest.distanceChebyshevPx === 2) {
            reviewLabel = "near-neighbor";
            summary.nearNeighbor++;
          } else {
            reviewLabel = "separated-from-neighbor-ink";
            summary.separatedFromNeighbor++;
          }
        } else if (
          neighbors.some(
            neighbor =>
              neighbor.status ===
              "neighbor-mask-unavailable"
          )
        ) {
          reviewLabel = "neighbor-mask-unavailable";
          summary.neighborMaskUnavailable++;
        } else {
          reviewLabel = "no-adjacent-exported-glyph";
          summary.noAdjacentExportedGlyph++;
        }

        // Diagnostic metadata only. Never modify glyph pixels.
        component.neighborOwnershipAudit = {
          status: candidatePixels ? "complete" : "incomplete",
          method,
          boundarySide:
            component.touchesCtcLeft &&
            component.touchesCtcRight
              ? "both"
              : component.touchesCtcLeft
                ? "left"
                : "right",

          sameGlyphLargestDistancePx:
            sourceComponent?.distanceFromLargest?.value ?? null,

          neighbors,
          nearestNeighbor: nearest
            ? {
                character: nearest.character,
                glyphIndex: nearest.glyphIndex,
                side: nearest.side,
                distanceChebyshevPx:
                  nearest.distanceChebyshevPx
              }
            : null,

          reviewLabel,

          note:
            "Read-only ownership evidence. No mask pixels were removed or modified."
        };

        summary.auditedComponents++;
      }
    }
  }

  return summary;
}


function classifyGlyphComponents(glyph, analysis) {
  const width = Number(glyph.width);
  const height = Number(glyph.height);

  const glyphBounds = glyph.cropBounds;
  const appearanceBounds = glyph.appearanceCropBounds;

  const appearance = glyph.appearanceRgba;

  const labelMap = analysis?.labelMap;

  const validLabelMap =
    Array.isArray(labelMap) ||
    (
      ArrayBuffer.isView(labelMap) &&
      !(labelMap instanceof DataView)
    );

  const validAppearance =
    ArrayBuffer.isView(appearance) &&
    !(appearance instanceof DataView) &&
    appearance.length ===
      Number(glyph.appearanceWidth) *
      Number(glyph.appearanceHeight) * 4;

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !glyphBounds ||
    !appearanceBounds ||
    !validAppearance ||
    !validLabelMap ||
    labelMap.length !== width * height
  ) {
    return {
      status: "unavailable",
      reason: "Invalid glyph or appearance diagnostic data.",
      components: [],
    };
  }

  const largestId =
    analysis.summary?.largestComponentId;

  const largest =
    analysis.components.find(
      component => component.id === largestId
    );

  if (!largest?.bounds) {
    return {
      status: "unavailable",
      reason: "Largest component is unavailable.",
      components: [],
    };
  }

  const mainBounds = largest.bounds;

  const appearanceWidth =
    Number(glyph.appearanceWidth);

  const appearanceHeight =
    Number(glyph.appearanceHeight);

  const cellLeft =
    Number(glyph.cellBounds?.pixelLeft) -
    Number(glyphBounds.x);

  const cellRight =
    Number(glyph.cellBounds?.pixelRightExclusive) -
    Number(glyphBounds.x);

  const output = [];

  const counts = {};

  for (const component of analysis.components) {
    if (component.id === largestId) continue;

    const bounds = component.bounds;

    const pixelPositions = [];

    for (const run of component.pixelRuns || []) {
      const [y, x0, x1] = run;

      for (let x = x0; x < x1; x++) {
        pixelPositions.push([x, y]);
      }
    }

    if (!pixelPositions.length) {
      output.push({
        id: component.id,
        classification: "pixel-runs-unavailable",
        pixelCount: component.pixelCount,
      });

      continue;
    }

    const componentPixels = new Set(
      pixelPositions.map(
        ([x, y]) => y * width + x
      )
    );

    const inkSamples = [];
    const backgroundSamples = [];

    function sampleGray(x, y) {
      const globalX =
        Number(glyphBounds.x) + x;

      const globalY =
        Number(glyphBounds.y) + y;

      const localX =
        globalX - Number(appearanceBounds.x);

      const localY =
        globalY - Number(appearanceBounds.y);

      if (
        localX < 0 ||
        localX >= appearanceWidth ||
        localY < 0 ||
        localY >= appearanceHeight
      ) {
        return null;
      }

      const offset =
        (localY * appearanceWidth + localX) * 4;

      const alpha = appearance[offset + 3] / 255;

      const gray =
        0.299 * appearance[offset] +
        0.587 * appearance[offset + 1] +
        0.114 * appearance[offset + 2];

      return Math.round(
        gray * alpha + 255 * (1 - alpha)
      );
    }

    // Original grayscale values at component pixels.
    for (const [x, y] of pixelPositions) {
      const gray = sampleGray(x, y);

      if (gray !== null) {
        inkSamples.push(gray);
      }
    }

    // Sample surrounding background pixels only.
    for (const [x, y] of pixelPositions) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;

          const nx = x + dx;
          const ny = y + dy;

          if (
            nx < 0 ||
            nx >= width ||
            ny < 0 ||
            ny >= height
          ) {
            continue;
          }

          const index = ny * width + nx;

          if (
            componentPixels.has(index) ||
            labelMap[index] !== 0
          ) {
            continue;
          }

          const gray = sampleGray(nx, ny);

          if (gray !== null) {
            backgroundSamples.push(gray);
          }
        }
      }
    }

    const inkMedian =
      getMedianIntensity(inkSamples);

    const backgroundMedian =
      getMedianIntensity(backgroundSamples);

    const localContrast =
      inkMedian === null ||
      backgroundMedian === null
        ? null
        : Math.abs(inkMedian - backgroundMedian);

    // Component geometry relative to the largest component.
    const componentRight =
      bounds.x + bounds.width;

    const componentBottom =
      bounds.y + bounds.height;

    const mainCenterX =
      mainBounds.x + mainBounds.width / 2;

    const componentCenterX =
      bounds.x + bounds.width / 2;

    const verticalGap =
      componentBottom <= mainBounds.y
        ? mainBounds.y - componentBottom
        : null;

    const alignedAboveMain =
      verticalGap !== null &&
      verticalGap <= 3 &&
      Math.abs(componentCenterX - mainCenterX) <=
        Math.max(1, mainBounds.width * 0.4);

   const isDotCandidate =
  ["i", "j"].includes(
    String(glyph.text)
  ) &&
      alignedAboveMain &&
      bounds.width <= 4 &&
      bounds.height <= 4 &&
      component.pixelCount >= 2;

    // True CTC horizontal cell boundary checks.
    const touchesCtcLeft =
      Number.isFinite(cellLeft) &&
      bounds.x <= cellLeft;

    const touchesCtcRight =
      Number.isFinite(cellRight) &&
      componentRight >= cellRight;

    let classification =
      "ambiguous-detached-component";

    let reason =
      "Insufficient evidence for a more specific classification.";

    if (isDotCandidate) {
      classification = "likely-i-or-j-dot-candidate";

      reason =
        "Small component above and horizontally aligned with the main character stroke.";

    } else if (
      component.pixelCount <= 2 &&
      localContrast !== null &&
      localContrast < 10
    ) {
      classification = "low-contrast-speck-candidate";

      reason =
        "Very small component with weak local grayscale contrast.";

    } else if (
      touchesCtcLeft ||
      touchesCtcRight
    ) {
      classification = "ctc-cell-edge-fragment-candidate";

      reason =
        "Component touches a horizontal CTC cell boundary and may require ownership review.";
    }

    counts[classification] =
      (counts[classification] || 0) + 1;

    output.push({
      id: component.id,

      classification,
      reason,

      pixelCount: component.pixelCount,

      bounds,

      distanceFromLargest:
        component.distanceFromLargest?.value ?? null,

      touchesCtcLeft,
      touchesCtcRight,

      measurementEvidence:
        component.measurementSelectionEvidence,

      grayscale: {
        inkMedian,
        backgroundMedian,
        localContrast,
      },

      geometry: {
        verticalGap,
        horizontalOffsetFromMain:
          Number(
            (componentCenterX - mainCenterX).toFixed(2)
          ),
      },
    });
  }

  return {
    status: "complete",

    method:
      "read-only-geometry-and-grayscale-classification",

    componentCount: output.length,

    classificationCounts: counts,

    note:
      "Classification candidates only. No binary mask pixels or glyph data were modified.",

    components: output,
  };
}

/* -------------------------------------------------------
   4. CREATE VIEW CARD
------------------------------------------------------- */

function createViewCard(title) {
  const card = document.createElement("div");

  card.style.cssText = `
    min-width:0;
    padding:12px;
    background:#fff;
    border:1px solid #ccc;
    border-radius:5px;
  `;

  const heading = document.createElement("strong");

  heading.textContent = title;

  heading.style.cssText = `
    display:block;
    margin-bottom:12px;
    font-size:13px;
  `;

  const viewport = document.createElement("div");

  viewport.style.cssText = `
    min-height:210px;
    overflow:auto;
    display:flex;
    align-items:center;
    justify-content:flex-start;
    padding:8px;
    background:#fafafa;
    border:1px solid #eee;
  `;

  card.append(
    heading,
    viewport
  );

  return {
    card,
    viewport,
  };
}

/* -------------------------------------------------------
   5. SVG IMAGE
------------------------------------------------------- */


function createSvgImage(glyph) {
  const svgMarkup = createGlyphSvg(glyph, {
    fill: "#111111",
    title: `Original glyph ${glyph.text}`,
  });

  if (
    typeof svgMarkup !== "string" ||
    !svgMarkup.includes("<svg")
  ) {
    throw new Error("Generated SVG markup is invalid.");
  }

  const blob = new Blob(
    [svgMarkup],
    {
      type: "image/svg+xml",
    }
  );

  const url = URL.createObjectURL(blob);

  activeObjectUrls.add(url);

  const image = document.createElement("img");

  image.alt = `Vector reconstruction of ${glyph.text}`;

  image.src = url;

  image.style.cssText = `
    display:block;
    width:${Number(glyph.width) * SCALE}px;
    height:${Number(glyph.height) * SCALE}px;
    max-width:none;
    background:#fff;
  `;

  // Preserve the actual SVG markup for permanent export.
  return {
    image,
    svgMarkup,
  };
}


/* -------------------------------------------------------
   6. RENDER SELECTED GLYPH
------------------------------------------------------- */

function renderSelectedGlyph(
  glyph,
  content,
  information,
  character,
  diagnostics = null
) {
  for (const url of [...activeObjectUrls]) {
    URL.revokeObjectURL(url);
    activeObjectUrls.delete(url);
  }

  content.replaceChildren();

  const width = Number(glyph.width);
  const height = Number(glyph.height);

// Run connected-component analysis on the selected character.
// The original glyph and binary mask remain unchanged.
let componentReview = null;

let componentAnalysis = null;
let componentAnalysisError = null;
// Preserve the actual SVG markup for renderedPreview export.
let renderedSvgMarkup = null;

try {
 componentAnalysis =
  diagnostics?.componentAnalysis ??
  analyzeMeasuredCharacterComponents(character);

  console.groupCollapsed(
    "[Glyph Component Analysis]",
    glyph.text,
    glyph.index
  );

  console.log(
    "Analysis summary:",
    componentAnalysis.summary
  );

  console.table(
    componentAnalysis.components.map(component => ({
      id: component.id,

      pixelCount: component.pixelCount,

      x: component.bounds.x,
      y: component.bounds.y,

      width: component.bounds.width,
      height: component.bounds.height,

      centroidX: Number(
        component.centroid.x.toFixed(2)
      ),

      centroidY: Number(
        component.centroid.y.toFixed(2)
      ),

      distanceFromLargest:
        component.distanceFromLargest.value,

      role: component.role,

      touchesCropBoundary:
        component.touchesGlyphCropBoundary,

      measurementEvidence:
        component.measurementSelectionEvidence,
    }))
  );

  console.groupEnd();

} catch (error) {
  componentAnalysisError =
    error?.message || String(error);

  console.error(
    "[Glyph Component Analysis] Failed:",
    error
  );
}


let componentClassification =
  diagnostics?.componentClassification ?? null;

if (!componentClassification && componentAnalysis) {
  try {
    componentClassification =
      classifyGlyphComponents(
        glyph,
        componentAnalysis
      );

  } catch (error) {
    componentClassification = {
      status: "error",
      reason: error?.message || String(error),
      components: [],
    };

    console.warn(
      "[Glyph Component Classification] Failed:",
      error
    );
  }
}

 information.textContent = [
  
  `Character: "${glyph.text}"`,
  `Index: ${glyph.index}`,
  `Tight RGBA: ${glyph.width} × ${glyph.height} px`,
  `Appearance RGBA: ${
    glyph.appearanceWidth ?? "unavailable"
  } × ${
    glyph.appearanceHeight ?? "unavailable"
  } px`,
  `Appearance status: ${
    glyph.appearanceStatus ?? "not captured"
  }`,
  `Appearance crop: ${
    JSON.stringify(glyph.appearanceCropBounds ?? null)
  }`,
].join("  |  ");

information.style.color =
  glyph.appearanceStatus === "complete"
    ? "#176b36"
    : "#a00";

  const views = document.createElement("div");

  views.style.cssText = `
    display:grid;
    grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
    gap:12px;
    margin-top:14px;
  `;

  try {

    
// 1. Existing tight RGBA crop.
const originalView = createViewCard(
  "1. Original RGBA — Tight Binary Crop"
);

originalView.viewport.appendChild(
  createGlyphCanvas(glyph, "original")
);

// 2. Original RGBA appearance crop.
const appearanceView = createViewCard(
  "2. Original RGBA — Appearance Crop"
);

const appearanceWidth = Number(glyph.appearanceWidth);
const appearanceHeight = Number(glyph.appearanceHeight);

const appearanceDataValid =
  glyph.appearanceStatus === "complete" &&
  ArrayBuffer.isView(glyph.appearanceRgba) &&
  !(glyph.appearanceRgba instanceof DataView) &&
  Number.isInteger(appearanceWidth) &&
  Number.isInteger(appearanceHeight) &&
  appearanceWidth > 0 &&
  appearanceHeight > 0 &&
  glyph.appearanceRgba.length ===
    appearanceWidth * appearanceHeight * 4;

if (appearanceDataValid) {
  appearanceView.viewport.appendChild(
    createGlyphCanvas(glyph, "appearance")
  );
} else {
  const unavailable = document.createElement("p");

  unavailable.textContent =
    "Appearance RGBA is unavailable or invalid.";

  appearanceView.viewport.appendChild(unavailable);
}

views.append(
  originalView.card,
  appearanceView.card
);

    content.appendChild(views);

// Display individual connected-component measurements.
if (componentAnalysis) {
  const details = document.createElement("pre");

  details.style.cssText = `
    margin-top:12px;
    padding:12px;
    background:#fff;
    border:1px solid #ddd;
    font:12px/1.7 monospace;
    white-space:pre-wrap;
    overflow-wrap:anywhere;
  `;

  details.textContent =
    componentAnalysis.components.map(component => {
      const distance =
        component.distanceFromLargest.value;

      return [
        `Component #${component.id}`,
        `Pixels: ${component.pixelCount}`,
        `Bounds: ${component.bounds.width} × ${component.bounds.height}`,
        `Position: (${component.bounds.x}, ${component.bounds.y})`,
        `Distance from largest: ${distance ?? "Beyond search radius"}`,
        `Role: ${component.role}`,
        `Crop boundary: ${component.touchesGlyphCropBoundary}`,
        `Existing measurement: ${component.measurementSelectionEvidence}`,
      ].join(" | ");
    }).join("\\n\\n");

  content.appendChild(details);
}

    const note = document.createElement("p");

    note.textContent =
      "The SVG uses glyph-local coordinates. Its viewBox preserves the original glyph dimensions. " +
      "The black SVG shows the binary silhouette, not the original text colour or antialiased edges.";

    note.style.cssText = `
      margin-top:14px;
      padding:10px;
      background:#fff;
      border:1px solid #ddd;
      font-size:12px;
      line-height:1.6;
      color:#555;
    `;

    content.appendChild(note);

    
  } catch (error) {
    const errorMessage = document.createElement("p");

    errorMessage.textContent =
      `Preview failed: ${error?.message || String(error)}`;

    errorMessage.style.color = "#a00";

    content.appendChild(errorMessage);

    console.error(
      "[Glyph Vector Preview] Rendering failed:",
      error
    );
  }



// Temporary full preview export for browser console.
const characterMetadata =
  character && typeof character === "object"
    ? Object.fromEntries(
        Object.entries(character).filter(
          ([key]) => key !== "originalGlyphShape"
        )
      )
    : character;

// Create a separate snapshot so the live preview is not modified.
const exportContent = content.cloneNode(true);

// Replace temporary Blob URL with a permanent SVG data URL.
const exportedSvgImage = exportContent.querySelector(
  'img[alt^="Vector reconstruction of"]'
);

if (exportedSvgImage && renderedSvgMarkup) {
  exportedSvgImage.setAttribute(
    "src",
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      renderedSvgMarkup
    )}`
  );
}



window.__GLYPH_VECTOR_PREVIEW_EXPORT__ = {
  
  format: "glyph-vector-preview-export-v1",
  exportedAt: new Date().toISOString(),

  character: characterMetadata,

  glyph,

componentAnalysis,
componentReview,

// Read-only detached-component classification.
componentClassification,

// Line-wide CTC neighboring-character ownership audit.
neighborOwnershipAuditSummary:
  diagnostics?.neighborOwnershipAuditSummary ?? null,

componentAnalysisError:
  componentAnalysisError || null,
  renderedPreview: {
    // HTML now contains a persistent SVG data URL, not a Blob URL.
    html: exportContent.innerHTML,

    // Preserve all canvas previews as PNG images.
    canvases: Array.from(
      content.querySelectorAll("canvas")
    ).map((canvas, index) => ({
      index,
      width: canvas.width,
      height: canvas.height,

      png: (() => {
        try {
          return canvas.toDataURL("image/png");
        } catch (error) {
          return `Canvas export failed: ${error.message}`;
        }
      })(),
    })),

    // Store actual SVG markup, not DOM-discovered SVG elements.
    svgs: renderedSvgMarkup
      ? [renderedSvgMarkup]
      : [],
  },
};

console.log(
  "[Glyph Vector Preview] Export data is ready:",
  window.__GLYPH_VECTOR_PREVIEW_EXPORT__
);



}

/* -------------------------------------------------------
   7. PUBLIC PREVIEW API
------------------------------------------------------- */

/**
 * Display an interactive vector preview for one OCR line.
 *
 * Usage:
 *
 * showGlyphVectorPreview(
 *   record.text,
 *   record.characterMeasurements
 * );
 */

export function showGlyphVectorPreview(
  label,
  measurement
) {
  if (
    typeof document === "undefined" ||
    !measurement
  ) {
    return null;
  }

console.log("[Glyph Vector Preview] API INVOKED:", {
  pageUrl: window.location.href,
  isTopFrame: window === window.top,
  measurementHasCharacters:
    Array.isArray(measurement.characters),
  measurementCharacterCount:
    measurement.characters?.length ?? 0,
});

  const glyphRecords = getAvailableGlyphs(measurement);

  if (!glyphRecords.length) {
    console.warn(
      "[Glyph Vector Preview] No complete glyphs available:",
      label
    );

    return null;
  }

/* -------------------------------------------------------
   PREPARE LINE-WIDE CTC NEIGHBOR OWNERSHIP AUDIT

   Analyze all available glyphs in this OCR line once.
   Preserve original glyph data and masks.
------------------------------------------------------- */

const ownershipAuditRecords = glyphRecords.map(
  ({ character, glyph }) => {
    let componentAnalysis = null;
    let componentClassification = null;
    let componentAnalysisError = null;

    try {
      componentAnalysis =
        analyzeMeasuredCharacterComponents(character);

      componentClassification =
        classifyGlyphComponents(
          glyph,
          componentAnalysis
        );

    } catch (error) {
      componentAnalysisError =
        error?.message || String(error);

      componentClassification = {
        status: "error",
        reason: componentAnalysisError,
        components: [],
      };
    }

    return {
      sectionIndex: String(label),

      export: {
        glyph,
        componentAnalysis,
        componentClassification,
        componentAnalysisError,
      },
    };
  }
);

// Compare detached components against actual adjacent CTC indices.
const neighborOwnershipAuditSummary =
  attachCtcNeighborOwnershipAudit(
    ownershipAuditRecords
  );

// Make the line-level audit summary available to each glyph export.
const diagnosticsByGlyphIndex = new Map();

for (const record of ownershipAuditRecords) {
  const data = record.export;

  data.neighborOwnershipAuditSummary =
    neighborOwnershipAuditSummary;

  diagnosticsByGlyphIndex.set(
    Number(data.glyph.index),
    data
  );
}

console.group(
  "[Glyph CTC Neighbor Ownership Audit]"
);

console.log(
  "Line audit summary:",
  neighborOwnershipAuditSummary
);

console.groupEnd();

  const panel = makePanel();

  const section = document.createElement("section");

  section.style.cssText = `
    margin:16px 0;
    padding:14px;
    background:#fff;
    border:1px solid #aaa;
  `;

  const heading = document.createElement("h3");

  heading.textContent =
    `${label} — Select and Export a Vector Glyph`;

  heading.style.cssText =
    "margin:0 0 12px;font-size:16px;";

  const controls = document.createElement("div");

  controls.style.cssText = `
    display:flex;
    flex-wrap:wrap;
    align-items:center;
    gap:10px;
  `;

  const selectLabel = document.createElement("label");

  selectLabel.textContent = "Select character:";

  const select = document.createElement("select");

  select.style.cssText = `
    min-width:180px;
    padding:8px;
    font-size:13px;
  `;

  glyphRecords.forEach(({ glyph }, position) => {
    const option = document.createElement("option");

    option.value = String(position);

    option.textContent =
      `#${glyph.index} "${glyph.text}" (${glyph.width}×${glyph.height})`;

    select.appendChild(option);
  });

  const downloadButton = document.createElement("button");

  downloadButton.type = "button";
  downloadButton.textContent = "Download Selected SVG";

  downloadButton.style.cssText = `
    padding:9px 14px;
    cursor:pointer;
    font-weight:bold;
  `;

  const information = document.createElement("div");

  information.style.cssText = `
    margin-top:12px;
    padding:10px;
    background:#f5f5f5;
    border:1px solid #ddd;
    font-size:12px;
    line-height:1.7;
    overflow-wrap:anywhere;
  `;

  const previewContent = document.createElement("div");

  controls.append(
    selectLabel,
    select,
    downloadButton
  );

  section.append(
    heading,
    controls,
    information,
    previewContent
  );

  const sections = panel.querySelector(
    ".glyph-vector-preview-sections"
  );

  sections.appendChild(section);

  function getSelectedRecord() {
    const position = Number(select.value);

    return glyphRecords[position] || null;
  }

function updatePreview() {
  const selected = getSelectedRecord();

  if (!selected) return;

  const diagnostics =
    diagnosticsByGlyphIndex.get(
      Number(selected.glyph.index)
    ) ?? null;

  renderSelectedGlyph(
    selected.glyph,
    previewContent,
    information,
    selected.character,
    diagnostics
  );
}

  select.addEventListener(
    "change",
    updatePreview
  );

  downloadButton.addEventListener(
    "click",
    () => {
      const selected = getSelectedRecord();

      if (!selected) return;

      try {
        const result = downloadGlyphSvg(
          selected.glyph
        );

        console.log(
          "[Glyph SVG Export]",
          result
        );

      } catch (error) {
        console.error(
          "[Glyph SVG Export] Failed:",
          error
        );

        alert(
          error?.message ||
          "Could not export the selected glyph."
        );
      }
    }
  );

  // Initial selection.
  select.value = "0";

  updatePreview();

  console.log(
    "[Glyph Vector Preview] Ready:",
    {
      text: label,
      availableGlyphs: glyphRecords.length,
      coordinateSpace: "glyph-local",
      exportFormat: "SVG",
    }
  );

  return {
    status: "ready",
    glyphCount: glyphRecords.length,
    panel,
  };
}
