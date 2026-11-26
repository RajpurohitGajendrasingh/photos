/**
 * src/ocr/paddle-typography-matcher.js
 *
 * Catalog-backed typography matching against original image pixels.
 *
 * Estimates:
 * - Google Fonts and system font family
 * - Font weight
 * - Normal / italic style
 * - Font size
 * - Horizontal width correction
 *
 * Diagnostic only. Does not modify document state.
 */

import {
  getGoogleFontCatalog,
  loadGoogleFontFamily,
} from "./google-font-loader.js";


/* =========================================================
   SYSTEM FONT CANDIDATES
   ========================================================= */

const SYSTEM_FONT_CANDIDATES = [
  { family: "Arial", fallback: "sans-serif", source: "system" },
  { family: "Calibri", fallback: "sans-serif", source: "system" },
  { family: "Segoe UI", fallback: "sans-serif", source: "system" },
  { family: "Tahoma", fallback: "sans-serif", source: "system" },
  { family: "Verdana", fallback: "sans-serif", source: "system" },
  { family: "Trebuchet MS", fallback: "sans-serif", source: "system" },
  { family: "Cambria", fallback: "serif", source: "system" },
  { family: "Georgia", fallback: "serif", source: "system" },
  { family: "Times New Roman", fallback: "serif", source: "system" },
  { family: "Garamond", fallback: "serif", source: "system" },
  { family: "Courier New", fallback: "monospace", source: "system" },
];

const FONT_LOAD_SAMPLE_TEXT =
  "Hamburgefontsiv 0123456789";

/* =========================================================
   GOOGLE FONT SEARCH SETTINGS
   ========================================================= */

/*
 * These are common document and resume fonts.
 *
 * They receive priority, but the matcher also samples
 * additional families from the complete catalog.
 */
const PREFERRED_GOOGLE_FAMILIES = [
  "Advent Pro",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Poppins",
  "Inter",
  "Roboto Condensed",
  "Source Sans 3",
  "Noto Sans",
  "Nunito",
  "Ubuntu",
  "Work Sans",
  "IBM Plex Sans",
  "PT Sans",
  "Raleway",
  "Rubik",
  "Libre Franklin",
  "Manrope",
  "DM Sans",
  "Fira Sans",
  "Karla",
  "Mulish",
  "Assistant",
  "Cabin",
  "Public Sans",
  "Arimo",
  "Merriweather",
  "Playfair Display",
  "Lora",
  "Libre Baskerville",
  "Source Serif 4",
  "PT Serif",
  "Noto Serif",
  "EB Garamond",
  "Cormorant Garamond",
  "Bitter",
  "Roboto Slab",
  "IBM Plex Serif",
  "Spectral",
  "Crimson Text",
  "Oswald",
  "Bebas Neue",
  "Anton",
  "Archivo",
  "Lexend",
  "Quicksand",
  "Figtree",
  "Plus Jakarta Sans",
];

const MAX_GOOGLE_FAMILIES = 64;
const MAX_REFINE_FAMILIES = 8;
const FONT_LOAD_CONCURRENCY = 2;

const REFINE_WEIGHTS = [
  300,
  400,
  500,
  600,
  700,
  800,
  900,
];

const SOURCE_INK_THRESHOLD = 18;
const CANDIDATE_ALPHA_THRESHOLD = 40;

const CROP_PADDING = 3;
const MAX_CROP_PIXELS = 300_000;

const MAX_COMPARISON_PIXELS = 450_000;
/* =========================================================
   COLOR HELPERS
   ========================================================= */

function hexToRgb(hex) {
  const value = String(hex || "").trim();

  const match = value.match(
    /^#?([0-9a-f]{6})$/i
  );

  if (!match) {
    return null;
  }

  const number = parseInt(match[1], 16);

  return [
    (number >> 16) & 255,
    (number >> 8) & 255,
    number & 255,
  ];
}


/* =========================================================
   MASK HELPERS
   ========================================================= */

function dilateMask(mask, width, height) {
  const result = new Uint8Array(mask.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;

      if (!mask[index]) {
        continue;
      }

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;

        if (ny < 0 || ny >= height) {
          continue;
        }

        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;

          if (nx < 0 || nx >= width) {
            continue;
          }

          result[ny * width + nx] = 1;
        }
      }
    }
  }

  return result;
}


function countMaskPixels(mask) {
  let count = 0;

  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      count++;
    }
  }

  return count;
}


/**
 * Compare two binary glyph masks.
 *
 * Combines:
 * - Tolerant pixel overlap.
 * - Exact pixel overlap.
 * - Vertical ink distribution (row profile).
 * - Horizontal ink distribution (column profile).
 * - Overall ink-area balance.
 *
 * The projection profiles help distinguish fonts whose
 * overall text shapes are similar but whose glyph geometry
 * and spacing differ.
 */
function compareMasks(
  originalMask,
  candidateMask,
  width,
  height
) {
  const originalCount =
    countMaskPixels(originalMask);

  const candidateCount =
    countMaskPixels(candidateMask);

  if (!originalCount || !candidateCount) {
    return {
      score: 0,
      tolerantF1: 0,

      precision: 0,
      recall: 0,

      exactPrecision: 0,
      exactRecall: 0,
      exactF1: 0,

      rowProfileScore: 0,
      columnProfileScore: 0,

      areaBalance: 0,

      originalPixels: originalCount,
      candidatePixels: candidateCount,
    };
  }

  const expandedOriginal = dilateMask(
    originalMask,
    width,
    height
  );

  const expandedCandidate = dilateMask(
    candidateMask,
    width,
    height
  );

  let candidateHits = 0;
  let originalHits = 0;
  let exactIntersection = 0;

  const originalRows = new Float64Array(height);
  const candidateRows = new Float64Array(height);

  const originalColumns = new Float64Array(width);
  const candidateColumns = new Float64Array(width);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;

    for (let x = 0; x < width; x++) {
      const index = rowOffset + x;

      const originalInk = originalMask[index] ? 1 : 0;
      const candidateInk = candidateMask[index] ? 1 : 0;

      if (originalInk) {
        originalRows[y]++;
        originalColumns[x]++;
      }

      if (candidateInk) {
        candidateRows[y]++;
        candidateColumns[x]++;
      }

      if (candidateInk && expandedOriginal[index]) {
        candidateHits++;
      }

      if (originalInk && expandedCandidate[index]) {
        originalHits++;
      }

      if (originalInk && candidateInk) {
        exactIntersection++;
      }
    }
  }

  // Tolerant overlap: allows small rasterization differences.
  const precision =
    candidateHits / candidateCount;

  const recall =
    originalHits / originalCount;

  const tolerantF1 =
    precision + recall > 0
      ? 2 * precision * recall /
        (precision + recall)
      : 0;

  // Exact overlap: no dilation.
  const exactPrecision =
    exactIntersection / candidateCount;

  const exactRecall =
    exactIntersection / originalCount;

  const exactF1 =
    exactPrecision + exactRecall > 0
      ? 2 * exactPrecision * exactRecall /
        (exactPrecision + exactRecall)
      : 0;

  /*
   * Compare normalized ink distributions.
   *
   * Normalization prevents the raw number of pixels from
   * dominating the comparison. The location and distribution
   * of the ink remain important.
   */
  function profileSimilarity(
    originalProfile,
    candidateProfile,
    originalTotal,
    candidateTotal
  ) {
    if (!originalTotal || !candidateTotal) {
      return 0;
    }

    let difference = 0;

    for (let i = 0; i < originalProfile.length; i++) {
      const originalValue =
        originalProfile[i] / originalTotal;

      const candidateValue =
        candidateProfile[i] / candidateTotal;

      difference += Math.abs(
        originalValue - candidateValue
      );
    }

    // Normalized L1 distance has a maximum of 2.
    return Math.max(
      0,
      Math.min(1, 1 - difference * 0.5)
    );
  }

  const rowProfileScore = profileSimilarity(
    originalRows,
    candidateRows,
    originalCount,
    candidateCount
  );

  const columnProfileScore = profileSimilarity(
    originalColumns,
    candidateColumns,
    originalCount,
    candidateCount
  );

  const areaBalance =
    Math.min(originalCount, candidateCount) /
    Math.max(originalCount, candidateCount);

  /*
   * Combined shape score.
   *
   * Tolerant overlap remains the largest contribution.
   * Exact overlap and projection profiles add independent
   * evidence about glyph shape and character spacing.
   */
  const score =
    0.48 * tolerantF1 +
    0.22 * exactF1 +
    0.13 * rowProfileScore +
    0.13 * columnProfileScore +
    0.04 * areaBalance;

  return {
    score,

    tolerantF1,

    // These retain the original tolerant precision/recall meaning.
    precision,
    recall,

    exactPrecision,
    exactRecall,
    exactF1,

    rowProfileScore,
    columnProfileScore,

    areaBalance,

    originalPixels: originalCount,
    candidatePixels: candidateCount,
  };
}


/* =========================================================
   ORIGINAL IMAGE MASK
   ========================================================= */

function createOriginalInkMask({
  raster,
  bounds,
  backgroundColor,
}) {
  if (
    !raster?.source ||
    !bounds ||
    !Array.isArray(backgroundColor)
  ) {
    return null;
  }

  const scaleX = Number(raster.scaleX);
  const scaleY = Number(raster.scaleY);

  if (
    !Number.isFinite(scaleX) ||
    !Number.isFinite(scaleY) ||
    scaleX <= 0 ||
    scaleY <= 0
  ) {
    return null;
  }

  const targetPixelLeft =
    bounds.x * scaleX;

  const targetPixelTop =
    bounds.y * scaleY;

  const targetPixelWidth =
    bounds.width * scaleX;

  const targetPixelHeight =
    bounds.height * scaleY;

  const left = Math.max(
    0,
    Math.floor(targetPixelLeft) - CROP_PADDING
  );

  const top = Math.max(
    0,
    Math.floor(targetPixelTop) - CROP_PADDING
  );

  const right = Math.min(
    raster.bitmapWidth,
    Math.ceil(
      targetPixelLeft + targetPixelWidth
    ) + CROP_PADDING
  );

  const bottom = Math.min(
    raster.bitmapHeight,
    Math.ceil(
      targetPixelTop + targetPixelHeight
    ) + CROP_PADDING
  );

  const width = right - left;
  const height = bottom - top;

  if (
    width < 4 ||
    height < 4 ||
    width * height > MAX_CROP_PIXELS
  ) {
    return null;
  }

  const canvas = document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!context) {
    return null;
  }

  context.drawImage(
    raster.source,
    left,
    top,
    width,
    height,
    0,
    0,
    width,
    height
  );

  const imageData = context.getImageData(
    0,
    0,
    width,
    height
  );

  const data = imageData.data;

  const mask = new Uint8Array(
    width * height
  );

  const targetLeft =
    targetPixelLeft - left;

  const targetTop =
    targetPixelTop - top;

  const targetRight =
    targetLeft + targetPixelWidth;

  const targetBottom =
    targetTop + targetPixelHeight;

  let foregroundCount = 0;

  for (let y = 0; y < height; y++) {
    if (
      y < targetTop ||
      y >= targetBottom
    ) {
      continue;
    }

    for (let x = 0; x < width; x++) {
      if (
        x < targetLeft ||
        x >= targetRight
      ) {
        continue;
      }

      const index = (y * width + x) * 4;

      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      const alpha = data[index + 3];

      if (alpha < 200) {
        continue;
      }

      const dr = red - backgroundColor[0];
      const dg = green - backgroundColor[1];
      const db = blue - backgroundColor[2];

      const distance = Math.sqrt(
        dr * dr + dg * dg + db * db
      );

      if (distance >= SOURCE_INK_THRESHOLD) {
        mask[y * width + x] = 1;
        foregroundCount++;
      }
    }
  }

  if (foregroundCount < 20) {
    return null;
  }
