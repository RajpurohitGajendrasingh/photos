/*
 * public/workers/original-glyph-shape-extractor.js
 *
 * Classic-worker helper. Loaded by opencv-ink.worker.js with importScripts().
 * It deliberately does not initialize OpenCV; it reuses the worker's cvRuntime.
 *
 * Input masks are the already-selected adaptive-threshold mask from
 * measureCharactersFromLine(). This module does not alter OCR measurements,
 * component ownership, font ranking, or background repair.
 */
(function installOriginalGlyphShapeExtractor(scope) {
  "use strict";

  function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
  }

  function buildPixelCellSvgPath(mask, width, height) {
    // Exact vector representation of the binary mask. Each horizontal run
    // becomes a one-pixel-high rectangle; this preserves every mask pixel.
    const parts = [];

    for (let y = 0; y < height; y++) {
      let x = 0;

      while (x < width) {
        while (x < width && mask[y * width + x] === 0) x++;
        if (x >= width) break;

        const start = x;
        while (x < width && mask[y * width + x] !== 0) x++;

        const runWidth = x - start;
        parts.push(`M${start} ${y}h${runWidth}v1h-${runWidth}Z`);
      }
    }

    return parts.join("");
  }

  function buildPixelBoundaryContourPath(mask, width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !mask ||
    mask.length !== width * height
  ) {
    throw new Error("Invalid mask supplied for pixel-boundary tracing.");
  }

  const edges = [];
  const outgoing = new Map();

  /*
   * Direction:
   * 0 = right
   * 1 = down
   * 2 = left
   * 3 = up
   *
   * Every edge is directed clockwise around a foreground
   * pixel, keeping foreground on its right-hand side.
   */

  function addEdge(x1, y1, x2, y2, direction) {
    const edge = {
      x1,
      y1,
      x2,
      y2,
      direction,
      used: false,
    };

    edges.push(edge);

    const key = `${x1},${y1}`;

    if (!outgoing.has(key)) {
      outgoing.set(key, []);
    }

    outgoing.get(key).push(edge);
  }

  function isInk(x, y) {
    if (
      x < 0 ||
      y < 0 ||
      x >= width ||
      y >= height
    ) {
      return false;
    }

    return mask[y * width + x] !== 0;
  }

  /*
   * STEP 1: Generate only exposed pixel-cell edges.
   *
   * Shared edges between two foreground pixels are omitted.
   * Therefore, adjacent pixels form continuous boundaries.
   */

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isInk(x, y)) {
        continue;
      }

      // Top edge.
      if (!isInk(x, y - 1)) {
        addEdge(x, y, x + 1, y, 0);
      }

      // Right edge.
      if (!isInk(x + 1, y)) {
        addEdge(x + 1, y, x + 1, y + 1, 1);
      }

      // Bottom edge.
      if (!isInk(x, y + 1)) {
        addEdge(x + 1, y + 1, x, y + 1, 2);
      }

      // Left edge.
      if (!isInk(x - 1, y)) {
        addEdge(x, y + 1, x, y, 3);
      }
    }
  }

  /*
   * STEP 2: Join directed edges into closed boundary loops.
   *
   * At diagonal pixel contacts, multiple outgoing edges can
   * share a vertex. Prefer a right turn to keep diagonally
   * touching foreground regions on their own boundaries.
   */

  function chooseNextEdge(current) {
    const key = `${current.x2},${current.y2}`;

    const candidates = outgoing.get(key) || [];

    let best = null;
    let bestRank = Infinity;

    for (const candidate of candidates) {
      if (candidate.used) {
        continue;
      }

      const turn =
        (candidate.direction - current.direction + 4) % 4;

      // Right turn, straight, left turn, reverse.
      const rank =
        turn === 1 ? 0 :
        turn === 0 ? 1 :
        turn === 3 ? 2 :
        3;

      if (rank < bestRank) {
        best = candidate;
        bestRank = rank;
      }
    }

    return best;
  }

  /*
   * STEP 3: Trace every unused edge.
   */

  const pathParts = [];

  let tracedEdgeCount = 0;
  let loopCount = 0;
  let incompleteLoopCount = 0;

  for (const firstEdge of edges) {
    if (firstEdge.used) {
      continue;
    }

    const startX = firstEdge.x1;
    const startY = firstEdge.y1;

    let current = firstEdge;
    let path = `M${startX} ${startY}`;

    let closed = false;
    let guard = 0;

    while (
      current &&
      !current.used &&
      guard <= edges.length
    ) {
      current.used = true;
      tracedEdgeCount++;

      path += `L${current.x2} ${current.y2}`;

      // The boundary returned to its starting vertex.
      if (
        current.x2 === startX &&
        current.y2 === startY
      ) {
        path += "Z";
        closed = true;
        break;
      }

      current = chooseNextEdge(current);

      guard++;
    }

    if (closed) {
      pathParts.push(path);
      loopCount++;
    } else {
      incompleteLoopCount++;
    }
  }

  return {
    path: pathParts.join(""),

    boundaryEdgeCount: edges.length,
    tracedEdgeCount,

    loopCount,
    incompleteLoopCount,

    untracedEdgeCount:
      edges.length - tracedEdgeCount,
  };
}

  function getContourDepth(hierarchy, contourIndex, contourCount) {
    let depth = 0;
    let parent = hierarchy[contourIndex * 4 + 3];
    let guard = 0;

    while (parent >= 0 && parent < contourCount && guard < contourCount) {
      depth++;
      parent = hierarchy[parent * 4 + 3];
      guard++;
    }

    return depth;
  }

  function extractContourData(maskMat, cv) {
    let contourInput = null;
    let contours = null;
    let hierarchy = null;

    try {
      // findContours modifies its input, so it must receive a clone.
      contourInput = maskMat.clone();
      contours = new cv.MatVector();
      hierarchy = new cv.Mat();

      cv.findContours(
        contourInput,
        contours,
        hierarchy,
        cv.RETR_TREE,
        cv.CHAIN_APPROX_NONE
      );

      const contourCount = contours.size();
      const hierarchyData = hierarchy.data32S || [];
      const pathParts = [];
      let pointCount = 0;
      let holeCount = 0;
      const contourRecords = [];

      for (let i = 0; i < contourCount; i++) {
        const contour = contours.get(i);
        try {
          const points = contour.data32S;
          const count = Math.floor((points?.length || 0) / 2);
          if (!count) continue;

          pointCount += count;
          const depth = getContourDepth(
            hierarchyData,
            i,
            contourCount
          );

          if (depth % 2 === 1) holeCount++;

          let d = `M${points[0]} ${points[1]}`;
          for (let p = 1; p < count; p++) {
            d += `L${points[p * 2]} ${points[p * 2 + 1]}`;
          }
          d += "Z";
          pathParts.push(d);

          contourRecords.push({
            index: i,
            pointCount: count,
            depth,
            isHole: depth % 2 === 1,
            parent: hierarchyData[i * 4 + 3] ?? -1,
          });
        } finally {
          if (contour && typeof contour.delete === "function") {
            contour.delete();
          }
        }
      }

      return {
        contourCount,
        pointCount,
        holeCount,
        contourRecords,
        contourSvgPath: pathParts.join(""),
      };
    } finally {
      for (const mat of [hierarchy, contours, contourInput]) {
        if (mat && typeof mat.delete === "function") mat.delete();
      }
    }
  }

