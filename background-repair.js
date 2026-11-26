
/**
 * src/editor/background-repair.js
 *
 * Background repair for OCR-generated text blocks.
 *
 * Initial algorithm:
 * 1. Get the original page's rendered pixels.
 * 2. Extract the selected text region with padding.
 * 3. Estimate the background using horizontal and vertical
 *    interpolation from surrounding pixels.
 * 4. Detect pixels that contrast with the estimated background.
 * 5. Expand the detected mask slightly to cover antialiased edges.
 * 6. Preserve obvious long horizontal and vertical lines.
 * 7. Create a transparent PNG patch containing only replacement pixels.
 * 8. Store the patch in the page model and render it underneath text.
 *
 * IMPORTANT LIMITATIONS:
 * - This is not a neural inpainting algorithm.
 * - It works best on solid or smoothly changing backgrounds.
 * - Complex textures and photographs need better restoration.
 * - The line-preservation heuristic cannot recognize every border.
 * - A patch is a visual repair, not secure PDF redaction.
 */

import {
  createId,
  getPageById,
  getPageObject,
  addPageObject,
  removePageObject,
  setStatusMessage,
} from "../state.js";

import {
  clampRectToPage,
} from "../utils/coordinates.js";

import {
  inpaintWithOpenCVWorker,
} from "../ocr/paddle-inpaint-client.js";

/* =========================================================
   CONFIGURATION
   ========================================================= */

const DEFAULT_PADDING_RATIO = 0.25;
const MIN_PADDING = 3;

const DEFAULT_CONTRAST_THRESHOLD = 18;
const MAX_PATCH_PIXELS = 8_000_000;

const MASK_DILATION_RADIUS = 2;
// Telea neighborhood radius, measured in source bitmap pixels.
const DEFAULT_INPAINT_RADIUS = 6;
// Detect faint antialiased pixels around strong text pixels.
const WEAK_EDGE_THRESHOLD = 6;

// Search up to 3 pixels from a strong text pixel.
const WEAK_EDGE_GROW_RADIUS = 3;

// Additional protection around measured character ink bounds.
const CHARACTER_MASK_PADDING = 2;

// Detect extremely faint antialiased pixels,
// but only inside measured character ink bounds.
const CHARACTER_CORE_THRESHOLD = 3.5;

/* =========================================================
   VALIDATION
   ========================================================= */

function requirePage(page) {
  if (!page || !page.id) {
    throw new Error(
      "A valid page model is required for background repair."
    );
  }

  const width = Number(page.sourceWidth || page.width);
  const height = Number(page.sourceHeight || page.height);

  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(
      "The page has invalid source dimensions."
    );
  }

  return { width, height };
}

function requireRenderedPage(renderedPage) {
  if (!renderedPage?.pageElement) {
    throw new Error(
      "Render the page before repairing its background."
    );
  }

  if (!renderedPage.objectLayer) {
    throw new Error(
      "The rendered page does not have an object layer."
    );
  }
}
/**
 * Restrict a numeric value to the inclusive range [min, max].
 */
function clamp(value, min, max) {
  return Math.min(
    Math.max(Number(value), min),
    max
  );
}
function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}


/* =========================================================
   ORIGINAL PAGE PIXELS
   ========================================================= */

/**
 * Return the source pixels and coordinate scale.
 *
 * PDF pages:
 *   The source is the canvas rendered by PDF.js.
 *
 * Image pages:
 *   The source is the original HTMLImageElement.
 *
 * Editable model positions remain in the page source coordinate
 * system. Pixel scaling maps those coordinates to actual bitmap
 * coordinates.
 */
function getPageRaster(renderedPage, pageWidth, pageHeight) {
  let source = null;

  if (
    renderedPage.canvas instanceof HTMLCanvasElement
  ) {
    source = renderedPage.canvas;
  } else if (
    renderedPage.backgroundElement instanceof HTMLImageElement
  ) {
    source = renderedPage.backgroundElement;
  }

  if (!source) {
    throw new Error(
      "The rendered page does not have readable source pixels."
    );
  }

  const bitmapWidth =
    source instanceof HTMLCanvasElement
      ? source.width
      : source.naturalWidth;

  const bitmapHeight =
    source instanceof HTMLCanvasElement
      ? source.height
      : source.naturalHeight;

  if (
    !bitmapWidth ||
    !bitmapHeight ||
    bitmapWidth <= 0 ||
    bitmapHeight <= 0
  ) {
    throw new Error(
      "The source page has invalid bitmap dimensions."
    );
  }

  return {
    source,
    bitmapWidth,
    bitmapHeight,

    // Convert source-page coordinates into bitmap pixels.
    bitmapScaleX: bitmapWidth / pageWidth,
    bitmapScaleY: bitmapHeight / pageHeight,

    pageWidth,
    pageHeight,
  };
}


/* =========================================================
   TEXT BOUNDS
   ========================================================= */

function getTextBounds(block) {
  const bounds = block.bounds || {
    x: block.x,
    y: block.y,
    width: block.width,
    height: block.height,
  };

  const result = {
    x: Number(bounds.x),
    y: Number(bounds.y),
    width: Number(bounds.width),
    height: Number(bounds.height),
  };

  if (
    !Object.values(result).every(Number.isFinite) ||
    result.width <= 0 ||
    result.height <= 0
  ) {
    throw new Error(
      "The selected text block has invalid bounds."
    );
  }

  return result;
}

/**
 * Pad a text rectangle so the estimator can sample background
 * above, below, to the left, and to the right of the text.
 */
function makePaddedRegion(
  textBounds,
  pageWidth,
  pageHeight,
  paddingRatio
) {
  const padX = Math.max(
    MIN_PADDING,
    textBounds.height * paddingRatio
  );

  const padY = Math.max(
    MIN_PADDING,
    textBounds.height * paddingRatio
  );

  return clampRectToPage(
    {
      x: textBounds.x - padX,
      y: textBounds.y - padY,
      width: textBounds.width + padX * 2,
      height: textBounds.height + padY * 2,
    },
    pageWidth,
    pageHeight
  );
}


/* =========================================================
   EXTRACT A LOCAL BITMAP
   ========================================================= */