return {
  canvas,
  mask,
  width,
  height,
  foregroundCount,

  targetLeft,
  targetTop,

  targetWidth: targetPixelWidth,
  targetHeight: targetPixelHeight,

  scaleX,
  scaleY,

  // Original raster coordinates of this comparison crop.
  sourceCropLeft: left,
  sourceCropTop: top,
};
}

/* =========================================================
   ORIGINAL GLYPH EXTRACTION
   ========================================================= */

/**
 * Extract individual source glyph masks using:
 *
 * 1. Original page raster pixels.
 * 2. OpenCV character measurements.
 * 3. CTC-centered estimatedRegion boundaries.
 *
 * This first version is diagnostic only. It does not
 * modify OCR results or font rankings.
 */
function medianNumber(values) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort(
    (a, b) => a - b
  );

  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}


function getGlyphClass(text) {
  if (/^[•●▪◦‣*-]$/u.test(text)) {
    return "bullet";
  }

  if (/^\p{L}$/u.test(text)) {
    return "letter";
  }

  if (/^\p{N}$/u.test(text)) {
    return "digit";
  }

  return "punctuation";
}


function buildComponentRunGlyphDiagnostics(
  characterMeasurements,
  ownershipThreshold = 0.50
) {
  const characters = Array.isArray(
    characterMeasurements?.characters
  )
    ? characterMeasurements.characters
    : [];

  const glyphs = [];

  const diagnostics = {
    status: "complete",
    ownershipThreshold,

    measuredCharacterCount: 0,
    extractedGlyphCount: 0,

    totalComponents: 0,
    acceptedComponents: 0,
    rejectedComponents: 0,

    missingRunComponents: 0,
    componentIntegrityFailures: 0,

    acceptedPixelCount: 0,
    rejectedPixelCount: 0,

    skippedCharacters: 0,
  };

  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];

    const text = String(character.text ?? "");

    if (
      !text.trim() ||
      character.status !== "measured"
    ) {
      continue;
    }

    diagnostics.measuredCharacterCount++;

    const regionLeft = Number(
      character.estimatedRegion?.left
    );

    const regionRight = Number(
      character.estimatedRegion?.right
    );

    const components = Array.isArray(
      character.componentDiagnostics
    )
      ? character.componentDiagnostics
      : [];

    if (
      !Number.isFinite(regionLeft) ||
      !Number.isFinite(regionRight) ||
      regionRight <= regionLeft ||
      components.length === 0
    ) {
      diagnostics.skippedCharacters++;
      continue;
    }

    /*
     * A pixel at integer X belongs to the character when:
     *
     * regionLeft <= X + 0.5 < regionRight
     *
     * This uses the same pixel-centre ownership test
     * used by measureCharactersFromLine().
     */
    const ownedStartX = Math.ceil(
      regionLeft - 0.5
    );

    const ownedEndX = Math.ceil(
      regionRight - 0.5
    );

    const selectedRuns = [];

    let acceptedComponentCount = 0;
    let rejectedComponentCount = 0;

    let acceptedPixelCount = 0;
    let rejectedPixelCount = 0;

    const acceptedComponentLabels = [];
    const rejectedComponents = [];

    for (const component of components) {
      diagnostics.totalComponents++;

      const runs = Array.isArray(
        component.pixelRunsInCrop
      )
        ? component.pixelRunsInCrop
        : [];

      const area = Number(component.pixelArea);

      const ownership = component.pixelOwnership || {};

      const measuredTotal = Number(
        ownership.measuredTotal
      );

      const insidePixels = Number(
        ownership.insideRegion
      );

      if (
        !runs.length ||
        !Number.isInteger(area) ||
        area < 1 ||
        measuredTotal !== area ||
        !Number.isInteger(insidePixels) ||
        insidePixels < 0 ||
        insidePixels > measuredTotal
      ) {
        diagnostics.missingRunComponents++;
        diagnostics.rejectedComponents++;
        diagnostics.componentIntegrityFailures++;

        rejectedComponentCount++;

        rejectedComponents.push({
          label: component.label,
          reason: "missing-or-invalid-run-data",
        });

        continue;
      }

      let encodedPixelCount = 0;
      let validRuns = true;

      for (const run of runs) {
        if (
          !Array.isArray(run) ||
          run.length < 3
        ) {
          validRuns = false;
          break;
        }

        const y = Number(run[0]);
        const startX = Number(run[1]);
        const endX = Number(run[2]);

        if (
          !Number.isInteger(y) ||
          !Number.isInteger(startX) ||
          !Number.isInteger(endX) ||
          y < 0 ||
          startX < 0 ||
          endX <= startX
        ) {
          validRuns = false;
          break;
        }

        encodedPixelCount += endX - startX;
      }

      if (
        !validRuns ||
        encodedPixelCount !== area
      ) {
        diagnostics.componentIntegrityFailures++;
        diagnostics.rejectedComponents++;
        diagnostics.rejectedPixelCount += area;

        rejectedComponentCount++;

        rejectedComponents.push({
          label: component.label,
          reason: "pixel-run-area-mismatch",
          expected: area,
          encoded: encodedPixelCount,
        });

        continue;
      }

      const insideRatio =
        insidePixels / Math.max(1, measuredTotal);

      // Major ownership decision.
      // Deliberately do not use passedCenterTolerance
      // or includedInRefinedHeight here.
      if (insideRatio < ownershipThreshold) {
        diagnostics.rejectedComponents++;
        diagnostics.rejectedPixelCount += area;

        rejectedComponentCount++;

        rejectedComponents.push({
          label: component.label,
          reason: "majority-outside-character-region",
          insideRatio: Number(
            insideRatio.toFixed(3)
          ),
        });

        continue;
      }

      /*
       * Clip each accepted component to the actual
       * fractional CTC character-region boundaries.
       */
      const componentRuns = [];

      let clippedPixelCount = 0;

      for (const run of runs) {
        const y = Number(run[0]);

        const startX = Math.max(
          Number(run[1]),
          ownedStartX
        );

        const endX = Math.min(
          Number(run[2]),
          ownedEndX
        );

        if (endX <= startX) {
          continue;
        }

        componentRuns.push([
          y,
          startX,
          endX,
        ]);

        clippedPixelCount += endX - startX;
      }

      // Independent integrity check:
      // clipped run pixels must equal OpenCV's inside-region count.
      if (clippedPixelCount !== insidePixels) {
        diagnostics.componentIntegrityFailures++;
        diagnostics.rejectedComponents++;
        diagnostics.rejectedPixelCount += area;

        rejectedComponentCount++;

        rejectedComponents.push({
          label: component.label,
          reason: "ownership-run-count-mismatch",
          expectedInsidePixels: insidePixels,
          clippedRunPixels: clippedPixelCount,
        });

        continue;
      }

      acceptedComponentCount++;

      diagnostics.acceptedComponents++;
      diagnostics.acceptedPixelCount += clippedPixelCount;

      acceptedComponentLabels.push(component.label);

      selectedRuns.push(...componentRuns);

      acceptedPixelCount += clippedPixelCount;
    }

    diagnostics.rejectedComponents +=
      rejectedComponentCount -
      rejectedComponents.length;

    diagnostics.rejectedPixelCount += rejectedPixelCount;

    if (!selectedRuns.length) {
      diagnostics.skippedCharacters++;
      continue;
    }

    let minX = Infinity;
    let minY = Infinity;

    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const [y, startX, endX] of selectedRuns) {
      minX = Math.min(minX, startX);
      maxX = Math.max(maxX, endX);

      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + 1);
    }

    const width = maxX - minX;
    const height = maxY - minY;

    if (
      width < 1 ||
      height < 1 ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      diagnostics.skippedCharacters++;
      continue;
    }

    const mask = new Uint8Array(
      width * height
    );

    let maskPixelCount = 0;

    for (const [y, startX, endX] of selectedRuns) {
      const rowOffset = (y - minY) * width;

      for (let x = startX; x < endX; x++) {
        const offset =
          rowOffset + (x - minX);

        if (!mask[offset]) {
          mask[offset] = 1;
          maskPixelCount++;
        }
      }
    }

    // Ensure the reconstructed mask preserves all
    // accepted component pixels.
    if (maskPixelCount !== acceptedPixelCount) {
      diagnostics.componentIntegrityFailures++;
      diagnostics.skippedCharacters++;
      continue;
    }

    glyphs.push({
      index: Number.isInteger(character.index)
        ? character.index
        : index,

      text,

      glyphClass: getGlyphClass(text),

      status: "component-run-candidate",

      width,
      height,

      pixelCount: maskPixelCount,

      aspectRatio: Number(
        (width / height).toFixed(3)
      ),

      mask,

      acceptedComponentCount,
      rejectedComponentCount,

      acceptedComponentLabels,
      rejectedComponents,

      ownershipThreshold,

      source: "rectified-paddle-crop-component-runs",

      sourceCropBounds: {
        x: minX,
        y: minY,
        width,
        height,
      },
    });

    diagnostics.extractedGlyphCount++;
  }

  return {
    glyphs,
    diagnostics,
  };
}