// ----------------------------------------------------------
// DIAGNOSTIC: CAPTURE WIDER ORIGINAL GLYPH CONTEXT
// This does not modify the original mask or glyph extraction.
// ----------------------------------------------------------

function captureGlyphCellContext({
  rgbaMat,
  binaryMaskMat,
  cellLeft,
  cellRight,
  imageHeight,
  padding = 3,
}, cv) {
  let rgbaView = null;
  let maskView = null;
  let rgbaPacked = null;
  let maskPacked = null;

  try {
    const contextLeft = Math.max(0, cellLeft - padding);

    const contextRight = Math.min(
      rgbaMat.cols,
      cellRight + padding
    );

    const contextWidth = contextRight - contextLeft;

    if (contextWidth < 1) {
      throw new Error("Invalid diagnostic context width.");
    }

    const rect = new cv.Rect(
      contextLeft,
      0,
      contextWidth,
      imageHeight
    );

    // Capture the original RGBA pixels independently.
    rgbaView = rgbaMat.roi(rect);

    // Capture the existing selected adaptive mask.
    maskView = binaryMaskMat.roi(rect);

    // Pack both buffers to avoid ROI row-stride problems.
    rgbaPacked = rgbaView.clone();
    maskPacked = maskView.clone();

    const rgbaData = rgbaPacked.data;
    const maskData = maskPacked.data;

    if (
      rgbaData.length !== contextWidth * imageHeight * 4 ||
      maskData.length !== contextWidth * imageHeight
    ) {
      throw new Error("Invalid diagnostic context buffer dimensions.");
    }

    return {
      status: "captured",

      coordinateSpace: "paddle-final-rectified-crop",

      x: contextLeft,
      y: 0,

      width: contextWidth,
      height: imageHeight,

      cellBounds: {
        left: cellLeft - contextLeft,
        right: cellRight - contextLeft,
        width: cellRight - cellLeft,
      },

      paddingLeft: cellLeft - contextLeft,
      paddingRight: contextRight - cellRight,

      rgba: new Uint8ClampedArray(rgbaData),
      mask: new Uint8Array(maskData),

      maskSource: "existing-selected-adaptive-threshold-mask",
    };

  } catch (error) {
    return {
      status: "capture-error",
      message: error?.message || String(error),
    };

  } finally {
    for (const mat of [
      maskPacked,
      rgbaPacked,
      maskView,
      rgbaView,
    ]) {
      if (mat && typeof mat.delete === "function") {
        mat.delete();
      }
    }
  }
}