async function extractRegion(
  raster,
  region,
  existingRepairPatches = []
) {
  const {
    source,
    bitmapScaleX,
    bitmapScaleY,
    bitmapWidth,
    bitmapHeight,
  } = raster;

  const pixelLeft = Math.max(
    0,
    Math.floor(region.x * bitmapScaleX)
  );

  const pixelTop = Math.max(
    0,
    Math.floor(region.y * bitmapScaleY)
  );

  const pixelRight = Math.min(
    bitmapWidth,
    Math.ceil(
      (region.x + region.width) * bitmapScaleX
    )
  );

  const pixelBottom = Math.min(
    bitmapHeight,
    Math.ceil(
      (region.y + region.height) * bitmapScaleY
    )
  );

  const width = pixelRight - pixelLeft;
  const height = pixelBottom - pixelTop;

  if (width <= 0 || height <= 0) {
    throw new Error(
      "The selected repair region is outside the page."
    );
  }

  if (width * height > MAX_PATCH_PIXELS) {
    throw new Error(
      "The repair region is too large. Select a smaller text block."
    );
  }

  const canvas = document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!context) {
    throw new Error(
      "Could not create the background-repair canvas."
    );
  }

  context.imageSmoothingEnabled = true;

  // STEP 1: Draw the original page pixels.
  context.drawImage(
    source,
    pixelLeft,
    pixelTop,
    width,
    height,
    0,
    0,
    width,
    height
  );

  // STEP 2: Composite previously completed repairs.
  // This prevents a new repair from using an uncorrected
  // version of pixels already repaired by an earlier patch.

  let compositedRepairCount = 0;

  for (const patch of existingRepairPatches) {
    if (
      !patch ||
      !patch.dataUrl ||
      !Number.isFinite(Number(patch.x)) ||
      !Number.isFinite(Number(patch.y)) ||
      !Number.isFinite(Number(patch.width)) ||
      !Number.isFinite(Number(patch.height))
    ) {
      continue;
    }

    // Convert existing patch coordinates into bitmap pixels.
    const patchLeft = Number(patch.x) * bitmapScaleX;
    const patchTop = Number(patch.y) * bitmapScaleY;

    const patchWidth = Number(patch.width) * bitmapScaleX;
    const patchHeight = Number(patch.height) * bitmapScaleY;

    const patchRight = patchLeft + patchWidth;
    const patchBottom = patchTop + patchHeight;

    // Skip patches that do not intersect the current crop.
    const intersects =
      patchLeft < pixelRight &&
      patchRight > pixelLeft &&
      patchTop < pixelBottom &&
      patchBottom > pixelTop;

    if (!intersects) {
      continue;
    }

    // Load the already-created transparent repair PNG.
    const image = new Image();

    image.decoding = "async";
    image.src = patch.dataUrl;

    if (typeof image.decode === "function") {
      await image.decode();
    } else {
      await new Promise((resolve, reject) => {
        image.onload = resolve;

        image.onerror = () => {
          reject(
            new Error(
              `Could not load previous repair patch: ${patch.id}`
            )
          );
        };
      });
    }

    // Draw it in the correct position relative to this crop.
    const destinationX = patchLeft - pixelLeft;
    const destinationY = patchTop - pixelTop;

    context.drawImage(
      image,
      destinationX,
      destinationY,
      patchWidth,
      patchHeight
    );

    compositedRepairCount++;
  }

  // STEP 3: Read the combined original + previous repairs.
  const imageData = context.getImageData(
    0,
    0,
    width,
    height
  );

  const actualRegion = {
    x: pixelLeft / bitmapScaleX,
    y: pixelTop / bitmapScaleY,

    width: width / bitmapScaleX,
    height: height / bitmapScaleY,
  };

  return {
    canvas,
    context,
    imageData,
    width,
    height,

    actualRegion,

    pixelLeft,
    pixelTop,

    compositedRepairCount,
  };
}


/* =========================================================
   ESTIMATE BACKGROUND COLOR
   ========================================================= */

function rgbOffset(index) {
  return index * 4;
}

function getRgb(data, x, y, width) {
  const offset = rgbOffset(y * width + x);

  return [
    data[offset],
    data[offset + 1],
    data[offset + 2],
  ];
}

function averageColors(colors) {
  if (!colors.length) {
    return [255, 255, 255];
  }

  const totals = [0, 0, 0];

  for (const color of colors) {
    totals[0] += color[0];
    totals[1] += color[1];
    totals[2] += color[2];
  }

  return totals.map(
    (value) => value / colors.length
  );
}

function sampleRow(data, width, y, xStart, xEnd) {
  const colors = [];

  const start = Math.max(0, Math.floor(xStart));
  const end = Math.min(width, Math.ceil(xEnd));

  for (let x = start; x < end; x++) {
    colors.push(getRgb(data, x, y, width));
  }

  return averageColors(colors);
}

function sampleColumn(
  data,
  width,
  height,
  x,
  yStart,
  yEnd
) {
  const colors = [];

  const start = Math.max(0, Math.floor(yStart));
  const end = Math.min(height, Math.ceil(yEnd));

  for (let y = start; y < end; y++) {
    colors.push(getRgb(data, x, y, width));
  }

  return averageColors(colors);
}

function interpolateColor(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/**
 * Estimate background pixels for the patch.
 *
 * For each pixel:
 * - estimate color using the top and bottom boundaries;
 * - estimate color using the left and right boundaries;
 * - combine the two estimates.
 *
 * This is an approximation of a smoothly varying background.
 */
function estimateBackground(imageData, target) {
  const { width, height, data } = imageData;

  const topY = Math.max(
    0,
    Math.min(height - 1, target.top - 1)
  );

  const bottomY = Math.max(
    0,
    Math.min(height - 1, target.bottom)
  );

  const leftX = Math.max(
    0,
    Math.min(width - 1, target.left - 1)
  );

  const rightX = Math.max(
    0,
    Math.min(width - 1, target.right)
  );

  const topColors = [];
  const bottomColors = [];
  const leftColors = [];
  const rightColors = [];

  for (let x = 0; x < width; x++) {
    topColors[x] = sampleColumn(
      data,
      width,
      height,
      x,
      0,
      Math.max(1, target.top)
    );

    bottomColors[x] = sampleColumn(
      data,
      width,
      height,
      x,
      Math.min(height - 1, target.bottom),
      height
    );
  }

  for (let y = 0; y < height; y++) {
    leftColors[y] = sampleRow(
      data,
      width,
      y,
      0,
      Math.max(1, target.left)
    );

    rightColors[y] = sampleRow(
      data,
      width,
      y,
      Math.min(width - 1, target.right),
      width
    );
  }

  /*
   * Avoid unused-boundary cases when a text box touches a page
   * edge. There is less information there, so the estimate will
   * necessarily be less reliable.
   */
  const result = new Float32Array(width * height * 3);

  const targetHeight = Math.max(
    1,
    target.bottom - target.top
  );

  const targetWidth = Math.max(
    1,
    target.right - target.left
  );

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const verticalT = clamp(
        (y - target.top) / targetHeight,
        0,
        1
      );

      const horizontalT = clamp(
        (x - target.left) / targetWidth,
        0,
        1
      );

      const vertical = interpolateColor(
        topColors[x],
        bottomColors[x],
        verticalT
      );

      const horizontal = interpolateColor(
        leftColors[y],
        rightColors[y],
        horizontalT
      );

      const offset = (y * width + x) * 3;

      result[offset] =
        (vertical[0] + horizontal[0]) / 2;

      result[offset + 1] =
        (vertical[1] + horizontal[1]) / 2;

      result[offset + 2] =
        (vertical[2] + horizontal[2]) / 2;
    }
  }

  return result;
}