function buildSpatiallyAssociatedGlyphDiagnostics(
  characterMeasurements,
  options = {}
) {
  const characters = Array.isArray(
    characterMeasurements?.characters
  )
    ? characterMeasurements.characters
    : [];

  const maxPixelGap = Number(options.maxPixelGap ?? 2);
  const majorPartRatio = Number(options.majorPartRatio ?? 0.20);

  const glyphs = [];
const boundaryFragmentGlyphs = [];
  const diagnostics = {
    status: "complete",
    maxPixelGap,
    majorPartRatio,

    measuredCharacterCount: 0,
    extractedGlyphCount: 0,

    totalComponents: 0,
    acceptedComponents: 0,
    rejectedComponents: 0,
    integrityFailures: 0,

    acceptedPixels: 0,
    rejectedPixels: 0,
boundaryFragmentComponentCount: 0,
boundaryFragmentPixels: 0,
boundaryFragmentOutsidePixels: 0,
boundaryFragmentGlyphCount: 0,
boundaryFragmentIntegrityFailures: 0,
    characters: [],
  };

  function getRunDistance(a, b) {
    const verticalDistance = Math.abs(a[0] - b[0]);

    let horizontalDistance = 0;

    if (a[2] <= b[1]) {
      horizontalDistance =
        b[1] - (a[2] - 1);
    } else if (b[2] <= a[1]) {
      horizontalDistance =
        a[1] - (b[2] - 1);
    }

    return Math.max(
      horizontalDistance,
      verticalDistance
    );
  }

  function getComponentDistance(a, b) {
    let minimumDistance = Infinity;

    for (const runA of a.runs) {
      for (const runB of b.runs) {
        const distance = getRunDistance(
          runA,
          runB
        );

        minimumDistance = Math.min(
          minimumDistance,
          distance
        );

        if (minimumDistance <= maxPixelGap) {
          return minimumDistance;
        }
      }
    }

    return minimumDistance;
  }

  function isDetachedIDot(candidate, anchor) {
    const verticalGap =
      anchor.minY - candidate.maxY;

    const horizontalCenterDistance = Math.abs(
      candidate.centerX - anchor.centerX
    );

    return (
      candidate.maxY <= anchor.minY + 1 &&
      verticalGap >= -1 &&
      verticalGap <= Math.max(
        3,
        Math.ceil(anchor.height * 0.5)
      ) &&
      horizontalCenterDistance <= Math.max(
        1.5,
        anchor.width * 0.5
      ) &&
      candidate.height <= Math.max(
        3,
        Math.ceil(anchor.height * 0.4)
      ) &&
      candidate.width <= Math.max(
        4,
        Math.ceil(anchor.width * 1.5)
      )
    );
  }

  function isUpperISerif(candidate, anchor) {
    const centerDistance = Math.abs(
      candidate.centerX - anchor.centerX
    );

    if (
      centerDistance >
      Math.max(2, anchor.width * 0.75)
    ) {
      return false;
    }

    const maximumVerticalGap = Math.max(
      2,
      Math.ceil(anchor.height * 0.15)
    );

    const above =
      candidate.maxY <= anchor.minY + 1 &&
      anchor.minY - candidate.maxY <= maximumVerticalGap;

    const below =
      candidate.minY >= anchor.maxY - 1 &&
      candidate.minY - anchor.maxY <= maximumVerticalGap;

    return above || below;
  }

  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];

    const text = String(character.text ?? "");

    if (
      !text.trim() ||
      character.status !== "measured"
    ) {
      continue;
    }

    diagnostics.measuredCharacterCount++;

    const regionLeft = Number(
      character.estimatedRegion?.left
    );

    const regionRight = Number(
      character.estimatedRegion?.right
    );

    const components = Array.isArray(
      character.componentDiagnostics
    )
      ? character.componentDiagnostics
      : [];

    if (
      !Number.isFinite(regionLeft) ||
      !Number.isFinite(regionRight) ||
      regionRight <= regionLeft ||
      components.length === 0
    ) {
      continue;
    }

    const ownedStartX = Math.ceil(
      regionLeft - 0.5
    );

    const ownedEndX = Math.ceil(
      regionRight - 0.5
    );

const records = [];

const boundaryFragmentRecords = [];

const rejectedDetails = [];

    for (const component of components) {
      diagnostics.totalComponents++;

      const runs = component.pixelRunsInCrop;
      const area = Number(component.pixelArea);

      const ownership = component.pixelOwnership || {};

      const measuredTotal = Number(
        ownership.measuredTotal
      );

      const insidePixels = Number(
        ownership.insideRegion
      );

      if (
  !Array.isArray(runs) ||
  !runs.length ||
  !Number.isInteger(area) ||
  area < 1 ||
  measuredTotal !== area ||
  !Number.isInteger(insidePixels) ||
  insidePixels < 0 ||
  insidePixels > measuredTotal
) {
  diagnostics.rejectedComponents++;
  diagnostics.integrityFailures++;

  const rejectedArea = Math.max(
    0,
    Number.isFinite(area) ? area : 0
  );

  diagnostics.rejectedPixels += rejectedArea;

  rejectedDetails.push({
    label: component.label,
    pixelArea: rejectedArea,

    runCount: Array.isArray(runs)
      ? runs.length
      : 0,

    measuredTotal,
    insidePixels,

    reason: "missing-or-invalid-run-data",
  });

  continue;
}

      let encodedPixelCount = 0;
      let clippedPixelCount = 0;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

let componentMinX = Infinity;
let componentMinY = Infinity;
let componentMaxX = -Infinity;
let componentMaxY = -Infinity;

      let sumX = 0;
      let sumY = 0;

      const clippedRuns = [];

      let valid = true;

      for (const run of runs) {
        if (!Array.isArray(run) || run.length < 3) {
          valid = false;
          break;
        }

        const y = Number(run[0]);
        const startX = Number(run[1]);
        const endX = Number(run[2]);

        if (
          !Number.isInteger(y) ||
          !Number.isInteger(startX) ||
          !Number.isInteger(endX) ||
          endX <= startX
        ) {
          valid = false;
          break;
        }

        encodedPixelCount += endX - startX;

// Preserve the complete original component geometry.
componentMinX = Math.min(componentMinX, startX);
componentMaxX = Math.max(componentMaxX, endX);

componentMinY = Math.min(componentMinY, y);
componentMaxY = Math.max(componentMaxY, y + 1);

        const clippedStart = Math.max(
          startX,
          ownedStartX
        );

        const clippedEnd = Math.min(
          endX,
          ownedEndX
        );

        if (clippedEnd <= clippedStart) {
          continue;
        }

        const count = clippedEnd - clippedStart;

        clippedRuns.push([
          y,
          clippedStart,
          clippedEnd,
        ]);

        clippedPixelCount += count;

        minX = Math.min(minX, clippedStart);
        maxX = Math.max(maxX, clippedEnd);

        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y + 1);

        // Pixel-centre coordinates.
        sumX += (
          (clippedStart + clippedEnd - 1) / 2 + 0.5
        ) * count;

        sumY += (y + 0.5) * count;
      }

     if (
  !valid ||
  encodedPixelCount !== area ||
  clippedPixelCount !== insidePixels
) {
  diagnostics.rejectedComponents++;
  diagnostics.integrityFailures++;
  diagnostics.rejectedPixels += area;

  rejectedDetails.push({
    label: component.label,
    pixelArea: area,

    encodedPixelCount,
    clippedPixelCount,
    expectedInsidePixels: insidePixels,

    reason: "pixel-run-area-mismatch",
  });

  continue;
}

const insideRatio =
  insidePixels / Math.max(1, measuredTotal);

// ================================================
// CASE 1: NO PIXELS INSIDE THE CHARACTER REGION
// ================================================

if (clippedPixelCount === 0) {
  diagnostics.rejectedComponents++;
  diagnostics.rejectedPixels += area;

  rejectedDetails.push({
    label: component.label,
    pixelArea: area,

    insidePixels,
    clippedPixelCount,

    insideRatio: Number(
      insideRatio.toFixed(3)
    ),

    boundaryFragmentIncluded: false,

    reason: "no-pixels-inside-character-region",
  });

  continue;
}

// ================================================
// CASE 2: PARTIAL COMPONENT OWNERSHIP
// ================================================
//
// Keep the existing 50% ownership rule for the spatial
// candidate, but preserve its in-region pixels separately.
//
// Only clippedRuns are retained. Pixels outside the
// character region are never added to this candidate.

if (insideRatio < 0.50) {
  diagnostics.rejectedComponents++;
  diagnostics.rejectedPixels += area;

  const boundaryRecord = {
    component,

    // Runs clipped to the character's horizontal region.
    runs: clippedRuns,

    pixelCount: clippedPixelCount,

    minX,
    minY,
    maxX,
    maxY,

    width: maxX - minX,
    height: maxY - minY,

    centerX: sumX / clippedPixelCount,
    centerY: sumY / clippedPixelCount,

    insideRatio,

    totalPixelCount: measuredTotal,

    outsidePixelCount:
      measuredTotal - clippedPixelCount,

    componentBounds: {
      x: componentMinX,
      y: componentMinY,

      width: componentMaxX - componentMinX,
      height: componentMaxY - componentMinY,
    },

    inRegionBounds: {
      x: minX,
      y: minY,

      width: maxX - minX,
      height: maxY - minY,
    },
  };

  boundaryFragmentRecords.push(boundaryRecord);

  diagnostics.boundaryFragmentComponentCount++;

  diagnostics.boundaryFragmentPixels +=
    clippedPixelCount;

  diagnostics.boundaryFragmentOutsidePixels +=
    boundaryRecord.outsidePixelCount;

  rejectedDetails.push({
    label: component.label,

    pixelArea: area,

    insidePixels: clippedPixelCount,

    outsidePixels: boundaryRecord.outsidePixelCount,

    insideRatio: Number(
      insideRatio.toFixed(3)
    ),

    boundaryFragmentIncluded: true,

    boundaryFragmentPixelCount: clippedPixelCount,

    componentBounds: boundaryRecord.componentBounds,

    inRegionBounds: boundaryRecord.inRegionBounds,

    reason: "majority-outside-character-region",
  });

  continue;
}

      records.push({
        component,

        runs: clippedRuns,

        pixelCount: clippedPixelCount,

        minX,
        minY,
        maxX,
        maxY,

        width: maxX - minX,
        height: maxY - minY,

        centerX: sumX / clippedPixelCount,
        centerY: sumY / clippedPixelCount,

        insideRatio,
      });
    }

    if (!records.length) {
      continue;
    }

    // The largest owned component is the initial glyph core.
    // Other components must demonstrate a spatial relationship
    // to this core or qualify as a known detached character mark.
    const anchor = [...records].sort(
      (a, b) =>
        b.pixelCount - a.pixelCount ||
        Number(a.component.centerDistancePx ?? Infinity) -
        Number(b.component.centerDistancePx ?? Infinity)
    )[0];

    const keptRecords = [];
  
    const acceptedRuns = [];

    const punctuationWithDetachedMarks =
      /^[!?;:]$/u.test(text);

    for (const record of records) {
      const component = record.component;

      let reason = null;

      if (record === anchor) {
        reason = "primary-glyph-component";
      } else {
        const distance = getComponentDistance(
          record,
          anchor
        );

        if (distance <= maxPixelGap) {
          reason = "near-primary-component";
        }

       // Preserve detached dots only for lowercase i and j.
// Uppercase I must use the separate serif test below.
if (
  !reason &&
  /^[ij]$/u.test(text) &&
  isDetachedIDot(record, anchor)
) {
  reason = "detached-i-j-dot";
}

        // Preserve possible disconnected upper/lower serifs of I.
        if (
          !reason &&
          text === "I" &&
          isUpperISerif(record, anchor)
        ) {
          reason = "uppercase-I-serif";
        }

        // Preserve significant secondary strokes.
        // The centre test is deliberately relaxed because
        // legitimate descender portions can extend beyond
        // the normal CTC-centre tolerance.
        const centerDistance = Number(
          component.centerDistancePx
        );

        const centerTolerance = Number(
          component.centerTolerancePx
        );

        const significantPart =
          record.pixelCount >= Math.max(
            3,
            anchor.pixelCount * majorPartRatio
          ) &&
          Number.isFinite(centerDistance) &&
          Number.isFinite(centerTolerance) &&
          centerDistance <= centerTolerance * 1.5 + 1;

        if (!reason && significantPart) {
          reason = "significant-secondary-stroke";
        }

        // Colon, semicolon, exclamation and question marks
        // can contain a detached punctuation mark.
        if (
          !reason &&
          punctuationWithDetachedMarks &&
          Math.abs(record.centerX - anchor.centerX) <=
            Math.max(2, anchor.width * 0.6) &&
          record.pixelCount <= anchor.pixelCount * 1.5 &&
          Math.abs(record.centerY - anchor.centerY) <=
            Math.max(4, anchor.height)
        ) {
          reason = "detached-punctuation-part";
        }
      }

  if (reason) {
  // Preserve the exact rule that accepted this component.
  record.acceptedReason = reason;

  keptRecords.push(record);
  acceptedRuns.push(...record.runs);

  diagnostics.acceptedComponents++;
  diagnostics.acceptedPixels += record.pixelCount;

} else {
        diagnostics.rejectedComponents++;
        diagnostics.rejectedPixels += record.pixelCount;

        rejectedDetails.push({
          label: component.label,
          pixelCount: record.pixelCount,
          centerDistancePx: component.centerDistancePx,
          reason: "isolated-component-not-associated-with-core",
        });
      }
    }

    if (!acceptedRuns.length) {
      continue;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const [y, startX, endX] of acceptedRuns) {
      minX = Math.min(minX, startX);
      maxX = Math.max(maxX, endX);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + 1);
    }

    const width = maxX - minX;
    const height = maxY - minY;

    if (width < 1 || height < 1) {
      continue;
    }

    const mask = new Uint8Array(width * height);

    let maskPixelCount = 0;

    for (const [y, startX, endX] of acceptedRuns) {
      const rowOffset = (y - minY) * width;

      for (let x = startX; x < endX; x++) {
        const offset = rowOffset + x - minX;

        if (!mask[offset]) {
          mask[offset] = 1;
          maskPixelCount++;
        }
      }
    }

    const expectedPixelCount = keptRecords.reduce(
      (sum, record) => sum + record.pixelCount,
      0
    );

    if (maskPixelCount !== expectedPixelCount) {
      diagnostics.integrityFailures++;
      continue;
    }

 const decisions = keptRecords.map(record => {
  const distanceToAnchor =
    record === anchor
      ? 0
      : getComponentDistance(record, anchor);

  return {
    label: record.component.label,

    decision: "accepted",

    reason:
      record.acceptedReason ??
      "accepted-without-reason",

    pixelCount: record.pixelCount,

    width: record.width,
    height: record.height,

    minX: record.minX,
    minY: record.minY,
    maxX: record.maxX,
    maxY: record.maxY,

    centerX: Number(record.centerX.toFixed(3)),
    centerY: Number(record.centerY.toFixed(3)),

    distanceToAnchorPx: Number(
      distanceToAnchor.toFixed(3)
    ),

    insideRatio: Number(
      record.insideRatio.toFixed(3)
    ),
  };
});