function analyzeGlyphMaskComponents(maskData, width, height) {
  if (!maskData || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error("Invalid glyph mask component analysis input.");
  }

  const totalPixels = width * height;

  if (maskData.length !== totalPixels) {
    throw new Error(
      `Glyph mask size mismatch: expected ${totalPixels}, received ${maskData.length}.`
    );
  }

  const labels = new Int32Array(totalPixels);
  const queue = new Int32Array(totalPixels);

  const components = [];
  let nextLabel = 0;

  // Discover all foreground components using 8-connectivity.
  for (let start = 0; start < totalPixels; start++) {
    if (maskData[start] === 0 || labels[start] !== 0) {
      continue;
    }

    const label = ++nextLabel;

    let head = 0;
    let tail = 0;

    queue[tail++] = start;
    labels[start] = label;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    while (head < tail) {
      const current = queue[head++];

      const x = current % width;
      const y = Math.floor(current / width);

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) {
            continue;
          }

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

          const neighbor = ny * width + nx;

          if (
            maskData[neighbor] !== 0 &&
            labels[neighbor] === 0
          ) {
            labels[neighbor] = label;
            queue[tail++] = neighbor;
          }
        }
      }
    }

    components.push({
      label,
      pixelCount: tail,
      firstPixelIndex: start,
      bounds: {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1
      }
    });
  }

  // Sort largest first. The original scan order breaks equal-size ties.
  components.sort((a, b) => {
    return (
      b.pixelCount - a.pixelCount ||
      a.firstPixelIndex - b.firstPixelIndex
    );
  });

  const sourcePixelCount = components.reduce(
    (sum, component) => sum + component.pixelCount,
    0
  );

  const largestComponent = components[0] || null;

  // Create a separate candidate mask containing only the largest component.
  const largestComponentMask = new Uint8Array(totalPixels);

  if (largestComponent) {
    for (let i = 0; i < totalPixels; i++) {
      if (labels[i] === largestComponent.label) {
        largestComponentMask[i] = 255;
      }
    }
  }

  const retainedPixelCount = largestComponent
    ? largestComponent.pixelCount
    : 0;

  return {
    status: "complete",
    method: "8-connected-components",

    width,
    height,
    connectivity: 8,

    componentCount: components.length,

    sourcePixelCount,
    retainedPixelCount,
    removedPixelCount: sourcePixelCount - retainedPixelCount,

    retainedRatio: sourcePixelCount > 0
      ? retainedPixelCount / sourcePixelCount
      : 0,

    largestComponentLabel: largestComponent?.label ?? null,
    largestComponent,

    components,

    // This is a candidate only. Never replace the original mask with it.
    largestComponentMask
  };
}

  /**
   * Extract one mask/image sample per non-space CTC character.
   *
   * Pixel ownership uses the pixel-centre convention already used by the
   * typography matcher: [ceil(left - .5), ceil(right - .5)).
   *
   * rgbaMat: rectified original crop (CV_8UC4)
   * binaryMaskMat: selected adaptive mask (CV_8UC1)
   * boundaries: fractional character boundaries in rectified crop coords
   */
  function extractCharacterGlyphShapes({
    rgbaMat,
    binaryMaskMat,
    characters,
    boundaries,
  } = {}, cv) {
    if (!cv?.Mat || !rgbaMat || !binaryMaskMat) {
      throw new Error("Original glyph extraction requires OpenCV matrices.");
    }

    if (
      rgbaMat.channels() !== 4 ||
      binaryMaskMat.channels() !== 1 ||
      rgbaMat.cols !== binaryMaskMat.cols ||
      rgbaMat.rows !== binaryMaskMat.rows
    ) {
      throw new Error("Original glyph extraction received incompatible image and mask matrices.");
    }

    if (
      !Array.isArray(characters) ||
      !Array.isArray(boundaries) ||
      boundaries.length !== characters.length + 1
    ) {
      throw new Error("Original glyph extraction received invalid CTC character boundaries.");
    }

    const imageWidth = binaryMaskMat.cols;
    const imageHeight = binaryMaskMat.rows;
    const glyphs = [];

    let totalMaskPixels = 0;
    let totalContours = 0;
    let totalContourPoints = 0;
    let totalHoles = 0;
    let totalPixelBoundaryLoops = 0;
let totalPixelBoundaryEdges = 0;
let incompletePixelBoundaryLoops = 0;
    let emptyGlyphCount = 0;
    let integrityFailures = 0;

    for (let i = 0; i < characters.length; i++) {
      const character = characters[i] || {};
      const text = String(character.text ?? "");

      const leftValue = Number(boundaries[i]);
      const rightValue = Number(boundaries[i + 1]);

      if (!isFiniteNumber(leftValue) || !isFiniteNumber(rightValue) || rightValue <= leftValue) {
        integrityFailures++;
        glyphs.push({
          index: i,
          text,
          status: "invalid-character-cell",
          cellBounds: { left: leftValue, right: rightValue },
        });
        continue;
      }

      if (/^\s+$/u.test(text)) {
        glyphs.push({
          index: i,
          text,
          status: "space",
          cellBounds: { left: leftValue, right: rightValue },
          width: 0,
          height: 0,
          pixelCount: 0,
          contourCount: 0,
          holeCount: 0,
        });
        continue;
      }

      // Keep exactly the columns whose pixel centres belong to this CTC cell.
      const cellLeft = Math.max(
        0,
        Math.min(imageWidth, Math.ceil(leftValue - 0.5))
      );
      const cellRight = Math.max(
        cellLeft,
        Math.min(imageWidth, Math.ceil(rightValue - 0.5))
      );
      const cellWidth = cellRight - cellLeft;

      if (cellWidth < 1) {
        emptyGlyphCount++;
        glyphs.push({
          index: i,
          text,
          status: "empty-cell",
          cellBounds: { left: leftValue, right: rightValue },
          pixelCount: 0,
          contourCount: 0,
          holeCount: 0,
        });
        continue;
      }

  let cellMask = null;
let cellMaskPacked = null;
let glyphMaskView = null;
      let glyphRgbaView = null;
      let glyphMask = null;
      let glyphRgba = null;
      let diagnosticContext = null; 

      try {
        // Diagnostic capture only for zero characters.
// Three pixels of horizontal context on both sides.

if (text === "0") {
  diagnosticContext = captureGlyphCellContext({
    rgbaMat,
    binaryMaskMat,
    cellLeft,
    cellRight,
    imageHeight,
    padding: 10,
  }, cv);
}
       cellMask = binaryMaskMat.roi(
  new cv.Rect(cellLeft, 0, cellWidth, imageHeight)
);

// Clone the ROI so its pixel data is independent of the
// original matrix's row stride and memory layout.
cellMaskPacked = cellMask.clone();

const cellData = cellMaskPacked.data;

if (
  !cellData ||
  cellData.length !== cellWidth * imageHeight
) {
  throw new Error(
    `Invalid packed cell mask data: expected ${cellWidth * imageHeight} bytes, received ${cellData?.length ?? 0}.`
  );
}

// Find the exact bounding rectangle by scanning nonzero pixels.
let minX = cellWidth;
let minY = imageHeight;
let maxX = -1;
let maxY = -1;
let cellPixelCount = 0;

for (let y = 0; y < imageHeight; y++) {
  const rowOffset = y * cellWidth;

  for (let x = 0; x < cellWidth; x++) {
    if (cellData[rowOffset + x] === 0) continue;

    cellPixelCount++;

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;

    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}

if (cellPixelCount === 0) {
  emptyGlyphCount++;

  glyphs.push({
    index: i,
    text,
    status: "no-visible-ink",
    cellBounds: { left: leftValue, right: rightValue },
    pixelCount: 0,
    contourCount: 0,
    holeCount: 0,
  });

  continue;
}

const bounds = new cv.Rect(
  minX,
  minY,
  maxX - minX + 1,
  maxY - minY + 1
);

if (diagnosticContext?.status === "captured") {
  diagnosticContext.tightMaskBounds = {
    x: diagnosticContext.cellBounds.left + bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

if (bounds.width < 1 || bounds.height < 1) {
  emptyGlyphCount++;

  glyphs.push({
    index: i,
    text,
    status: "invalid-ink-bounds",
    cellBounds: { left: leftValue, right: rightValue },
    pixelCount: 0,
    contourCount: 0,
    holeCount: 0,
  });

  continue;
}
        glyphMaskView = cellMask.roi(bounds);
        glyphRgbaView = rgbaMat.roi(
          new cv.Rect(
            cellLeft + bounds.x,
            bounds.y,
            bounds.width,
            bounds.height
          )
        );

        // Clone to get tightly packed buffers independent of ROI row strides.
        glyphMask = glyphMaskView.clone();
        
        glyphRgba = glyphRgbaView.clone();

const componentDiagnostics =
  text === "0"
    ? analyzeGlyphMaskComponents(
        glyphMask.data,
        glyphMask.cols,
        glyphMask.rows
      )
    : null;

        const width = glyphMask.cols;
        const height = glyphMask.rows;
        const mask = new Uint8Array(glyphMask.data);
        const rgba = new Uint8ClampedArray(glyphRgba.data);
    let pixelCount = 0;

for (let p = 0; p < mask.length; p++) {
  if (mask[p] !== 0) {
    pixelCount++;
  }
}

// Original OpenCV centre-coordinate contours.
const contourData = extractContourData(glyphMask, cv);

// Exact horizontal pixel-run SVG.
const pixelCellSvgPath = buildPixelCellSvgPath(
  mask,
  width,
  height
);

// Additional contours traced along actual pixel-cell boundaries.
const pixelBoundaryContourData =
  buildPixelBoundaryContourPath(
    mask,
    width,
    height
  );
       
        if (
          mask.length !== width * height ||
          rgba.length !== width * height * 4 ||
          pixelCount !== mask.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0)
        ) {
          integrityFailures++;
        }

        totalMaskPixels += pixelCount;
        totalContours += contourData.contourCount;
        totalContourPoints += contourData.pointCount;
        totalHoles += contourData.holeCount;
totalPixelBoundaryLoops +=
  pixelBoundaryContourData.loopCount;

totalPixelBoundaryEdges +=
  pixelBoundaryContourData.boundaryEdgeCount;

incompletePixelBoundaryLoops +=
  pixelBoundaryContourData.incompleteLoopCount;

        glyphs.push({
          index: i,
          text,
          status: "complete",
          width,
          height,
          pixelCount,
          contourCount: contourData.contourCount,
          contourPointCount: contourData.pointCount,
          holeCount: contourData.holeCount,
          cellBounds: {
            left: leftValue,
            right: rightValue,
            pixelLeft: cellLeft,
            pixelRightExclusive: cellRight,
            top: 0,
            bottomExclusive: imageHeight,
          },
          cropBounds: {
            x: cellLeft + bounds.x,
            y: bounds.y,
            width,
            height,
          },
          rgba,
          mask,
          componentDiagnostics,
          diagnosticContext,
          contourRecords: contourData.contourRecords,
          contourSvgPath: contourData.contourSvgPath,
          // Original OpenCV centre-coordinate path.
// Retained unchanged for comparison.
opencvContourSvgPath: contourData.contourSvgPath,

// New path following exact foreground pixel-cell boundaries.
pixelBoundaryContourSvgPath:
  pixelBoundaryContourData.path,

pixelBoundaryLoopCount:
  pixelBoundaryContourData.loopCount,

pixelBoundaryEdgeCount:
  pixelBoundaryContourData.boundaryEdgeCount,

pixelBoundaryIncompleteLoopCount:
  pixelBoundaryContourData.incompleteLoopCount,

  pixelBoundaryUntracedEdgeCount:
  pixelBoundaryContourData.untracedEdgeCount,

  
          pixelCellSvgPath,
          svgViewBox: `0 0 ${width} ${height}`,
          maskSource: "existing-selected-adaptive-threshold-mask",
        });
      } catch (error) {
        integrityFailures++;
        glyphs.push({
          index: i,
          text,
          status: "extraction-error",
          message: error?.message || String(error),
          cellBounds: { left: leftValue, right: rightValue },
        });
      } finally {
     for (const mat of [
  glyphRgba,
  glyphMask,
  glyphRgbaView,
  glyphMaskView,
  cellMaskPacked,
  cellMask,
]) {
          if (mat && typeof mat.delete === "function") mat.delete();
        }
      }
    }

    const extractedGlyphCount = glyphs.filter(
      (glyph) => glyph.status === "complete"
    ).length;

    return {
      status: integrityFailures === 0 ? "complete" : "review",
      method: "opencv-ctc-cell-mask-contours",
      coordinateSpace: "paddle-final-rectified-crop",
      maskSource: "existing-selected-adaptive-threshold-mask",
      tokenCount: characters.length,
      extractedGlyphCount,
      emptyGlyphCount,
      totalMaskPixels,
      totalContours,
      totalContourPoints,
      totalHoles,
      totalPixelBoundaryLoops,
totalPixelBoundaryEdges,
incompletePixelBoundaryLoops,
      integrityFailures,
      glyphs,
    };
  }


function attachCharacterAppearanceCrops({
  rgbaMat,
  glyphs,
  measuredCharacters,
  contextPadding = 3,
} = {}, cv) {
  if (
    !cv?.Mat ||
    !rgbaMat ||
    rgbaMat.channels() !== 4 ||
    !Array.isArray(glyphs) ||
    !Array.isArray(measuredCharacters)
  ) {
    throw new Error(
      "Appearance capture requires RGBA data and measured characters."
    );
  }

  const imageWidth = rgbaMat.cols;
  const imageHeight = rgbaMat.rows;

  const padding = Number.isFinite(Number(contextPadding))
    ? Math.max(0, Math.floor(Number(contextPadding)))
    : 3;

  const measurementsByIndex = new Map(
    measuredCharacters.map(character => [
      Number(character.index),
      character,
    ])
  );

  let attachedGlyphCount = 0;
  let skippedGlyphCount = 0;
  let integrityFailures = 0;

  for (const glyph of glyphs) {
    if (!glyph || glyph.status !== "complete") {
      skippedGlyphCount++;
      continue;
    }

    const measurement = measurementsByIndex.get(
      Number(glyph.index)
    );

    const measuredBounds = measurement?.cropBounds;
    const cell = glyph.cellBounds;

    const cellLeft = Number(cell?.pixelLeft);
    const cellRight = Number(cell?.pixelRightExclusive);

    const y = Number(measuredBounds?.y);
    const height = Number(measuredBounds?.height);

    // Full vertical extent of the already-extracted binary glyph.
// These bounds use the final rectified image coordinate space.
const binaryY = Number(glyph.cropBounds?.y);
const binaryHeight = Number(glyph.cropBounds?.height);

   if (
  !Number.isInteger(cellLeft) ||
  !Number.isInteger(cellRight) ||
  cellLeft < 0 ||
  cellRight > imageWidth ||
  cellRight <= cellLeft ||
  !Number.isFinite(y) ||
  !Number.isFinite(height) ||
  height <= 0 ||
  !Number.isFinite(binaryY) ||
  !Number.isFinite(binaryHeight) ||
  binaryY < 0 ||
  binaryHeight <= 0 ||
  binaryY + binaryHeight > imageHeight
) {
      glyph.appearanceStatus = "invalid-appearance-bounds";
      skippedGlyphCount++;
      continue;
    }

    // Keep horizontal ownership strictly inside the CTC cell.
    const left = cellLeft;
    const right = cellRight;

    // 1. Measured character bounds with context padding.
const measuredTop = Math.max(
  0,
  Math.floor(y) - padding
);

const measuredBottom = Math.min(
  imageHeight,
  Math.ceil(y + height) + padding
);

// 2. Complete vertical extent of the original binary glyph.
const binaryTop = Math.floor(binaryY);

const binaryBottom = Math.ceil(
  binaryY + binaryHeight
);

// 3. Combine both vertical ranges.
// This preserves every binary glyph pixel while retaining
// the original measured context padding.
const top = Math.min(
  measuredTop,
  binaryTop
);

const bottom = Math.max(
  measuredBottom,
  binaryBottom
);

    const cropWidth = right - left;
    const cropHeight = bottom - top;

    if (cropWidth < 1 || cropHeight < 1) {
      glyph.appearanceStatus = "invalid-appearance-crop";
      skippedGlyphCount++;
      continue;
    }

    let appearanceView = null;
    let packedAppearance = null;

    try {
      appearanceView = rgbaMat.roi(
        new cv.Rect(
          left,
          top,
          cropWidth,
          cropHeight
        )
      );

      // Clone so the returned bytes are tightly packed.
      packedAppearance = appearanceView.clone();

      const expectedByteLength =
        cropWidth * cropHeight * 4;

      if (
        !packedAppearance.data ||
        packedAppearance.data.length !== expectedByteLength
      ) {
        throw new Error(
          "Appearance RGBA buffer has an invalid byte length."
        );
      }

      // These are additional fields. Existing rgba, mask,
      // width, height and SVG paths remain unchanged.
      glyph.appearanceRgba = new Uint8ClampedArray(
        packedAppearance.data
      );

      glyph.appearanceWidth = cropWidth;
      glyph.appearanceHeight = cropHeight;

      glyph.appearanceCropBounds = {
        x: left,
        y: top,
        width: cropWidth,
        height: cropHeight,
      };

      glyph.appearanceContextPadding = padding;

    glyph.appearanceMethod =
  "ctc-cell-width-measured-plus-binary-vertical-bounds";

      glyph.appearanceStatus = "complete";

      attachedGlyphCount++;

    } catch (error) {
      glyph.appearanceStatus = "error";
      glyph.appearanceMessage =
        error?.message || String(error);

      integrityFailures++;

    } finally {
      for (const mat of [
        packedAppearance,
        appearanceView,
      ]) {
        if (mat && typeof mat.delete === "function") {
          mat.delete();
        }
      }
    }
  }

  return {
    status: integrityFailures === 0 ? "complete" : "review",
   method: "ctc-cell-width-measured-plus-binary-vertical-bounds",
    contextPadding: padding,
    attachedGlyphCount,
    skippedGlyphCount,
    integrityFailures,
  };
}

  
 scope.OriginalGlyphShapeExtractor = Object.freeze({
  extractCharacterGlyphShapes,
  attachCharacterAppearanceCrops,
});
})(self);