/* =========================================================
   CHARACTER-GUIDED REPAIR REGIONS
   ========================================================= */

function getCharacterRepairRegions({
  textBlock,
  actualRegion,
  regionScaleX,
  regionScaleY,
  width,
  height,
}) {
  const characters =
    textBlock.characterMeasurements?.characters || [];

  const regions = [];

  for (const character of characters) {
    if (
      character.status === "space" ||
      character.status === "no-visible-ink" ||
      /^\s+$/u.test(String(character.text ?? ""))
    ) {
      continue;
    }

    let bounds = character.inkBounds;

    // Fall back to the measured character polygon.
    if (!bounds && Array.isArray(character.polygon)) {
      const points = character.polygon;

      const xs = points.map(p => Number(p[0]));
      const ys = points.map(p => Number(p[1]));

      if (
        points.length >= 3 &&
        xs.every(Number.isFinite) &&
        ys.every(Number.isFinite)
      ) {
        bounds = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        };
      }
    }

    if (!bounds) continue;

    const values = [
      Number(bounds.x),
      Number(bounds.y),
      Number(bounds.width),
      Number(bounds.height),
    ];

    if (
      !values.every(Number.isFinite) ||
      values[2] <= 0 ||
      values[3] <= 0
    ) {
      continue;
    }

   // Exact measured character ink rectangle.
const coreLeft = clamp(
  Math.floor(
    (values[0] - actualRegion.x) * regionScaleX
  ),
  0,
  width
);

const coreTop = clamp(
  Math.floor(
    (values[1] - actualRegion.y) * regionScaleY
  ),
  0,
  height
);

const coreRight = clamp(
  Math.ceil(
    (values[0] + values[2] - actualRegion.x) * regionScaleX
  ),
  0,
  width
);

const coreBottom = clamp(
  Math.ceil(
    (values[1] + values[3] - actualRegion.y) * regionScaleY
  ),
  0,
  height
);

// Slightly expanded region for antialiased edges.
const left = Math.max(
  0,
  coreLeft - CHARACTER_MASK_PADDING
);

const top = Math.max(
  0,
  coreTop - CHARACTER_MASK_PADDING
);

const right = Math.min(
  width,
  coreRight + CHARACTER_MASK_PADDING
);

const bottom = Math.min(
  height,
  coreBottom + CHARACTER_MASK_PADDING
);

if (
  coreRight <= coreLeft ||
  coreBottom <= coreTop ||
  right <= left ||
  bottom <= top
) {
  continue;
}

regions.push({
  left,
  top,
  right,
  bottom,

  coreLeft,
  coreTop,
  coreRight,
  coreBottom,

  character: character.text,
  status: character.status,
});

  }

  return regions;
}

/* =========================================================
   TEXT MASK DETECTION
   ========================================================= */

function detectTextMask(
  imageData,
  background,
  target,
  threshold,
  characterRegions = []
) {
  const { width, height, data } = imageData;

  const size = width * height;

const strongMask = new Uint8Array(size);
const weakMask = new Uint8Array(size);

const characterMask = new Uint8Array(size);

const characterCoreMask = new Uint8Array(size);

const distanceMap = new Float32Array(size);

  const left = clamp(target.left, 0, width);
  const right = clamp(target.right, 0, width);
  const top = clamp(target.top, 0, height);
  const bottom = clamp(target.bottom, 0, height);

  let strongCount = 0;

  // -----------------------------------------------------
  // 1. Strong contrast detection
  // -----------------------------------------------------

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const index = y * width + x;

      const sourceOffset = index * 4;
      const backgroundOffset = index * 3;

      const dr =
        data[sourceOffset] -
        background[backgroundOffset];

      const dg =
        data[sourceOffset + 1] -
        background[backgroundOffset + 1];

      const db =
        data[sourceOffset + 2] -
        background[backgroundOffset + 2];

      const distance = Math.sqrt(
        dr * dr + dg * dg + db * db
      );

distanceMap[index] = distance;

      if (distance >= threshold) {
        strongMask[index] = 1;
        strongCount++;
      } else if (distance >= WEAK_EDGE_THRESHOLD) {
        weakMask[index] = 1;
      }
    }
  }

  // -----------------------------------------------------
  // 2. Expand strong detections into nearby weak edges
  // -----------------------------------------------------

  const searchBounds = {
    left,
    right,
    top,
    bottom,
  };

  const strongNeighborhood = dilateMask(
    strongMask,
    width,
    height,
    searchBounds,
    WEAK_EDGE_GROW_RADIUS
  );

  // -----------------------------------------------------
  // 3. Build character-guided regions
  // -----------------------------------------------------

for (const region of characterRegions) {

  // Expanded character region.
  for (let y = region.top; y < region.bottom; y++) {
    for (let x = region.left; x < region.right; x++) {
      characterMask[y * width + x] = 1;
    }
  }

  // Exact measured character core.
  for (let y = region.coreTop; y < region.coreBottom; y++) {
    for (let x = region.coreLeft; x < region.coreRight; x++) {
      characterCoreMask[y * width + x] = 1;
    }
  }
}


// Recover faint character-edge pixels after the
// character mask has been completely populated.
const characterEdgeMask = dilateMask(
  characterMask,
  width,
  height,
  searchBounds,
  2
);

  // -----------------------------------------------------
  // 4. Combine the masks
  // -----------------------------------------------------

  const mask = new Uint8Array(size);

  let detectedCount = 0;
  let recoveredEdgeCount = 0;
  let characterGuidedCount = 0;

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const index = y * width + x;

      const isStrong =
        strongMask[index] === 1;

      const isWeakCandidate =
        weakMask[index] === 1;

      const nearStrongText =
        strongNeighborhood[index] === 1;

      const insideCharacter =
        characterMask[index] === 1;

      const insideCharacterCore =
  characterCoreMask[index] === 1;
 

  const insideCharacterEdge =
  characterEdgeMask[index] === 1;