decisions.push(
  ...rejectedDetails.map(item => ({
    ...item,
    decision: "rejected",
  }))
);

    glyphs.push({
      index: Number.isInteger(character.index)
        ? character.index
        : index,

      text,

      glyphClass: getGlyphClass(text),

      status: "spatial-association-candidate",

      width,
      height,

      pixelCount: maskPixelCount,

      aspectRatio: Number(
        (width / height).toFixed(3)
      ),

      mask,

      anchorComponentLabel: anchor.component.label,

      acceptedComponentCount: keptRecords.length,

      rejectedComponentCount: rejectedDetails.length,

      componentDecisions: decisions,

      source: "spatially-associated-component-runs",

      sourceCropBounds: {
        x: minX,
        y: minY,
        width,
        height,
      },
    });

  diagnostics.extractedGlyphCount++;

// ================================================
// SPATIAL + BOUNDARY-FRAGMENT CANDIDATE
// ================================================

// Collect only in-region fragments from partially owned
// components rejected by the existing ownership threshold.
const boundaryFragmentRuns =
  boundaryFragmentRecords.flatMap(
    record => record.runs
  );

// Start with the exact existing spatially accepted runs.
const combinedRuns = [
  ...acceptedRuns,
  ...boundaryFragmentRuns,
];

const boundaryFragmentPixelCount =
  boundaryFragmentRecords.reduce(
    (sum, record) => sum + record.pixelCount,
    0
  );

const boundaryFragmentOutsidePixelCount =
  boundaryFragmentRecords.reduce(
    (sum, record) => sum + record.outsidePixelCount,
    0
  );

// Calculate the combined candidate bounds.
let combinedMinX = Infinity;
let combinedMinY = Infinity;
let combinedMaxX = -Infinity;
let combinedMaxY = -Infinity;

for (const [y, startX, endX] of combinedRuns) {
  combinedMinX = Math.min(combinedMinX, startX);
  combinedMaxX = Math.max(combinedMaxX, endX);

  combinedMinY = Math.min(combinedMinY, y);
  combinedMaxY = Math.max(combinedMaxY, y + 1);
}

const combinedWidth = combinedMaxX - combinedMinX;
const combinedHeight = combinedMaxY - combinedMinY;

let boundaryFragmentCandidateIntegrityPassed = false;

if (
  combinedWidth >= 1 &&
  combinedHeight >= 1 &&
  combinedRuns.length > 0
) {
  const combinedMask = new Uint8Array(
    combinedWidth * combinedHeight
  );

  let combinedMaskPixelCount = 0;

  for (const [y, startX, endX] of combinedRuns) {
    const rowOffset =
      (y - combinedMinY) * combinedWidth;

    for (let x = startX; x < endX; x++) {
      const offset =
        rowOffset + x - combinedMinX;

      if (!combinedMask[offset]) {
        combinedMask[offset] = 1;
        combinedMaskPixelCount++;
      }
    }
  }

  // Distinct OpenCV connected components should not overlap.
  // Verify that the combined mask contains exactly the
  // existing spatial pixels plus the boundary-fragment pixels.
  const expectedCombinedPixelCount =
    maskPixelCount + boundaryFragmentPixelCount;

  if (
    combinedMaskPixelCount === expectedCombinedPixelCount
  ) {
    boundaryFragmentCandidateIntegrityPassed = true;

    boundaryFragmentGlyphs.push({
      index: Number.isInteger(character.index)
        ? character.index
        : index,

      text,

      glyphClass: getGlyphClass(text),

      status: "spatial-plus-boundary-fragments-candidate",

      width: combinedWidth,
      height: combinedHeight,

      pixelCount: combinedMaskPixelCount,

      aspectRatio: Number(
        (combinedWidth / combinedHeight).toFixed(3)
      ),

      mask: combinedMask,

      anchorComponentLabel: anchor.component.label,

      acceptedComponentCount: keptRecords.length,

      boundaryFragmentComponentCount:
        boundaryFragmentRecords.length,

      boundaryFragmentPixels:
        boundaryFragmentPixelCount,

      boundaryFragmentOutsidePixels:
        boundaryFragmentOutsidePixelCount,

      rejectedComponentCount: rejectedDetails.length,

      componentDecisions: decisions,

      source: "spatial-components-plus-in-region-boundary-fragments",

      sourceCropBounds: {
        x: combinedMinX,
        y: combinedMinY,
        width: combinedWidth,
        height: combinedHeight,
      },
    });

    diagnostics.boundaryFragmentGlyphCount++;

  } else {
    diagnostics.boundaryFragmentIntegrityFailures++;

    console.warn(
      "[Paddle Boundary Fragment Candidate] Pixel-count integrity mismatch",
      {
        text,
        index,

        spatialPixelCount: maskPixelCount,

        boundaryFragmentPixelCount,

        expectedCombinedPixelCount,

        actualCombinedPixelCount: combinedMaskPixelCount,
      }
    );
  }
}

// ================================================
// PER-CHARACTER COMPONENT DECISION DIAGNOSTICS
// ================================================

const acceptedDecisionCount = decisions.filter(
  item => item.decision === "accepted"
).length;

const rejectedDecisionCount = decisions.filter(
  item => item.decision === "rejected"
).length;

diagnostics.characters.push({
  index: Number.isInteger(character.index)
    ? character.index
    : index,

  text,

  anchorComponentLabel: anchor.component.label,

  acceptedComponentCount: keptRecords.length,

  rejectedComponentCount: rejectedDetails.length,

  acceptedPixels: maskPixelCount,

  // Number of components that passed the initial
  // validation and character-region ownership checks.
  originalOwnedComponentCount: records.length,

  // Number of components supplied by OpenCV for this character.
  totalComponentCount: components.length,

  // Individual accepted and rejected component decisions.
  componentDecisions: decisions,

  // Independent decision-count verification.
  decisionCount: decisions.length,

  acceptedDecisionCount,

  rejectedDecisionCount,

  decisionCountMatchesComponentCount:
    decisions.length === components.length,

  decisionCountsMatch:
    acceptedDecisionCount === keptRecords.length &&
    rejectedDecisionCount === rejectedDetails.length,

    boundaryFragmentComponentCount:
  boundaryFragmentRecords.length,

boundaryFragmentPixels:
  boundaryFragmentPixelCount,

boundaryFragmentOutsidePixels:
  boundaryFragmentOutsidePixelCount,

boundaryFragmentCandidateIntegrityPassed,
}); 
  }

  diagnostics.status =
    diagnostics.integrityFailures === 0
      ? "complete"
      : "review";

const boundaryFragmentDiagnostics = {
  status:
    diagnostics.boundaryFragmentIntegrityFailures === 0
      ? "complete"
      : "review",

  componentCount:
    diagnostics.boundaryFragmentComponentCount,

  insidePixelCount:
    diagnostics.boundaryFragmentPixels,

  outsidePixelCount:
    diagnostics.boundaryFragmentOutsidePixels,

  glyphCount:
    diagnostics.boundaryFragmentGlyphCount,

  integrityFailures:
    diagnostics.boundaryFragmentIntegrityFailures,
};

return {
  glyphs,

  boundaryFragmentGlyphs,

  diagnostics,

  boundaryFragmentDiagnostics,
};
}