const pixelDifference = distanceMap[index];

let selected = false;
if (isStrong) {
  selected = true;
} else if (
  isWeakCandidate &&
  nearStrongText &&
  insideCharacterEdge
) {
  selected = true;
  recoveredEdgeCount++;
  characterGuidedCount++;
} else if (
  insideCharacter &&
  pixelDifference >= CHARACTER_CORE_THRESHOLD
) {
  selected = true;
  characterGuidedCount++;
}

      if (selected) {
        mask[index] = 1;
        detectedCount++;
      }
    }
  }

return {
  mask,

  detectedCount,
  strongCount,

  recoveredEdgeCount,
  characterGuidedCount,

  characterRegionCount: characterRegions.length,

  // Temporary diagnostic data.
  distanceMap,
  strongMask,
  weakMask,
  characterMask,

  bounds: {
    left,
    top,
    right,
    bottom,
  },
};
}


/* =========================================================
   TEMPORARY REPAIR MASK COVERAGE DIAGNOSTICS
   ========================================================= */

function diagnoseRepairMask({
  detected,
  expandedMask,
  width,
  height,
}) {
  const counts = {
    totalPixels: 0,

    selectedPixels: 0,
    unselectedPixels: 0,

    unselectedStrongPixels: 0,
    unselectedWeakPixels: 0,

    characterRegionPixels: 0,
    selectedInsideCharacter: 0,
    unselectedInsideCharacter: 0,

    insideCharacter: {
      below1: 0,
      from1To3_5: 0,
      from3_5To6: 0,
      from6To18: 0,
      above18: 0,
    },

    outsideCharacter: {
      below1: 0,
      from1To3_5: 0,
      from3_5To6: 0,
      from6To18: 0,
      above18: 0,
    },
  };

  const bounds = detected.bounds;

  for (let y = bounds.top; y < bounds.bottom; y++) {
    for (let x = bounds.left; x < bounds.right; x++) {
      const index = y * width + x;

      const selected = expandedMask[index] === 1;
      const insideCharacter =
        detected.characterMask[index] === 1;

      const strong = detected.strongMask[index] === 1;
      const weak = detected.weakMask[index] === 1;

      const difference = detected.distanceMap[index];

      counts.totalPixels++;

      if (insideCharacter) {
        counts.characterRegionPixels++;
      }

      if (selected) {
        counts.selectedPixels++;

        if (insideCharacter) {
          counts.selectedInsideCharacter++;
        }

        continue;
      }

      counts.unselectedPixels++;

      if (strong) {
        counts.unselectedStrongPixels++;
      }

      if (weak) {
        counts.unselectedWeakPixels++;
      }

      const group = insideCharacter
        ? counts.insideCharacter
        : counts.outsideCharacter;

      if (insideCharacter) {
        counts.unselectedInsideCharacter++;
      }

      if (difference < 1) {
        group.below1++;
      } else if (difference < 3.5) {
        group.from1To3_5++;
      } else if (difference < 6) {
        group.from3_5To6++;
      } else if (difference < 18) {
        group.from6To18++;
      } else {
        group.above18++;
      }
    }
  }

  counts.maskCoveragePercent = Number(
    (
      counts.selectedPixels /
      Math.max(1, counts.totalPixels) *
      100
    ).toFixed(2)
  );

  console.group(
    "[Repair Diagnostics] MASK COVERAGE"
  );

  console.table({
    totalPixels: counts.totalPixels,
    selectedPixels: counts.selectedPixels,
    unselectedPixels: counts.unselectedPixels,
    maskCoveragePercent: counts.maskCoveragePercent,
    unselectedStrongPixels: counts.unselectedStrongPixels,
    unselectedWeakPixels: counts.unselectedWeakPixels,
    characterRegionPixels: counts.characterRegionPixels,
    selectedInsideCharacter: counts.selectedInsideCharacter,
    unselectedInsideCharacter: counts.unselectedInsideCharacter,
  });

  console.log(
    "Unselected pixels INSIDE character regions:",
    counts.insideCharacter
  );

  console.log(
    "Unselected pixels OUTSIDE character regions:",
    counts.outsideCharacter
  );


  
  console.groupEnd();

  return counts;
}


/* =========================================================
   PRESERVE OBVIOUS LINES
   ========================================================= */

/**
 * Identify very long horizontal strokes that may be table borders,
 * rules, or underlines.
 *
 * This conservative heuristic helps retain certain lines crossing
 * through a text box. It does not identify every vector or border.
 */
function detectHorizontalLines(mask, bounds, width) {
  const protectedRows = new Uint8Array(
    mask.length / width
  );

  const targetWidth = bounds.right - bounds.left;

  if (targetWidth < 20) {
    return protectedRows;
  }

  const minimumRun = Math.floor(
    targetWidth * 0.72
  );

  for (let y = bounds.top; y < bounds.bottom; y++) {
    let longestRun = 0;
    let currentRun = 0;

    for (let x = bounds.left; x < bounds.right; x++) {
      const isMarked = mask[y * width + x] === 1;

      if (isMarked) {
        currentRun++;
        longestRun = Math.max(longestRun, currentRun);
      } else {
        currentRun = 0;
      }
    }

    if (longestRun >= minimumRun) {
      protectedRows[y] = 1;
    }
  }

  return protectedRows;
}

/**
 * Identify very long vertical strokes such as table separators.
 */
function detectVerticalLines(
  mask,
  bounds,
  width,
  height
) {
  const protectedColumns = new Uint8Array(width);

  const targetHeight = bounds.bottom - bounds.top;

  if (targetHeight < 12) {
    return protectedColumns;
  }

  const minimumRun = Math.floor(
    targetHeight * 0.72
  );

  for (let x = bounds.left; x < bounds.right; x++) {
    let longestRun = 0;
    let currentRun = 0;

    for (let y = bounds.top; y < bounds.bottom; y++) {
      const isMarked = mask[y * width + x] === 1;

      if (isMarked) {
        currentRun++;
        longestRun = Math.max(longestRun, currentRun);
      } else {
        currentRun = 0;
      }
    }

    if (longestRun >= minimumRun) {
      protectedColumns[x] = 1;
    }
  }

  return protectedColumns;
}


/* =========================================================
   MASK DILATION
   ========================================================= */

/**
 * Expand the mask slightly to include antialiased glyph edges.
 *
 * Pixels outside the selected OCR bounds are never added.
 */
function dilateMask(mask, width, height, bounds, radius = 1) {
  const result = mask.slice();

  for (let y = bounds.top; y < bounds.bottom; y++) {
    for (let x = bounds.left; x < bounds.right; x++) {
      if (mask[y * width + x] !== 1) {
        continue;
      }

      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;

          if (
            nx < bounds.left ||
            nx >= bounds.right ||
            ny < bounds.top ||
            ny >= bounds.bottom ||
            nx < 0 ||
            nx >= width ||
            ny < 0 ||
            ny >= height
          ) {
            continue;
          }

          result[ny * width + nx] = 1;
        }
      }
    }
  }

  return result;
}


/* =========================================================
   BUILD A TRANSPARENT REPAIR PATCH
   ========================================================= */


/* =========================================================
   BUILD TRANSPARENT TELEA REPAIR PATCH
   ========================================================= */

function buildInpaintRepairCanvas({
  inpaintedRGB,
  mask,
  width,
  height,
  detectedBounds,
}) {
  const pixelCount = width * height;

  if (
    !inpaintedRGB ||
    inpaintedRGB.length !== pixelCount * 3 ||
    !mask ||
    mask.length !== pixelCount
  ) {
    throw new Error(
      "Invalid Telea reconstruction or repair mask."
    );
  }

  const outputCanvas = document.createElement("canvas");

  outputCanvas.width = width;
  outputCanvas.height = height;

  const context = outputCanvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!context) {
    throw new Error(
      "Could not create the Telea repair canvas."
    );
  }

  const outputImageData = context.createImageData(
    width,
    height
  );

  const target = detectedBounds;

  let repairedPixelCount = 0;

  for (let y = target.top; y < target.bottom; y++) {
    for (let x = target.left; x < target.right; x++) {
      const index = y * width + x;

      // Keep pixels outside the repair mask transparent.
      if (mask[index] === 0) {
        continue;
      }

      const rgbOffset = index * 3;
      const outputOffset = index * 4;

      outputImageData.data[outputOffset] =
        inpaintedRGB[rgbOffset];

      outputImageData.data[outputOffset + 1] =
        inpaintedRGB[rgbOffset + 1];

      outputImageData.data[outputOffset + 2] =
        inpaintedRGB[rgbOffset + 2];

      outputImageData.data[outputOffset + 3] = 255;

      repairedPixelCount++;
    }
  }

  if (repairedPixelCount === 0) {
    throw new Error(
      "The Telea repair mask contains no selected pixels."
    );
  }

  context.putImageData(outputImageData, 0, 0);

  return {
    canvas: outputCanvas,
    repairedPixelCount,
  };
}



function showRepairDebugOverlay({
  sourceCanvas,
  repairCanvas,
  mask,
  width,
  height,
  text,
}) {
  const workspace = document.getElementById(
    "paddle-editor-workspace"
  );

  if (!workspace) return;

  // -----------------------------------------------
  // IMAGE 1: Original crop with selected mask pixels
  // highlighted in magenta.
  // -----------------------------------------------

  const maskCanvas = document.createElement("canvas");

  maskCanvas.width = width;
  maskCanvas.height = height;

  const maskContext = maskCanvas.getContext("2d");

  maskContext.drawImage(sourceCanvas, 0, 0);

  const imageData = maskContext.getImageData(
    0, 0, width, height
  );

  let selectedPixels = 0;

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) continue;

    selectedPixels++;

    const offset = i * 4;

    // Magenta overlay, blended with original pixels.
    imageData.data[offset] =
      imageData.data[offset] * 0.35 + 255 * 0.65;

    imageData.data[offset + 1] *= 0.35;

    imageData.data[offset + 2] =
      imageData.data[offset + 2] * 0.35 + 255 * 0.65;
  }

  maskContext.putImageData(imageData, 0, 0);

  // -----------------------------------------------
  // IMAGE 2: Simulated repaired image.
  // -----------------------------------------------

  const resultCanvas = document.createElement("canvas");

  resultCanvas.width = width;
  resultCanvas.height = height;

  const resultContext = resultCanvas.getContext("2d");

  resultContext.drawImage(sourceCanvas, 0, 0);

  // Composite actual transparent repair patch.
  resultContext.drawImage(repairCanvas, 0, 0);

  // -----------------------------------------------
  // CREATE DEBUG PANEL
  // -----------------------------------------------

  let panel = document.getElementById(
    "paddle-repair-debug-panel"
  );

  if (!panel) {
    panel = document.createElement("section");
    panel.id = "paddle-repair-debug-panel";

    panel.style.cssText = `
      margin: 18px 0;
      padding: 14px;
      background: #ffffff;
      color: #222;
      border: 2px solid #e000ff;
      border-radius: 8px;
      font-family: Arial, sans-serif;
    `;

    workspace.insertAdjacentElement("afterend", panel);
  }

  panel.replaceChildren();

  const heading = document.createElement("h3");

  heading.textContent =
    "Background Repair Diagnostic: " + text;

  panel.appendChild(heading);

  const info = document.createElement("p");

  info.textContent =
    `Selected mask pixels: ${selectedPixels}`;

  panel.appendChild(info);

  const grid = document.createElement("div");

  grid.style.cssText = `
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  `;

  const images = [
    {
      label: "Original + MAGENTA repair mask",
      canvas: maskCanvas,
    },
    {
      label: "Simulated repaired background",
      canvas: resultCanvas,
    },
  ];

  for (const item of images) {
    const card = document.createElement("div");

    const label = document.createElement("strong");
    label.textContent = item.label;

    const image = document.createElement("img");

    image.src = item.canvas.toDataURL("image/png");

    image.style.cssText = `
      display: block;
      width: 100%;
      height: auto;
      margin-top: 8px;
      border: 1px solid #aaa;
      image-rendering: auto;
    `;

    card.append(label, image);
    grid.appendChild(card);
  }

  panel.appendChild(grid);

  console.log(
    "[Repair Debug] Selected pixels:",
    selectedPixels
  );
}

/* =========================================================
   CREATE AND STORE A REPAIR PATCH
   ========================================================= */
/* =========================================================
   PROTECT CHARACTERS FROM NEIGHBORING OCR LINES
   ========================================================= */