function extractOriginalGlyphDiagnostics({
  original,
  characterMeasurements,
  raster,
  ocrScaleX = 1,
  ocrScaleY = ocrScaleX,
} = {}) {
  const fallback = {
    status: "unavailable",
    totalCharacterRecords: 0,
    measuredCharacterCount: 0,
    extractedGlyphCount: 0,
    skippedSpaceCount: 0,
    skippedCharacterCount: 0,
    coordinateOriginX: null,
    coordinateOriginY: null,
    coordinateOriginSpreadX: null,
    coordinateOriginSpreadY: null,
    coordinateOriginStatus: "unavailable",
  glyphs: [],
samples: [],

// Diagnostic candidate defaults.
componentRunGlyphs: [],
componentRunDiagnostics: null,

spatialRunGlyphs: [],
spatialRunDiagnostics: null,

boundaryFragmentGlyphs: [],
boundaryFragmentDiagnostics: null,  
  };

  const characters = Array.isArray(
    characterMeasurements?.characters
  )
    ? characterMeasurements.characters
    : [];

  const scaleX = Number(ocrScaleX);
  const scaleY = Number(ocrScaleY);

  const rasterScaleX = Number(raster?.scaleX);
  const rasterScaleY = Number(raster?.scaleY);

  if (
    !original?.mask ||
    !characters.length ||
    !Number.isFinite(scaleX) ||
    !Number.isFinite(scaleY) ||
    scaleX <= 0 ||
    scaleY <= 0 ||
    !Number.isFinite(rasterScaleX) ||
    !Number.isFinite(rasterScaleY) ||
    rasterScaleX <= 0 ||
    rasterScaleY <= 0 ||
    !Number.isFinite(original.sourceCropLeft) ||
    !Number.isFinite(original.sourceCropTop)
  ) {
    return fallback;
  }

  /*
   * STEP 1: Reconstruct the recognition-crop origin
   * in original page-source coordinates.
   *
   * character.inkBounds is already page-source geometry.
   * character.cropBounds remains crop-relative OCR geometry.
   */
  const originRecords = characters
    .filter((character) =>
      character.status === "measured"
    )
    .map((character) => {
      const ink = character.inkBounds;
      const crop = character.cropBounds;

      const inkX = Number(ink?.x);
      const inkY = Number(ink?.y);

      const cropX = Number(crop?.x);
      const cropY = Number(crop?.y);

      if (
        ![
          inkX,
          inkY,
          cropX,
          cropY,
        ].every(Number.isFinite)
      ) {
        return null;
      }

      return {
        x: inkX - cropX / scaleX,
        y: inkY - cropY / scaleY,
      };
    })
    .filter(Boolean);

  if (!originRecords.length) {
    return {
      ...fallback,
      status: "missing-coordinate-origin",
      totalCharacterRecords: characters.length,
    };
  }

  const originX = medianNumber(
    originRecords.map((item) => item.x)
  );

  const originY = medianNumber(
    originRecords.map((item) => item.y)
  );

  const originSpreadX =
    Math.max(...originRecords.map((item) => item.x)) -
    Math.min(...originRecords.map((item) => item.x));

  const originSpreadY =
    Math.max(...originRecords.map((item) => item.y)) -
    Math.min(...originRecords.map((item) => item.y));

  /*
   * STEP 2: Extract each character independently.
   */
  const glyphs = [];
  const samples = [];

  let measuredCharacterCount = 0;
  let skippedSpaceCount = 0;
  let skippedCharacterCount = 0;

  for (
    let index = 0;
    index < characters.length;
    index++
  ) {
    const character = characters[index];

    const text = String(character.text ?? "");

    if (!text.trim()) {
      skippedSpaceCount++;
      continue;
    }

    if (character.status !== "measured") {
      skippedCharacterCount++;
      continue;
    }

    measuredCharacterCount++;
const regionLeft = Number(
  character.estimatedRegion?.left
);

const regionRight = Number(
  character.estimatedRegion?.right
);

if (
  ![
    regionLeft,
    regionRight,
  ].every(Number.isFinite) ||
  regionRight <= regionLeft
) {
  skippedCharacterCount++;
  continue;
}

    /*
     * STEP 3: Recover the ORIGINAL vertical bounds.
     *
     * Do not use refinedBoundsInCrop here.
     * The refined bounds can exclude detached parts
     * such as the dot of i or j.
     */
    const originalBounds =
      character.heightDiagnostics?.originalBoundsInCrop;

    const originalTop = Number(
      originalBounds?.top
    );

    const originalBottom = Number(
      originalBounds?.bottomExclusive
    );

    let topSource;
    let bottomSource;

    let verticalSource = "original-crop-bounds";

    if (
      Number.isFinite(originalTop) &&
      Number.isFinite(originalBottom) &&
      originalBottom > originalTop
    ) {
     
/*
 * originalBoundsInCrop is already expressed in the full
 * OCR recognition-crop coordinate system.
 *
 * It shares the same coordinate system as:
 * - componentDiagnostics.boundsInCrop
 * - estimatedRegion.left / estimatedRegion.right
 *
 * Do NOT add character.cropBounds.y again.
 */

const topCropCoordinate = originalTop;
const bottomCropCoordinate = originalBottom;

topSource =
  originY + topCropCoordinate / scaleY;

bottomSource =
  originY + bottomCropCoordinate / scaleY;

    } else {
      /*
       * Fallback only when original crop-height diagnostics
       * are unavailable.
       *
       * This may exclude detached components, so the glyph
       * will receive a lower-quality diagnostic flag.
       */
      const inkBounds = character.inkBounds;

      if (!inkBounds) {
        skippedCharacterCount++;
        continue;
      }

      const inkTop = Number(inkBounds.y);
      const inkHeight = Number(inkBounds.height);

      if (
        !Number.isFinite(inkTop) ||
        !Number.isFinite(inkHeight) ||
        inkHeight <= 0
      ) {
        skippedCharacterCount++;
        continue;
      }

      topSource = inkTop;
      bottomSource = inkTop + inkHeight;

      verticalSource = "character-ink-bounds-fallback";
    }

    /*
     * STEP 4: Convert recognition coordinates into
     * the original comparison-canvas coordinates.
     */
    const leftSource =
      originX + regionLeft / scaleX;

    const rightSource =
      originX + regionRight / scaleX;

    const cellLeft = Math.max(
      0,
      Math.floor(
        leftSource * rasterScaleX -
        original.sourceCropLeft
      )
    );

    const cellRight = Math.min(
      original.width,
      Math.ceil(
        rightSource * rasterScaleX -
        original.sourceCropLeft
      )
    );

    const cellTop = Math.max(
      0,
      Math.floor(
        topSource * rasterScaleY -
        original.sourceCropTop
      )
    );

    const cellBottom = Math.min(
      original.height,
      Math.ceil(
        bottomSource * rasterScaleY -
        original.sourceCropTop
      )
    );

    if (
      cellRight <= cellLeft ||
      cellBottom <= cellTop
    ) {
      skippedCharacterCount++;
      continue;
    }

    /*
     * STEP 5: Collect original image ink pixels
     * only inside this character's horizontal and
     * original vertical recognition region.
     */
    let minX = cellRight;
    let minY = cellBottom;

    let maxX = -1;
    let maxY = -1;

    let pixelCount = 0;

    let leftEdgeInkCount = 0;
    let rightEdgeInkCount = 0;

    for (
      let y = cellTop;
      y < cellBottom;
      y++
    ) {
      for (
        let x = cellLeft;
        x < cellRight;
        x++
      ) {
        const pixelIndex =
          y * original.width + x;

        if (!original.mask[pixelIndex]) {
          continue;
        }

        pixelCount++;

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);

        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);

        if (x === cellLeft) {
          leftEdgeInkCount++;
        }

        if (x === cellRight - 1) {
          rightEdgeInkCount++;
        }
      }
    }

    if (
      pixelCount === 0 ||
      maxX < minX ||
      maxY < minY
    ) {
      skippedCharacterCount++;

      samples.push({
        index,
        text,
        glyphClass: getGlyphClass(text),
        status: "empty-source-cell",
      });

      continue;
    }

    const glyphWidth =
      maxX - minX + 1;

    const glyphHeight =
      maxY - minY + 1;

    /*
     * STEP 6: Construct a tight binary mask.
     *
     * This is the actual source glyph mask that we can
     * later compare against rendered Google Font glyphs.
     */
    const glyphMask = new Uint8Array(
      glyphWidth * glyphHeight
    );

    for (
      let y = minY;
      y <= maxY;
      y++
    ) {
      for (
        let x = minX;
        x <= maxX;
        x++
      ) {
        const sourceIndex =
          y * original.width + x;

        const destinationIndex =
          (y - minY) * glyphWidth +
          (x - minX);

        glyphMask[destinationIndex] =
          original.mask[sourceIndex];
      }
    }

    /*
     * STEP 7: Diagnose possible horizontal clipping.
     *
     * Use the independently measured character ink bounds
     * to check whether the CTC horizontal region includes
     * most of the expected character width.
     *
     * Edge contact by itself is not treated as clipping.
     */
    const inkBounds = character.inkBounds;

    let inkBoundsCoverage = null;

    if (
      Number.isFinite(Number(inkBounds?.x)) &&
      Number.isFinite(Number(inkBounds?.width)) &&
      Number(inkBounds.width) > 0
    ) {
      const expectedInkLeft =
        Number(inkBounds.x) * rasterScaleX -
        original.sourceCropLeft;

      const expectedInkRight =
        (
          Number(inkBounds.x) +
          Number(inkBounds.width)
        ) * rasterScaleX -
        original.sourceCropLeft;

      const expectedInkWidth =
        expectedInkRight - expectedInkLeft;

      const coveredWidth = Math.max(
        0,
        Math.min(cellRight, expectedInkRight) -
        Math.max(cellLeft, expectedInkLeft)
      );

      if (expectedInkWidth > 0) {
        inkBoundsCoverage = Math.min(
          1,
          coveredWidth / expectedInkWidth
        );
      }
    }

    const edgeContactRatio = Math.min(
      1,
      (
        leftEdgeInkCount +
        rightEdgeInkCount
      ) / Math.max(1, pixelCount)
    );

    const measurementScore = Number(
      character.meanScore
    );

    const qualityFlags = [];

    if (pixelCount < 6) {
      qualityFlags.push("low-ink-support");
    }

    if (glyphHeight < 3) {
      qualityFlags.push("low-vertical-resolution");
    }

    if (
      inkBoundsCoverage !== null &&
      inkBoundsCoverage < 0.90
    ) {
      qualityFlags.push(
        "possible-cell-boundary-clipping"
      );
    }

    if (
      verticalSource === "character-ink-bounds-fallback"
    ) {
      qualityFlags.push(
        "original-vertical-bounds-unavailable"
      );
    }

    if (
      Number.isFinite(measurementScore) &&
      measurementScore < 0.80
    ) {
      qualityFlags.push("low-measurement-score");
    }

    /*
     * STEP 8: Keep the full glyph data separately
     * from the compact console-preview records.
     */
    const glyph = {
      index,
      text,

      glyphClass: getGlyphClass(text),

      status: "extracted",

      width: glyphWidth,
      height: glyphHeight,

      pixelCount,

      aspectRatio: Number(
        (glyphWidth / glyphHeight).toFixed(3)
      ),

      mask: glyphMask,

      measurementScore: Number.isFinite(measurementScore)
        ? measurementScore
        : null,

      acceptedComponents: Number(
        character.acceptedComponents || 0
      ),

      excludedComponents: Number(
        character.heightDiagnostics?.excludedComponentCount || 0
      ),

      verticalSource,

      inkBoundsCoverage:
        inkBoundsCoverage === null
          ? null
          : Number(inkBoundsCoverage.toFixed(4)),

      edgeContactRatio: Number(
        edgeContactRatio.toFixed(4)
      ),

      leftEdgeInkCount,
      rightEdgeInkCount,

      quality:
        qualityFlags.length
          ? "review"
          : "usable",

      qualityFlags,

      sourceCropBounds: {
        x: minX,
        y: minY,
        width: glyphWidth,
        height: glyphHeight,
      },
    };

    glyphs.push(glyph);

    /*
     * Do not print the complete typed-array masks.
     * Keep these smaller records for readable diagnostics.
     */
    samples.push({
      index: glyph.index,
      text: glyph.text,
      glyphClass: glyph.glyphClass,
      status: glyph.status,

      width: glyph.width,
      height: glyph.height,
      pixelCount: glyph.pixelCount,
      aspectRatio: glyph.aspectRatio,

      measurementScore:
        glyph.measurementScore === null
          ? null
          : Number(glyph.measurementScore.toFixed(4)),

      acceptedComponents: glyph.acceptedComponents,
      excludedComponents: glyph.excludedComponents,

      verticalSource: glyph.verticalSource,

      inkBoundsCoverage: glyph.inkBoundsCoverage,

      edgeContactRatio: glyph.edgeContactRatio,

         quality: glyph.quality,
      qualityFlags: glyph.qualityFlags,

      sourceCropBounds: glyph.sourceCropBounds,

      // Temporary geometry diagnostics for verifying glyph extraction.
      geometry: {
        inkBounds: character?.inkBounds ?? null,
        cropBounds: character?.cropBounds ?? null,
        estimatedRegion: character?.estimatedRegion ?? null,

        originalBoundsInCrop:
          character?.heightDiagnostics?.originalBoundsInCrop ?? null,

        refinedBoundsInCrop:
          character?.heightDiagnostics?.refinedBoundsInCrop ??
          character?.heightDiagnostics?.refinedBounds ??
          null,

        componentDiagnostics:
          character?.componentDiagnostics ?? null,
      },
    });
  }

  /*
   * STEP 9: Report coordinate consistency separately
   * for horizontal and vertical coordinates.
   */
  const coordinateOriginStatus =
    originSpreadX <= 1.5 &&
    originSpreadY <= 1.5
      ? "consistent"
      : "review";

  const usableGlyphCount = glyphs.filter(
    (glyph) => glyph.quality === "usable"
  ).length;

  const reviewGlyphCount =
    glyphs.length - usableGlyphCount;