function getCharacterInkBounds(character) {
  const bounds =
    character?.inkBounds ||
    character?.bounds ||
    null;

  if (bounds) {
    const x = Number(bounds.x ?? bounds.left);
    const y = Number(bounds.y ?? bounds.top);

    const width = Number(
      bounds.width ?? (Number(bounds.right) - x)
    );

    const height = Number(
      bounds.height ?? (Number(bounds.bottom) - y)
    );

    if (
      [x, y, width, height].every(Number.isFinite) &&
      width > 0 &&
      height > 0
    ) {
      return { x, y, width, height };
    }
  }

  // Fallback: calculate bounds from the character polygon.
  const polygon = character?.polygon;

  if (!Array.isArray(polygon)) {
    return null;
  }

  let points = [];

  if (
    polygon.length > 0 &&
    typeof polygon[0] === "number"
  ) {
    for (let i = 0; i + 1 < polygon.length; i += 2) {
      points.push([
        Number(polygon[i]),
        Number(polygon[i + 1]),
      ]);
    }
  } else {
    points = polygon.map((point) => {
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
    });
  }

  points = points.filter(
    ([x, y]) =>
      Number.isFinite(x) &&
      Number.isFinite(y)
  );

  if (points.length < 3) {
    return null;
  }

  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);

  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}


function buildNeighborCharacterProtectionMask({
  page,
  selectedTextBlockId,
  actualRegion,
  scaleX,
  scaleY,
  width,
  height,
  padding = 1,
}) {
  const protectionMask = new Uint8Array(
    width * height
  );

  const textBlocks = Array.isArray(page?.textBlocks)
    ? page.textBlocks
    : [];

// Identify neighboring text blocks that already have
// a successfully stored background-repair patch.
const repairedBlockIds = new Set(
  (
    Array.isArray(page?.repairPatches)
      ? page.repairPatches
      : []
  )
    .map((patch) => patch?.textBlockId)
    .filter(Boolean)
);

let skippedAlreadyRepairedBlocks = 0;

  let neighboringBlocks = 0;
  let protectedCharacters = 0;
  let protectedPixels = 0;

 for (const block of textBlocks) {
  if (
    !block?.id ||
    block.id === selectedTextBlockId
  ) {
    continue;
  }

  // Do not protect a neighboring line if its original
  // lettering has already been repaired.
  if (repairedBlockIds.has(block.id)) {
    skippedAlreadyRepairedBlocks++;
    continue;
  }

    const measurements = block.characterMeasurements;

    const characters = Array.isArray(measurements)
      ? measurements
      : measurements?.characters;

    if (!Array.isArray(characters) || !characters.length) {
      continue;
    }

    neighboringBlocks++;

    for (const character of characters) {
      const inkBounds = getCharacterInkBounds(
        character
      );

      if (!inkBounds) {
        continue;
      }

      // Convert page coordinates into crop coordinates.
      const left = Math.max(
        0,
        Math.floor(
          (inkBounds.x - actualRegion.x) * scaleX
        ) - padding
      );

      const top = Math.max(
        0,
        Math.floor(
          (inkBounds.y - actualRegion.y) * scaleY
        ) - padding
      );

      const right = Math.min(
        width,
        Math.ceil(
          (
            inkBounds.x +
            inkBounds.width -
            actualRegion.x
          ) * scaleX
        ) + padding
      );

      const bottom = Math.min(
        height,
        Math.ceil(
          (
            inkBounds.y +
            inkBounds.height -
            actualRegion.y
          ) * scaleY
        ) + padding
      );

      if (right <= left || bottom <= top) {
        continue;
      }

      protectedCharacters++;

      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const index = y * width + x;

          if (protectionMask[index] === 0) {
            protectedPixels++;
          }

          protectionMask[index] = 1;
        }
      }
    }
  }

 return {
  mask: protectionMask,
  neighboringBlocks,
  protectedCharacters,
  protectedPixels,
  skippedAlreadyRepairedBlocks,
};
}
/**
 * Repair a specific OCR-generated text block.
 *
 * Example:
 *
 * const patch = await repairTextBlock({
 *   page,
 *   renderedPage,
 *   textBlockId: selectedBlock.id,
 * });
 *
 * The patch is stored in page.repairPatches.
 *
 * It remains separate from the original image and the editable
 * text model, making independent editing and future export possible.
 */