const componentRunExtraction =
  buildComponentRunGlyphDiagnostics(
    characterMeasurements
  );

const spatialRunExtraction =
  buildSpatiallyAssociatedGlyphDiagnostics(
    characterMeasurements,
    {
      maxPixelGap: 2,
      majorPartRatio: 0.20,
    }
  );

  return {
    status: "complete",

    totalCharacterRecords: characters.length,

    measuredCharacterCount,

    extractedGlyphCount: glyphs.length,

    usableGlyphCount,
    reviewGlyphCount,

    skippedSpaceCount,
    skippedCharacterCount,
componentRunGlyphs:
  componentRunExtraction.glyphs,

componentRunDiagnostics:
  componentRunExtraction.diagnostics,
    coordinateOriginX: Number(
      originX.toFixed(3)
    ),

    coordinateOriginY: Number(
      originY.toFixed(3)
    ),

    coordinateOriginSpreadX: Number(
      originSpreadX.toFixed(3)
    ),

    coordinateOriginSpreadY: Number(
      originSpreadY.toFixed(3)
    ),

    coordinateOriginStatus,

    // Full masks are retained for the next matching stage.
    glyphs,

spatialRunGlyphs:
  spatialRunExtraction.glyphs,

spatialRunDiagnostics:
  spatialRunExtraction.diagnostics,

  boundaryFragmentGlyphs:
  spatialRunExtraction.boundaryFragmentGlyphs,

boundaryFragmentDiagnostics:
  spatialRunExtraction.boundaryFragmentDiagnostics,

    // Compact diagnostics only.
  samples: [
  ...samples.slice(0, 30),
  ...samples.slice(30).filter(
    (sample) => sample.height <= 3
  ),
],
  };
}

/* =========================================================
   FONT CANDIDATE RENDERING
   ========================================================= */

function createCandidateMask({
  context,
  width,
  height,
  text,
  font,
  target,
}) {
  context.clearRect(0, 0, width, height);

  const makeFontString = (size) =>
    `${font.style} ${font.weight} ${size}px ` +
    `"${font.family}", ${font.fallback}`;

  context.font = makeFontString(100);

  const initialMetrics = context.measureText(text);

  const initialHeight =
    initialMetrics.actualBoundingBoxAscent +
    initialMetrics.actualBoundingBoxDescent;

  if (
    !Number.isFinite(initialHeight) ||
    initialHeight <= 0
  ) {
    return null;
  }

  // First fit the candidate's vertical ink height.
  let fontSize =
    100 * target.targetHeight / initialHeight;

  if (
    !Number.isFinite(fontSize) ||
    fontSize < 2 ||
    fontSize > 250
  ) {
    return null;
  }

  context.font = makeFontString(fontSize);

  let metrics = context.measureText(text);

  let actualHeight =
    metrics.actualBoundingBoxAscent +
    metrics.actualBoundingBoxDescent;

  if (
    !Number.isFinite(actualHeight) ||
    actualHeight <= 0
  ) {
    return null;
  }

  // Correct vertical measurement rounding.
  fontSize *= target.targetHeight / actualHeight;

  context.font = makeFontString(fontSize);

  metrics = context.measureText(text);

  actualHeight =
    metrics.actualBoundingBoxAscent +
    metrics.actualBoundingBoxDescent;

  const actualWidth =
    metrics.actualBoundingBoxLeft +
    metrics.actualBoundingBoxRight;

  if (
    !Number.isFinite(actualHeight) ||
    !Number.isFinite(actualWidth) ||
    actualHeight <= 0 ||
    actualWidth <= 0
  ) {
    return null;
  }

  
/*
 * IMPORTANT:
 *
 * Do not horizontally stretch the candidate before scoring.
 *
 * A font's natural glyph width and character spacing are
 * useful identification features. Stretching every candidate
 * to the source width hides some of those differences.
 *
 * Keep textScaleX as a diagnostic correction value only.
 */
const widthRatio =
  actualWidth / target.targetWidth;

const horizontalScale =
  target.targetWidth / actualWidth;

// Ignore candidates whose natural width is an extreme mismatch.
if (
  !Number.isFinite(widthRatio) ||
  widthRatio < 0.50 ||
  widthRatio > 2.00
) {
  return null;
}

  const baselineY =
    target.targetTop +
    metrics.actualBoundingBoxAscent;

context.save();

context.fillStyle = "#000000";
context.globalAlpha = 1;
context.textAlign = "left";
context.textBaseline = "alphabetic";
context.font = makeFontString(fontSize);

/*
 * Align the visible left ink edge with the source line.
 * Keep the candidate's natural horizontal proportions.
 */
context.fillText(
  text,
  target.targetLeft + metrics.actualBoundingBoxLeft,
  baselineY
);

context.restore();

  const imageData = context.getImageData(
    0,
    0,
    width,
    height
  );

  const data = imageData.data;

  const mask = new Uint8Array(width * height);

  let foregroundCount = 0;

  for (let i = 0; i < mask.length; i++) {
    const alpha = data[i * 4 + 3];

    if (alpha >= CANDIDATE_ALPHA_THRESHOLD) {
      mask[i] = 1;
      foregroundCount++;
    }
  }

  if (foregroundCount < 20) {
    return null;
  }

  return {
    mask,
    foregroundCount,

    fontSize,

    // Before horizontal fitting.
    widthRatio,

    // Horizontal correction applied to this candidate.
    textScaleX: horizontalScale,
  };
}


/* =========================================================
   SCORE ONE FONT CANDIDATE
   ========================================================= */

function evaluateFontCandidate({
  context,
  width,
  height,
  text,
  originalMask,
  target,
  font,
}) {
  const rendered = createCandidateMask({
    context,
    width,
    height,
    text,
    font,
    target,
  });

  if (!rendered) {
    return null;
  }

  const comparison = compareMasks(
    originalMask,
    rendered.mask,
    width,
    height
  );

  /*
   * Penalize candidates that need substantial horizontal
   * stretching to match the original text.
   *
   * A ratio near 1.0 means the natural font width is close.
   */
  const widthError = Math.abs(
    Math.log(
      Math.max(0.01, rendered.widthRatio)
    )
  );

  const widthFitScore = Math.exp(
    -0.65 * widthError
  );

  const adjustedScore =
    comparison.score * widthFitScore;

   return {
    family: font.family,
    fallback: font.fallback,

    source: font.source || "system",
    category: font.category || null,

    weight: font.weight,
    style: font.style,
    fontSize:
      rendered.fontSize / target.scaleY,

    widthRatio: rendered.widthRatio,

    textScaleX: rendered.textScaleX,

    maskScore: comparison.score,
tolerantF1: comparison.tolerantF1,

exactPrecision: comparison.exactPrecision,
exactRecall: comparison.exactRecall,
exactF1: comparison.exactF1,

rowProfileScore: comparison.rowProfileScore,
columnProfileScore: comparison.columnProfileScore,

areaBalance: comparison.areaBalance,
    widthFitScore,

    score: adjustedScore,

    precision: comparison.precision,
    recall: comparison.recall,

    originalPixels: comparison.originalPixels,
    candidatePixels: comparison.candidatePixels,
  };
}

/* =========================================================
   GOOGLE FONT CATALOG SHORTLIST
   ========================================================= */

function getFallbackForCategory(category) {
  switch (String(category || "").toLowerCase()) {
    case "serif":
      return "serif";

    case "monospace":
      return "monospace";

    case "handwriting":
      return "cursive";

    default:
      return "sans-serif";
  }
}


/**
 * Select a bounded, representative set of Google Fonts.
 *
 * Priority:
 * 1. Common document/resume families.
 * 2. Additional families sampled across catalog categories.
 *
 * We read the complete catalog but do not download all its fonts.
 */
function selectGoogleFontFamilies(
  catalogFamilies,
  requestedLimit = MAX_GOOGLE_FAMILIES
) {
  const limit = Math.max(
    1,
    Math.min(
      500,
      Math.floor(Number(requestedLimit) || MAX_GOOGLE_FAMILIES)
    )
  );

const allCatalogFamilies = Array.isArray(catalogFamilies)
  ? catalogFamilies
  : [];

const catalog = allCatalogFamilies.filter((font) => {
  const subsets = Array.isArray(font.subsets)
    ? font.subsets.map((value) =>
        String(value).toLowerCase()
      )
    : [];

  // Keep Latin-compatible families for this English OCR test.
  // Keep families with unknown subset metadata rather than
  // excluding them without evidence.
  return (
    !subsets.length ||
    subsets.includes("latin") ||
    subsets.includes("latin-ext")
  );
});

  const lookup = new Map(
    catalog.map((font) => [
      String(font.family || "").toLowerCase(),
      font,
    ])
  );

  const selected = new Map();

  function add(font) {
    if (
      !font?.family ||
      selected.size >= limit
    ) {
      return;
    }

    const key = font.family.toLowerCase();

    if (!selected.has(key)) {
      selected.set(key, {
        ...font,

        source: "google",

        fallback: getFallbackForCategory(
          font.category
        ),
      });
    }
  }

  // First select familiar document fonts.
  for (const familyName of PREFERRED_GOOGLE_FAMILIES) {
    const font = lookup.get(
      familyName.toLowerCase()
    );

    if (font) {
      add(font);
    }

    if (selected.size >= limit) {
      break;
    }
  }

  /*
   * Fill the remaining slots with evenly distributed
   * families from different catalog categories.
   */
  const remainingSlots = limit - selected.size;

  const categoryPlan = [
    {
      category: "sans-serif",
      share: 0.45,
    },
    {
      category: "serif",
      share: 0.25,
    },
    {
      category: "display",
      share: 0.15,
    },
    {
      category: "monospace",
      share: 0.10,
    },
    {
      category: "handwriting",
      share: 0.05,
    },
  ];

  function addStratified(category, count) {
    if (count <= 0 || selected.size >= limit) {
      return;
    }

    const available = catalog
      .filter((font) =>
        String(font.category || "").toLowerCase() === category
      )
      .filter((font) =>
        !selected.has(
          String(font.family || "").toLowerCase()
        )
      )
      .sort((a, b) =>
        String(a.family).localeCompare(
          String(b.family)
        )
      );

    const take = Math.min(
      count,
      available.length,
      limit - selected.size
    );

    if (!take) {
      return;
    }

    for (let i = 0; i < take; i++) {
      const index = Math.min(
        available.length - 1,
        Math.floor(
          ((i + 0.5) / take) * available.length
        )
      );

      add(available[index]);
    }
  }

  for (const item of categoryPlan) {
    const count = Math.ceil(
      remainingSlots * item.share
    );

    addStratified(item.category, count);
  }

  /*
   * Some catalogs may have fewer families in one category
   * than the planned allocation. Fill any unused slots from
   * the complete remaining catalog.
   */
  if (selected.size < limit) {
    const remaining = catalog
      .filter((font) =>
        !selected.has(
          String(font.family || "").toLowerCase()
        )
      )
      .sort((a, b) =>
        String(a.family).localeCompare(
          String(b.family)
        )
      );

    const needed = Math.min(
      limit - selected.size,
      remaining.length
    );

    for (let i = 0; i < needed; i++) {
      const index = Math.min(
        remaining.length - 1,
        Math.floor(
          ((i + 0.5) / needed) * remaining.length
        )
      );

      add(remaining[index]);
    }
  }

  return [...selected.values()];
}


/* =========================================================
   FONT VARIANT HELPERS
   ========================================================= */

function parseCatalogVariant(variant) {
  const value = String(variant || "").toLowerCase();

  if (value === "regular") {
    return {
      weight: 400,
      style: "normal",
    };
  }

  if (value === "italic") {
    return {
      weight: 400,
      style: "italic",
    };
  }

  const match = value.match(/^(\d+)(italic)?$/);

  if (!match) {
    return null;
  }

  return {
    weight: Number(match[1]),
    style: match[2]
      ? "italic"
      : "normal",
  };
}


function getCandidateStyles(font) {
  if (font.source === "system") {
    return [
      "normal",
      "italic",
    ];
  }

  if (font.isVariable) {
    const hasItalic =
      (font.variants || []).some((variant) =>
        /italic$/i.test(String(variant))
      ) ||
      (font.axes || []).some(
        (axis) => axis.tag === "ital"
      );

    return hasItalic
      ? ["normal", "italic"]
      : ["normal"];
  }

  const variants = (font.variants || [])
    .map(parseCatalogVariant)
    .filter(Boolean);

  const styles = [
    ...new Set(
      variants.map((variant) => variant.style)
    ),
  ];

  return styles.length
    ? styles
    : ["normal"];
}


function nearestWeight(weights, target) {
  if (!weights.length) {
    return 400;
  }

  return [...weights].sort(
    (a, b) =>
      Math.abs(a - target) -
      Math.abs(b - target)
  )[0];
}


function getCandidateWeights(
  font,
  style,
  refine = false
) {
 
  if (font.source === "system") {
  return [400, 700];
}

  // Variable fonts: use their actual weight axis.
  if (font.isVariable) {
    const weightAxis = (font.axes || []).find(
      (axis) => axis.tag === "wght"
    );

    if (!weightAxis) {
      return [400];
    }

    const minimum = Number(weightAxis.start);
    const maximum = Number(weightAxis.end);

    if (
      !Number.isFinite(minimum) ||
      !Number.isFinite(maximum) ||
      maximum < minimum
    ) {
      return [400];
    }

    const clampWeight = (weight) =>
      Math.round(
        Math.max(
          minimum,
          Math.min(maximum, weight)
        )
      );

    if (!refine) {
      return [
        ...new Set([
          clampWeight(400),
          clampWeight(700),
        ]),
      ];
    }

    const values = REFINE_WEIGHTS.filter(
      (weight) =>
        weight >= minimum &&
        weight <= maximum
    );

    values.push(
      Math.round(minimum),
      Math.round(maximum)
    );

    return [
      ...new Set(values),
    ].sort((a, b) => a - b);
  }

  // Static fonts: only test weights actually available.
  const availableWeights = [
    ...new Set(
      (font.variants || [])
        .map(parseCatalogVariant)
        .filter((variant) =>
          variant &&
          variant.style === style
        )
        .map((variant) => variant.weight)
    ),
  ].sort((a, b) => a - b);

  if (!availableWeights.length) {
    return style === "normal"
      ? [400]
      : [];
  }

  if (refine) {
    return availableWeights;
  }

  // Coarse search tests the nearest regular and bold variants.
  return [
    ...new Set([
      nearestWeight(availableWeights, 400),
      nearestWeight(availableWeights, 700),
    ]),
  ].sort((a, b) => a - b);
}

/* =========================================================
   CONTROLLED FONT LOADING
   ========================================================= */

function fontFaceKey(font, weight, style) {
  return `${font.family}|${weight}|${style}`;
}


async function loadGoogleFontFaces(
  tasks,
  sampleText,
  loadedFaceKeys,
  loadedFamilies,
  failedFamilies
) {
  const uniqueTasks = new Map();

  for (const task of tasks) {
    if (task.font.source !== "google") {
      continue;
    }

    const key = fontFaceKey(
      task.font,
      task.weight,
      task.style
    );

    if (!loadedFaceKeys.has(key)) {
      uniqueTasks.set(key, task);
    }
  }

  const pending = [
    ...uniqueTasks.entries(),
  ];

  let nextIndex = 0;

  async function worker() {
    while (nextIndex < pending.length) {
      const [key, task] = pending[nextIndex++];

      let lastError = null;

      /*
       * Two attempts:
       * - Initial Google Fonts load.
       * - One retry for intermittent loading failures.
       */
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await loadGoogleFontFamily(
            task.font.family,
            {
              weight: task.weight,

              style: task.style,

              includeItalic: true,

              sampleText,
            }
          );

          lastError = null;
          break;

        } catch (error) {
          lastError = error;

          if (attempt === 1) {
            await new Promise((resolve) =>
              setTimeout(resolve, 300)
            );
          }
        }
      }

      if (lastError) {
        failedFamilies.add(
          `${task.font.family} [${task.weight} ${task.style}]`
        );

        console.warn(
          "[Paddle Typography] Google Font face failed after retry:",
          {
            family: task.font.family,
            weight: task.weight,
            style: task.style,
            error:
              lastError.message || String(lastError),
          }
        );

        continue;
      }

      loadedFaceKeys.add(key);

      loadedFamilies.add(
        task.font.family
      );
    }
  }

  const workerCount = Math.min(
    FONT_LOAD_CONCURRENCY,
    pending.length
  );

  await Promise.all(
    Array.from(
      { length: workerCount },
      () => worker()
    )
  );
}

/* =========================================================
   PUBLIC TYPOGRAPHY MATCHER
   ========================================================= */