export async function repairTextBlock({
  page,
  renderedPage,
  textBlockId,
  paddingRatio = DEFAULT_PADDING_RATIO,
  contrastThreshold = DEFAULT_CONTRAST_THRESHOLD,
} = {}) {
  requireRenderedPage(renderedPage);

  const { width: pageWidth, height: pageHeight } =
    requirePage(page);

  const registeredPage = getPageById(page.id);

  if (!registeredPage) {
    throw new Error(
      `Page ${page.id} is not registered in the application state.`
    );
  }

  const textBlock = getPageObject(
    registeredPage.id,
    "text",
    textBlockId
  );

  if (!textBlock) {
    throw new Error(
      `Text block ${textBlockId} was not found.`
    );
  }

  const textBounds = getTextBounds(textBlock);

  const threshold = Number(contrastThreshold);

  if (
    !Number.isFinite(threshold) ||
    threshold < 1 ||
    threshold > 255
  ) {
    throw new RangeError(
      "Contrast threshold must be between 1 and 255."
    );
  }

  const raster = getPageRaster(
    renderedPage,
    pageWidth,
    pageHeight
  );

  /*
   * Step 1: sample the local background surrounding the text.
   */
  const paddedRegion = makePaddedRegion(
    textBounds,
    pageWidth,
    pageHeight,
    Math.max(0.05, Number(paddingRatio) || DEFAULT_PADDING_RATIO)
  );

  /*
   * Step 2: extract the sampled region and composite any previous repair patches.
   */
 const extracted = await extractRegion(
  raster,
  paddedRegion,
  registeredPage.repairPatches || []
);

console.log(
  "[Repair Input] Previous patches composited:",
  extracted.compositedRepairCount
);

  const {
    canvas: sampledCanvas,
    imageData,
    width,
    height,
    actualRegion,
  } = extracted;

  /*
   * Convert the OCR rectangle into sampled-canvas pixels.
   */
  const regionScaleX = width / actualRegion.width;
  const regionScaleY = height / actualRegion.height;

  const target = {
    left: clamp(
      Math.floor(
        (textBounds.x - actualRegion.x) * regionScaleX
      ),
      0,
      width
    ),

    top: clamp(
      Math.floor(
        (textBounds.y - actualRegion.y) * regionScaleY
      ),
      0,
      height
    ),

    right: clamp(
      Math.ceil(
        (textBounds.x + textBounds.width - actualRegion.x) *
        regionScaleX
      ),
      0,
      width
    ),

    bottom: clamp(
      Math.ceil(
        (textBounds.y + textBounds.height - actualRegion.y) *
        regionScaleY
      ),
      0,
      height
    ),
  };

  if (
    target.right <= target.left ||
    target.bottom <= target.top
  ) {
    throw new Error(
      "The OCR text rectangle is outside the sampled repair area."
    );
  }

// Build repair guides from actual OpenCV character measurements.
const characterRegions = getCharacterRepairRegions({
  textBlock,
  actualRegion,
  regionScaleX,
  regionScaleY,
  width,
  height,
});

// Extend the detection area if measured glyphs extend
// slightly beyond the PaddleOCR line rectangle.
for (const region of characterRegions) {
  target.left = Math.min(target.left, region.left);
  target.top = Math.min(target.top, region.top);

  target.right = Math.max(target.right, region.right);
  target.bottom = Math.max(target.bottom, region.bottom);
}

  /*
   * Step 3: estimate the background for the sample region.
   */
  const background = estimateBackground(
    imageData,
    target
  );

  /*
   * Step 4: detect pixels that differ from the estimated background.
   */
const detected = detectTextMask(
  imageData,
  background,
  target,
  threshold,
  characterRegions
);

console.log(
  "[Character-Guided Background Repair]",
  {
    text: textBlock.text,

    strongPixels: detected.strongCount,

    recoveredAntialiasedPixels:
      detected.recoveredEdgeCount,

    characterGuidedPixels:
      detected.characterGuidedCount,

    characterRegions:
      detected.characterRegionCount,

    totalDetectedPixels:
      detected.detectedCount,

      characterCoreThreshold: CHARACTER_CORE_THRESHOLD,
  }
);

  if (detected.detectedCount === 0) {
    throw new Error(
      "No text pixels were detected. The region may have " +
      "insufficient contrast or an unsuitable background."
    );
  }


/*
 * Step 5: Expand the existing character-guided mask.
 */
const expandedMask = dilateMask(
  detected.mask,
  width,
  height,
  detected.bounds,
  MASK_DILATION_RADIUS
);

/* =========================================================
   PROTECT NEIGHBORING OCR CHARACTERS
   ========================================================= */

const neighborProtection =
  buildNeighborCharacterProtectionMask({
    page: registeredPage,
    selectedTextBlockId: textBlock.id,

    actualRegion,

    scaleX: regionScaleX,
    scaleY: regionScaleY,

    width,
    height,

    // Keep this small because inkBounds are already measured.
    padding: 1,
  });

/* =========================================================
   SEPARATE TELEA MASK FROM VISIBLE REPAIR MASK
   ========================================================= */

// Mask used for the final transparent repair patch.
// It must contain only pixels belonging to the selected line.
const repairOutputMask = expandedMask.slice();

// Mask sent to OpenCV Telea.
// It also hides neighboring characters temporarily so that
// their ink cannot contaminate the reconstruction.
const teleaMask = expandedMask.slice();

let protectedSelectedPixels = 0;
let neighborPixelsAddedToTelea = 0;

for (let i = 0; i < expandedMask.length; i++) {
  if (neighborProtection.mask[i] !== 1) {
    continue;
  }

  // Add neighboring character pixels to the temporary
  // Telea inpainting mask.
  if (teleaMask[i] !== 1) {
    neighborPixelsAddedToTelea++;
  }

  teleaMask[i] = 1;

  // But never make those neighboring characters opaque
  // in the final repair patch.
  if (repairOutputMask[i] === 1) {
    repairOutputMask[i] = 0;
    protectedSelectedPixels++;
  }
}

console.log(
  "[Separate Repair Masks]",
  {
    selectedLineMaskPixels:
      repairOutputMask.reduce((sum, value) => sum + value, 0),

    teleaMaskPixels:
      teleaMask.reduce((sum, value) => sum + value, 0),

    neighborPixelsAddedToTelea,

    protectedSelectedPixels,
  }
);

console.log(
  "[Neighbor Character Protection]",
  {
    selectedTextBlockId: textBlock.id,

    neighboringBlocks:
      neighborProtection.neighboringBlocks,

    protectedCharacters:
      neighborProtection.protectedCharacters,

    protectedPixels:
      neighborProtection.protectedPixels,

skippedAlreadyRepairedBlocks:
  neighborProtection.skippedAlreadyRepairedBlocks,

    protectedSelectedPixels,
  }
);

const maskDiagnostics = diagnoseRepairMask({
  detected,
 expandedMask: repairOutputMask,
  width,
  height,
});


const characterMaskPixels =
  maskDiagnostics.characterRegionPixels;

const selectedInside =
  maskDiagnostics.selectedInsideCharacter;

console.log(
  "[Repair Diagnostics] CHARACTER MASK PRECISION",
  {
    characterMaskPixels,
    selectedInside,

    selectedPercentage: Number(
      (
        selectedInside /
        Math.max(1, characterMaskPixels) *
        100
      ).toFixed(2)
    ),

    selectedOutsideCharacter:
      maskDiagnostics.selectedPixels - selectedInside,

    overallMaskCoverage:
      maskDiagnostics.maskCoveragePercent,
  }
);

/*
 * Step 7: Run Telea inpainting.
 *
 * IMPORTANT:
 * Declare inpaintResult in this function scope.
 */
const inpaintResult = await inpaintWithOpenCVWorker({
  width,
  height,
  rgbaData: imageData.data,
  maskData: teleaMask,
  radius: DEFAULT_INPAINT_RADIUS,
});

/*
 * Step 8: Compare original pixels with Telea output.
 */
let changedPixels = 0;
let nearlyUnchangedPixels = 0;
let totalColorDifference = 0;

for (let i = 0; i < width * height; i++) {
  if (expandedMask[i] !== 1) continue;

  const sourceOffset = i * 4;
  const outputOffset = i * 3;

  const difference =
    Math.abs(
      imageData.data[sourceOffset] -
      inpaintResult.rgb[outputOffset]
    ) +
    Math.abs(
      imageData.data[sourceOffset + 1] -
      inpaintResult.rgb[outputOffset + 1]
    ) +
    Math.abs(
      imageData.data[sourceOffset + 2] -
      inpaintResult.rgb[outputOffset + 2]
    );

  const averageDifference = difference / 3;

  totalColorDifference += averageDifference;

  if (averageDifference > 2) {
    changedPixels++;
  } else {
    nearlyUnchangedPixels++;
  }
}

console.group("[Repair Diagnostics] TELEA OUTPUT");

console.table({
  selectedPixels: inpaintResult.selectedPixels,
  changedPixels,
  nearlyUnchangedPixels,

  averageColorDifference: Number(
    (
      totalColorDifference /
      Math.max(1, inpaintResult.selectedPixels)
    ).toFixed(2)
  ),

  method: inpaintResult.method,
  radius: inpaintResult.radius,
});

console.log("Mask diagnostics:", maskDiagnostics);

console.groupEnd();

/*
 * Step 9: Build the transparent repair patch.
 *
 * This must happen after inpaintResult is available.
 */
const repairResult = buildInpaintRepairCanvas({
  inpaintedRGB: inpaintResult.rgb,
 mask: repairOutputMask,
  width,
  height,
  detectedBounds: detected.bounds,
});

/*
 * Step 10: Display repair diagnostics.
 */
showRepairDebugOverlay({
  sourceCanvas: sampledCanvas,
  repairCanvas: repairResult.canvas,
 mask: repairOutputMask,
  width,
  height,
  text: textBlock.originalText || textBlock.text || "",
});



  /*
   * Step 8: serialize the patch separately from the text object.
   */
  const dataUrl = repairResult.canvas.toDataURL("image/png");

  /*
   * Step 9: store the patch in page coordinates.
   */
  const patch = {
    id: createId("repair"),
    type: "repair",

    textBlockId: textBlock.id,

    x: actualRegion.x,
    y: actualRegion.y,
    width: actualRegion.width,
    height: actualRegion.height,

    bounds: {
      x: actualRegion.x,
      y: actualRegion.y,
      width: actualRegion.width,
      height: actualRegion.height,
    },

    dataUrl,

  method: "opencv-inpaint-telea",

inpaintRadius: inpaintResult.radius,

maskPixelCount: inpaintResult.selectedPixels,

    repairedPixelCount: repairResult.repairedPixelCount,

    createdAt: new Date().toISOString(),
  };

  addPageObject(
    registeredPage.id,
    "repair",
    patch
  );

  /*
   * Step 10: display the patch under editable OCR text.
   */
  renderRepairPatches({
    page: registeredPage,
    renderedPage,
  });

  setStatusMessage(
    `Background repair created for "${textBlock.text}".`
  );

  return patch;
}


/* =========================================================
   RENDER STORED PATCHES
   ========================================================= */

/**
 * Render all stored repair patches into the page object layer.
 *
 * Existing image objects are preserved; only repair patch DOM
 * elements are recreated.
 */
export function renderRepairPatches({
  page,
  renderedPage,
} = {}) {
  requireRenderedPage(renderedPage);

  const registeredPage = getPageById(page?.id);

  if (!registeredPage) {
    throw new Error(
      "Cannot render repairs for an unregistered page."
    );
  }

// TEMP: Diagnose repair patch persistence.
const modelPatches = Array.isArray(
  registeredPage.repairPatches
)
  ? registeredPage.repairPatches
  : [];

const existingPatchElements = [
  ...renderedPage.objectLayer.querySelectorAll(
    ".repair-patch"
  ),
];

console.group(
  "[Repair Patch Persistence]"
);

console.log("Page ID:", registeredPage.id);

console.log(
  "MODEL PATCH COUNT:",
  modelPatches.length
);

console.table(
  modelPatches.map((patch) => ({
    id: patch.id,
    textBlockId: patch.textBlockId,
    x: patch.x,
    y: patch.y,
    width: patch.width,
    height: patch.height,
    hasDataUrl: Boolean(patch.dataUrl),
    method: patch.method,
  }))
);

console.log(
  "EXISTING DOM PATCHES:",
  existingPatchElements.map((element) => ({
    id: element.dataset.objectId,
    textBlockId: element.dataset.textBlockId,
  }))
);

console.groupEnd();

  const sourceWidth = Number(
    renderedPage.sourceWidth ||
    registeredPage.sourceWidth ||
    registeredPage.width
  );

  const sourceHeight = Number(
    renderedPage.sourceHeight ||
    registeredPage.sourceHeight ||
    registeredPage.height
  );

  if (
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    throw new Error(
      "Invalid page dimensions for repair rendering."
    );
  }

  const displayWidth = renderedPage.pageElement.clientWidth;
  const displayHeight = renderedPage.pageElement.clientHeight;

  const scaleX = displayWidth / sourceWidth;
  const scaleY = displayHeight / sourceHeight;

  renderedPage.objectLayer
    .querySelectorAll(".repair-patch")
    .forEach((element) => element.remove());

  for (const patch of registeredPage.repairPatches) {
    if (!patch.dataUrl) {
      continue;
    }

    const image = document.createElement("img");

    image.className = "repair-patch";
    image.dataset.objectId = patch.id;
    image.dataset.textBlockId = patch.textBlockId || "";

    image.alt = "";
    image.draggable = false;

    image.src = patch.dataUrl;

    image.style.left = `${patch.x * scaleX}px`;
    image.style.top = `${patch.y * scaleY}px`;

    image.style.width = `${patch.width * scaleX}px`;
    image.style.height = `${patch.height * scaleY}px`;

    image.style.objectFit = "fill";
    image.style.position = "absolute";
    image.style.pointerEvents = "none";

    /*
     * Repair patches must be beneath inserted images and text.
     * Text is on a separate, higher layer.
     */
    image.style.zIndex = "1";

    renderedPage.objectLayer.appendChild(image);
  }

const finalPatchElements = [
  ...renderedPage.objectLayer.querySelectorAll(
    ".repair-patch"
  ),
];

console.log(
  "[Repair Patch Persistence] DOM AFTER RENDER:",
  finalPatchElements.map((element) => ({
    id: element.dataset.objectId,
    textBlockId: element.dataset.textBlockId,
  }))
);

return finalPatchElements;
}


/* =========================================================
   REMOVE A REPAIR PATCH
   ========================================================= */

/**
 * Remove one repair from the page model and update the page view.
 */
export function removeRepairPatch({
  page,
  renderedPage,
  patchId,
} = {}) {
  const registeredPage = getPageById(page?.id);

  if (!registeredPage) {
    return false;
  }

  const removed = removePageObject(
    registeredPage.id,
    "repair",
    patchId
  );

  if (!removed) {
    return false;
  }

  renderRepairPatches({
    page: registeredPage,
    renderedPage,
  });

  setStatusMessage("Background repair removed.");

  return true;
}