export async function estimateTypographyCandidates({
  raster,
  text,
  inkBounds,
  backgroundColor,

 characterMeasurements,
ocrScaleX = 1,
ocrScaleY = ocrScaleX,

googleFamilyLimit = MAX_GOOGLE_FAMILIES,
} = {}) {

  const fallback = {
    status: "unavailable",

   method: "catalog-backed-natural-width-mask-profile-search",
    best: null,

    topCandidates: [],
    topFamilies: [],

    familyCandidates: [],

    candidateCount: 0,

    catalogFamilyCount: 0,
    googleCandidateCount: 0,
    googleLoadedFamilyCount: 0,
  };

  try {
    const normalizedText = String(text || "").trim();

    if (
      !normalizedText ||
      normalizedText.length < 3 ||
      normalizedText.length > 120
    ) {
      return {
        ...fallback,
        status: "unsupported-text-length",
      };
    }

    const bounds = inkBounds;

    if (
      !bounds ||
      ![
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
      ].every((value) =>
        Number.isFinite(Number(value))
      ) ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      return {
        ...fallback,
        status: "invalid-ink-bounds",
      };
    }

    const background = hexToRgb(backgroundColor);

    if (!background) {
      return {
        ...fallback,
        status: "missing-background-color",
      };
    }

    const original = createOriginalInkMask({
      raster,
      bounds,
      backgroundColor: background,
    });

    if (!original) {
      return {
        ...fallback,
        status: "insufficient-source-ink",
      };
    }

const glyphExtraction =
  extractOriginalGlyphDiagnostics({
    original,

    characterMeasurements,

    raster,

    ocrScaleX,
    ocrScaleY,
  });

    const target = {
  targetLeft: original.targetLeft,
  targetTop: original.targetTop,
  targetWidth: original.targetWidth,
  targetHeight: original.targetHeight,
  scaleY: original.scaleY,
};

/*
 * Candidates are now rendered at natural width.
 *
 * Expand the comparison canvas to the right so that a
 * naturally wider font is not clipped at the source line's
 * original right boundary.
 */
const desiredComparisonWidth =
  original.width +
  Math.ceil(target.targetWidth * 1.25);

const maxComparisonWidth = Math.max(
  original.width,
  Math.floor(
    MAX_COMPARISON_PIXELS / original.height
  )
);

const comparisonWidth = Math.max(
  original.width,
  Math.min(
    desiredComparisonWidth,
    maxComparisonWidth
  )
);

/*
 * Copy the original mask into the expanded canvas.
 * Its original coordinates remain unchanged.
 */
const comparisonOriginalMask = new Uint8Array(
  comparisonWidth * original.height
);

for (let y = 0; y < original.height; y++) {
  const sourceStart = y * original.width;
  const sourceEnd = sourceStart + original.width;

  const destinationStart = y * comparisonWidth;

  comparisonOriginalMask.set(
    original.mask.subarray(
      sourceStart,
      sourceEnd
    ),
    destinationStart
  );
}

const canvas = document.createElement("canvas");

canvas.width = comparisonWidth;
canvas.height = original.height;

const context = canvas.getContext("2d", {
  willReadFrequently: true,
});

if (!context) {
  return {
    ...fallback,
    status: "canvas-unavailable",
  };
}

   const fontSampleText = FONT_LOAD_SAMPLE_TEXT;

    let catalogFamilies = [];
    let catalogError = null;

    try {
      const catalog = await getGoogleFontCatalog();

      catalogFamilies = Array.isArray(catalog.families)
        ? catalog.families
        : [];

    } catch (error) {
      catalogError = error?.message || String(error);

      console.warn(
        "[Paddle Typography] Google Fonts catalog unavailable:",
        catalogError
      );
    }

    const googleFamilies = selectGoogleFontFamilies(
      catalogFamilies,
      googleFamilyLimit
    );

    const allFamilies = [
      ...SYSTEM_FONT_CANDIDATES,
      ...googleFamilies,
    ];

    const loadedFaceKeys = new Set();
    const loadedGoogleFamilies = new Set();
    const failedGoogleFamilies = new Set();

    const candidateResults = new Map();

    function evaluate(family, weight, style) {
      const key = fontFaceKey(
        family,
        weight,
        style
      );

      /*
       * Never measure a Google Font that failed to load.
       * Otherwise Canvas could silently use a fallback font.
       */
      if (
        family.source === "google" &&
        !loadedFaceKeys.has(key)
      ) {
        return;
      }
const result = evaluateFontCandidate({
  context,

  width: comparisonWidth,
  height: original.height,

  text: normalizedText,

  originalMask: comparisonOriginalMask,

  target,

  font: {
    ...family,
    weight,
    style,
  },
});
      if (result) {
        candidateResults.set(key, result);
      }
    }


    /* =====================================================
       PASS 1 — COARSE GOOGLE FONT FAMILY SEARCH
       ===================================================== */

    const coarseGoogleTasks = [];

  for (const family of googleFamilies) {
  const styles = getCandidateStyles(family);

  for (const style of styles) {
    const weights = getCandidateWeights(
      family,
      style,
      false
    );

    for (const weight of weights) {
      coarseGoogleTasks.push({
        font: family,
        weight,
        style,
      });
    }
  }
}

    await loadGoogleFontFaces(
      coarseGoogleTasks,
      fontSampleText,
      loadedFaceKeys,
      loadedGoogleFamilies,
      failedGoogleFamilies
    );


   for (const family of SYSTEM_FONT_CANDIDATES) {
  for (const weight of [400, 700]) {
    for (const style of ["normal", "italic"]) {
      evaluate(
        family,
        weight,
        style
      );
    }
  }
}

    // Evaluate the successfully loaded Google families.
    for (const task of coarseGoogleTasks) {
      evaluate(
        task.font,
        task.weight,
        task.style
      );
    }


    const coarseResults = [
      ...candidateResults.values(),
    ];

   if (!coarseResults.length) {
  return {
    ...fallback,

    status: "no-valid-font-candidates",

    catalogFamilyCount: catalogFamilies.length,

    googleCandidateCount: googleFamilies.length,

    googleLoadedFamilyCount:
      loadedGoogleFamilies.size,

    googleLoadFailures: [
      ...failedGoogleFamilies,
    ].slice(0, 15),

    catalogError,

    // Original character extraction diagnostics.
    glyphExtraction,
  };
}


    /* =====================================================
       SELECT THE STRONGEST FAMILIES FOR REFINEMENT
       ===================================================== */

    const coarseFamilyScores = new Map();

    for (const candidate of coarseResults) {
      const previous = coarseFamilyScores.get(
        candidate.family
      );

      if (
        !previous ||
        candidate.score > previous.score
      ) {
        coarseFamilyScores.set(
          candidate.family,
          candidate
        );
      }
    }

    const familyLookup = new Map(
      allFamilies.map((family) => [
        family.family,
        family,
      ])
    );

    const refineFamilies = [
      ...coarseFamilyScores.values(),
    ]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_REFINE_FAMILIES)
      .map((candidate) =>
        familyLookup.get(candidate.family)
      )
      .filter(Boolean);


    /* =====================================================
       PASS 2 — WEIGHT AND STYLE REFINEMENT
       ===================================================== */

    const refineTasks = [];

    for (const family of refineFamilies) {
      const styles = getCandidateStyles(family);

      for (const style of styles) {
        const weights = getCandidateWeights(
          family,
          style,
          true
        );

        for (const weight of weights) {
          refineTasks.push({
            font: family,
            weight,
            style,
          });
        }
      }
    }


    await loadGoogleFontFaces(
      refineTasks,
      fontSampleText,
      loadedFaceKeys,
      loadedGoogleFamilies,
      failedGoogleFamilies
    );


    /*
     * Re-evaluation of the refined family variants.
     */
    for (const family of refineFamilies) {
      const styles = getCandidateStyles(family);

      for (const style of styles) {
        const weights = getCandidateWeights(
          family,
          style,
          true
        );

        for (const weight of weights) {
          evaluate(
            family,
            weight,
            style
          );
        }
      }
    }


    /* =====================================================
       RANK ALL CANDIDATES
       ===================================================== */

    const allCandidates = [
      ...candidateResults.values(),
    ].sort((a, b) => b.score - a.score);

  if (!allCandidates.length) {
  return {
    ...fallback,

    status: "no-valid-font-candidates",

    // Original character extraction diagnostics.
    glyphExtraction,
  };
}


    /* =====================================================
       BEST RESULT PER FONT FAMILY
       ===================================================== */

    const familyBestMap = new Map();

    for (const candidate of allCandidates) {
      const previous = familyBestMap.get(
        candidate.family
      );

      if (
        !previous ||
        candidate.score > previous.score
      ) {
        familyBestMap.set(
          candidate.family,
          candidate
        );
      }
    }

    const rankedFamilies = [
      ...familyBestMap.values(),
    ].sort((a, b) => b.score - a.score);

const familyStyleWeightBestMap = new Map();

for (const candidate of allCandidates) {
  const key =
    `${candidate.family}|${candidate.style}|${candidate.weight}`;

  const previous = familyStyleWeightBestMap.get(key);

  if (
    !previous ||
    candidate.score > previous.score
  ) {
    familyStyleWeightBestMap.set(key, candidate);
  }
}

const rankedFamilyStyles = [
  ...familyStyleWeightBestMap.values(),
].sort((a, b) => b.score - a.score);


    const topFamilies = rankedFamilies
      .slice(0, 5)
      .map((candidate) => ({
        family: candidate.family,

        source: candidate.source,

        category: candidate.category,

        score: Number(
          candidate.score.toFixed(4)
        ),

        weight: candidate.weight,

        style: candidate.style,

        widthRatio: Number(
          candidate.widthRatio.toFixed(4)
        ),
      }));

    const best = allCandidates[0];


    /* =====================================================
       WEIGHT AMBIGUITY
       ===================================================== */

    const sameFamilyStyleCandidates = allCandidates.filter(
      (candidate) =>
        candidate.family === best.family &&
        candidate.style === best.style
    );

    const alternateWeightCandidates =
      sameFamilyStyleCandidates.filter(
        (candidate) =>
          candidate.weight !== best.weight
      );

    const bestAlternateWeight =
      alternateWeightCandidates[0] || null;

    const weightMargin = bestAlternateWeight
      ? best.score - bestAlternateWeight.score
      : 0;

    const weightAmbiguous =
      !bestAlternateWeight ||
      weightMargin < 0.01;


    /* =====================================================
       STYLE AMBIGUITY
       ===================================================== */

    const alternateStyleCandidates = allCandidates.filter(
      (candidate) =>
        candidate.family === best.family &&
        candidate.style !== best.style
    );

    const bestAlternateStyle =
      alternateStyleCandidates[0] || null;

    const styleMargin = bestAlternateStyle
      ? best.score - bestAlternateStyle.score
      : 0;

    const styleAmbiguous =
      !bestAlternateStyle ||
      styleMargin < 0.015;


    /* =====================================================
       FAMILY AMBIGUITY
       ===================================================== */

    const secondFamily = rankedFamilies[1];

    const familyMargin = secondFamily
      ? best.score - secondFamily.score
      : 0;

    const familyAmbiguous =
      !secondFamily ||
      familyMargin < 0.03;


    /* =====================================================
       FINAL DIAGNOSTIC RESULT
       ===================================================== */

    return {
      status: "candidate-match",

     method: "catalog-backed-natural-width-mask-profile-search",

      // Similarity score, not a probability.
      matchScore: Number(
        best.score.toFixed(4)
      ),

      familyMargin: Number(
        familyMargin.toFixed(4)
      ),

      familyAmbiguous,

      weightMargin: Number(
        weightMargin.toFixed(4)
      ),

      weightAmbiguous,

      styleMargin: Number(
        styleMargin.toFixed(4)
      ),

      styleAmbiguous,

      best: {
        fontFamily:
          `"${best.family}", ${best.fallback}`,

        family: best.family,

        source: best.source,

        category: best.category,

        fontWeight: best.weight,

        fontWeightAmbiguous: weightAmbiguous,

        fontStyle: best.style,

        fontStyleAmbiguous: styleAmbiguous,

        fontSize: Number(
          best.fontSize.toFixed(2)
        ),

        score: Number(
          best.score.toFixed(4)
        ),

        maskScore: Number(
          best.maskScore.toFixed(4)
        ),


tolerantF1: Number(
  best.tolerantF1.toFixed(4)
),

exactF1: Number(
  best.exactF1.toFixed(4)
),

rowProfileScore: Number(
  best.rowProfileScore.toFixed(4)
),

columnProfileScore: Number(
  best.columnProfileScore.toFixed(4)
),

areaBalance: Number(
  best.areaBalance.toFixed(4)
),

        widthFitScore: Number(
          best.widthFitScore.toFixed(4)
        ),

        precision: Number(
          best.precision.toFixed(4)
        ),

        recall: Number(
          best.recall.toFixed(4)
        ),

        widthRatio: Number(
          best.widthRatio.toFixed(4)
        ),

        textScaleX: Number(
          best.textScaleX.toFixed(4)
        ),
      },

      topCandidates: allCandidates
        .slice(0, 10)
        .map((candidate) => ({
          family: candidate.family,

          source: candidate.source,

          weight: candidate.weight,

          style: candidate.style,

          fontSize: Number(
            candidate.fontSize.toFixed(2)
          ),

          score: Number(
            candidate.score.toFixed(4)
          ),

tolerantF1: Number(
  candidate.tolerantF1.toFixed(4)
),

exactF1: Number(
  candidate.exactF1.toFixed(4)
),

rowProfileScore: Number(
  candidate.rowProfileScore.toFixed(4)
),

columnProfileScore: Number(
  candidate.columnProfileScore.toFixed(4)
),

areaBalance: Number(
  candidate.areaBalance.toFixed(4)
),


          widthRatio: Number(
            candidate.widthRatio.toFixed(4)
          ),

          textScaleX: Number(
            candidate.textScaleX.toFixed(4)
          ),
        })),

      topFamilies,

    familyCandidates: rankedFamilyStyles
  .map((candidate) => ({
    family: candidate.family,

    source: candidate.source,

    category: candidate.category || null,

    weight: candidate.weight,

    style: candidate.style,

    score: Number(
      candidate.score.toFixed(4)
    ),

tolerantF1: Number(
  candidate.tolerantF1.toFixed(4)
),

exactF1: Number(
  candidate.exactF1.toFixed(4)
),

rowProfileScore: Number(
  candidate.rowProfileScore.toFixed(4)
),

columnProfileScore: Number(
  candidate.columnProfileScore.toFixed(4)
),

    widthRatio: Number(
      candidate.widthRatio.toFixed(4)
    ),

    textScaleX: Number(
      candidate.textScaleX.toFixed(4)
    ),
  })),

      candidateCount: allCandidates.length,

      systemCandidateCount:
        SYSTEM_FONT_CANDIDATES.length,

      catalogFamilyCount:
        catalogFamilies.length,

      googleCandidateCount:
        googleFamilies.length,

      googleLoadedFamilyCount:
        loadedGoogleFamilies.size,

      googleLoadFailures: [
        ...failedGoogleFamilies,
      ].slice(0, 15),

      refinedFamilyCount:
        refineFamilies.length,

      catalogError,

    originalInkPixels: original.foregroundCount,

originalInkBounds: {
  width: bounds.width,
  height: bounds.height,
},

glyphExtraction,
    };

  } catch (error) {
    console.warn(
      "[Paddle Typography] Candidate matching failed:",
      error
    );

    return {
      ...fallback,

      status: "error",

      error: error?.message || String(error),
    };
  }
}

/// api key for Google Fonts API, used for geocoding and other map services.
// AIzaSyCHB2PnXt_QCpsGUCFbghVlbr_Lh_ty_s4