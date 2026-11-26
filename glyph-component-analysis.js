
/**
 * src/ocr/glyph-graphics/glyph-component-analysis.js
 *
 * Diagnostic connected-component analysis for extracted OCR glyphs.
 *
 * Input:
 *   glyph.mask
 *   glyph.width
 *   glyph.height
 *   glyph.cropBounds
 *
 * Optional supporting evidence:
 *   measurementCharacter.componentDiagnostics
 *
 * Features:
 *   - 8-connected foreground component detection
 *   - Component pixel counts and bounding boxes
 *   - Pixel-centre centroids
 *   - Local pixel runs
 *   - Distance from the largest component
 *   - Glyph-crop boundary contact
 *   - Cross-reference with existing OpenCV component diagnostics
 *
 * IMPORTANT:
 *   This module never modifies the input glyph or mask.
 *   It never removes pixels or generates a cleaned mask.
 *   All classifications are diagnostic suggestions only.
 */

/* =======================================================
   1. DEFAULT OPTIONS
======================================================= */

const DEFAULT_OPTIONS = Object.freeze({
  // A component is considered small if its area is no greater
  // than either this absolute limit or the relative-area limit.
  smallAbsolutePixelLimit: 3,

  smallAreaRatio: 0.08,

  // A small component within this Chebyshev distance of the
  // largest component becomes a review candidate.
  nearLargestDistancePx: 3,

  // Only search as far as necessary for this diagnostic.
  distanceSearchLimitPx: 8,

  // Prevent unexpectedly large masks from allocating excessive
  // memory in the browser.
  maxPixelCount: 4_000_000,

  // Include row-wise local pixel runs in the result.
  includePixelRuns: true,
});

/* =======================================================
   2. VALIDATION
======================================================= */

function validateGlyph(glyph, maxPixelCount) {
  if (!glyph || typeof glyph !== "object") {
    throw new Error(
      "A valid extracted glyph object is required."
    );
  }

  const width = Number(glyph.width);
  const height = Number(glyph.height);

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error(
      "Invalid glyph width or height."
    );
  }

  const pixelCount = width * height;

  if (
    !Number.isSafeInteger(pixelCount) ||
    pixelCount > maxPixelCount
  ) {
    throw new Error(
      `Glyph is too large for component analysis: ${width} × ${height}.`
    );
  }

  const mask = glyph.mask;

  if (
    !mask ||
    typeof mask.length !== "number" ||
    mask.length !== pixelCount
  ) {
    throw new Error(
      "Glyph mask dimensions do not match the glyph."
    );
  }

  return {
    width,
    height,
    pixelCount,
    mask,
  };
}

/* =======================================================
   3. OPTION NORMALIZATION
======================================================= */

function normalizeOptions(options = {}) {
  const merged = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  const smallAbsolutePixelLimit = Math.max(
    1,
    Math.floor(
      Number(merged.smallAbsolutePixelLimit)
    )
  );

  const smallAreaRatio = Number(
    merged.smallAreaRatio
  );

  const nearLargestDistancePx = Math.max(
    0,
    Math.floor(
      Number(merged.nearLargestDistancePx)
    )
  );

  const distanceSearchLimitPx = Math.max(
    nearLargestDistancePx,
    Math.floor(
      Number(merged.distanceSearchLimitPx)
    )
  );

  const maxPixelCount = Math.max(
    1,
    Math.floor(
      Number(merged.maxPixelCount)
    )
  );

  if (
    !Number.isFinite(smallAbsolutePixelLimit) ||
    !Number.isFinite(smallAreaRatio) ||
    smallAreaRatio < 0 ||
    smallAreaRatio > 1 ||
    !Number.isFinite(nearLargestDistancePx) ||
    !Number.isFinite(distanceSearchLimitPx) ||
    !Number.isFinite(maxPixelCount)
  ) {
    throw new Error(
      "Invalid glyph component analysis options."
    );
  }

  return {
    smallAbsolutePixelLimit,
    smallAreaRatio,
    nearLargestDistancePx,
    distanceSearchLimitPx,
    maxPixelCount,
    includePixelRuns:
      merged.includePixelRuns !== false,
  };
}

/* =======================================================
   4. COUNT FOREGROUND PIXELS
======================================================= */

function countForegroundPixels(mask) {
  let count = 0;

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) {
      count++;
    }
  }

  return count;
}

/* =======================================================
   5. 8-CONNECTED COMPONENT LABELING
======================================================= */

/**
 * Find every 8-connected foreground component.
 *
 * Connectivity:
 *
 *   X X X
 *   X P X
 *   X X X
 *
 * Diagonal foreground neighbours belong to the same component.
 *
 * Background pixels remain label 0.
 * Foreground components receive labels starting at 1.
 */

function extractConnectedComponents(
  mask,
  width,
  height,
  foregroundPixelCount
) {
  const pixelCount = width * height;

  const labelMap = new Uint32Array(pixelCount);

  // The queue can never contain more entries than foreground pixels.
  const queue = new Int32Array(
    foregroundPixelCount
  );

  const components = [];

  for (let seed = 0; seed < pixelCount; seed++) {
    if (
      mask[seed] === 0 ||
      labelMap[seed] !== 0
    ) {
      continue;
    }

    const id = components.length + 1;

    let head = 0;
    let tail = 0;

    queue[tail++] = seed;
    labelMap[seed] = id;

    const component = {
      id,

      pixelCount: 0,

      minX: width,
      minY: height,

      maxX: -1,
      maxY: -1,

      sumX: 0,
      sumY: 0,

      touchesGlyphCropBoundary: false,

      _pixelIndices: [],
    };

    while (head < tail) {
      const index = queue[head++];

      const x = index % width;
      const y = Math.floor(index / width);

      component.pixelCount++;

      component._pixelIndices.push(index);

      component.sumX += x + 0.5;
      component.sumY += y + 0.5;

      component.minX = Math.min(
        component.minX,
        x
      );

      component.minY = Math.min(
        component.minY,
        y
      );

      component.maxX = Math.max(
        component.maxX,
        x
      );

      component.maxY = Math.max(
        component.maxY,
        y
      );

      if (
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1
      ) {
        component.touchesGlyphCropBoundary = true;
      }

      // Examine all 8 neighbouring positions.
      for (let dy = -1; dy <= 1; dy++) {
        const neighbourY = y + dy;

        if (
          neighbourY < 0 ||
          neighbourY >= height
        ) {
          continue;
        }

        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) {
            continue;
          }

          const neighbourX = x + dx;

          if (
            neighbourX < 0 ||
            neighbourX >= width
          ) {
            continue;
          }

          const neighbourIndex =
            neighbourY * width + neighbourX;

          if (
            mask[neighbourIndex] === 0 ||
            labelMap[neighbourIndex] !== 0
          ) {
            continue;
          }

          labelMap[neighbourIndex] = id;

          queue[tail++] = neighbourIndex;
        }
      }
    }

    components.push(component);
  }

  return {
    labelMap,
    components,
  };
}

/* =======================================================
   6. PIXEL RUN GENERATION
======================================================= */

/**
 * Produce horizontal runs for each component.
 *
 * Run coordinates:
 *   [y, startXInclusive, endXExclusive]
 *
 * All coordinates are relative to the extracted glyph mask.
 */

function buildComponentPixelRuns(
  labelMap,
  width,
  height,
  componentCount
) {
  const runsByComponent = Array.from(
    { length: componentCount + 1 },
    () => []
  );

  for (let y = 0; y < height; y++) {
    let x = 0;

    while (x < width) {
      const id = labelMap[y * width + x];

      if (id === 0) {
        x++;
        continue;
      }

      const startX = x;

      while (
        x < width &&
        labelMap[y * width + x] === id
      ) {
        x++;
      }

      runsByComponent[id].push([
        y,
        startX,
        x,
      ]);
    }
  }

  return runsByComponent;
}

/* =======================================================
   7. DISTANCE TO LARGEST COMPONENT
======================================================= */

/**
 * Calculate the minimum Chebyshev distance between two
 * foreground components.
 *
 * Chebyshev distance:
 *
 *   max(abs(dx), abs(dy))
 *
 * A value of 2 means the closest foreground pixel centres
 * are separated by two grid steps in the larger axis.
 *
 * This function searches only up to searchLimit.
 *
 * null means no match was found within that search radius;
 * it does not mean that the components have zero distance.
 */

function findDistanceToLargestComponent(
  component,
  largestComponent,
  width,
  height,
  searchLimit
) {
  if (!largestComponent || !searchLimit) {
    return null;
  }

  const largestPixels = new Set(
    largestComponent._pixelIndices
  );

  const smallestPossibleDistance = 2;

  for (
    let distance = smallestPossibleDistance;
    distance <= searchLimit;
    distance++
  ) {
    for (const index of component._pixelIndices) {
      const x = index % width;
      const y = Math.floor(index / width);

      for (
        let dy = -distance;
        dy <= distance;
        dy++
      ) {
        const neighbourY = y + dy;

        if (
          neighbourY < 0 ||
          neighbourY >= height
        ) {
          continue;
        }

        for (
          let dx = -distance;
          dx <= distance;
          dx++
        ) {
          // Only inspect the outer Chebyshev ring.
          if (
            Math.max(
              Math.abs(dx),
              Math.abs(dy)
            ) !== distance
          ) {
            continue;
          }

          const neighbourX = x + dx;

          if (
            neighbourX < 0 ||
            neighbourX >= width
          ) {
            continue;
          }

          const neighbourIndex =
            neighbourY * width + neighbourX;

          if (largestPixels.has(neighbourIndex)) {
            return distance;
          }
        }
      }
    }
  }

  return null;
}

/* =======================================================
   8. MEASUREMENT COMPONENT CORRELATION
======================================================= */

/**
 * Compare extracted glyph components against the existing
 * measurementCharacter.componentDiagnostics pixel runs.
 *
 * Measurement runs use rectified-crop coordinates.
 * Glyph mask coordinates are local to glyph.cropBounds.
 *
 * Only exact pixel overlap is counted.
 *
 * This is supporting evidence, not a new ownership decision.
 */

function collectMeasurementEvidence(
  glyph,
  measurementCharacter,
  labelMap,
  width,
  height,
  components
) {
  const result = {
    status: "not-provided",

    diagnosticComponentCount: 0,
    mappedDiagnosticComponentCount: 0,

    linkedGlyphComponentCount: 0,

    diagnostics: [],
  };

  const diagnostics =
    measurementCharacter?.componentDiagnostics;

  if (!Array.isArray(diagnostics)) {
    return result;
  }

  result.diagnosticComponentCount =
    diagnostics.length;

  if (
    !Array.isArray(glyph.cropBounds) &&
    !glyph.cropBounds
  ) {
    result.status = "glyph-crop-bounds-unavailable";
    return result;
  }

  const cropX = Number(glyph.cropBounds?.x);
  const cropY = Number(glyph.cropBounds?.y);

  if (
    !Number.isFinite(cropX) ||
    !Number.isFinite(cropY)
  ) {
    result.status = "invalid-glyph-crop-bounds";
    return result;
  }

  const evidenceByComponent = new Map();

  for (const diagnostic of diagnostics) {
    const runs = diagnostic.pixelRunsInCrop;

    if (!Array.isArray(runs)) {
      result.diagnostics.push({
        measurementComponentLabel:
          diagnostic.label ?? null,

        status: "pixel-runs-unavailable",

        overlapPixels: 0,
        glyphComponentLinks: [],
      });

      continue;
    }

    const overlapCounts = new Map();

    let validRunPixels = 0;

    for (const run of runs) {
      if (
        !Array.isArray(run) ||
        run.length < 3
      ) {
        continue;
      }

      const absoluteY = Number(run[0]);
      const startX = Number(run[1]);
      const endX = Number(run[2]);

      if (
        !Number.isInteger(absoluteY) ||
        !Number.isInteger(startX) ||
        !Number.isInteger(endX) ||
        endX <= startX
      ) {
        continue;
      }

      const localY = absoluteY - cropY;

      if (
        localY < 0 ||
        localY >= height
      ) {
        continue;
      }

      for (
        let absoluteX = startX;
        absoluteX < endX;
        absoluteX++
      ) {
        const localX = absoluteX - cropX;

        if (
          localX < 0 ||
          localX >= width
        ) {
          continue;
        }

        const label =
          labelMap[localY * width + localX];

        if (label === 0) {
          continue;
        }

        validRunPixels++;

        overlapCounts.set(
          label,
          (overlapCounts.get(label) || 0) + 1
        );
      }
    }

    const glyphComponentLinks = [
      ...overlapCounts.entries(),
    ]
      .map(([componentId, overlapPixels]) => {
        const component =
          components[componentId - 1];

        const diagnosticArea = Math.max(
          0,
          Number(diagnostic.pixelArea) || 0
        );

        return {
          glyphComponentId: componentId,

          overlapPixels,

          diagnosticPixelArea: diagnosticArea,

          glyphComponentPixelCount:
            component.pixelCount,

          overlapRatioOfDiagnostic:
            diagnosticArea > 0
              ? Number(
                  (
                    overlapPixels /
                    diagnosticArea
                  ).toFixed(4)
                )
              : null,

          overlapRatioOfGlyphComponent:
            Number(
              (
                overlapPixels /
                Math.max(1, component.pixelCount)
              ).toFixed(4)
            ),
        };
      })
      .sort(
        (a, b) =>
          b.overlapPixels - a.overlapPixels
      );

    const mapped = glyphComponentLinks.length > 0;

    if (mapped) {
      result.mappedDiagnosticComponentCount++;
    }

    for (const link of glyphComponentLinks) {
      if (!evidenceByComponent.has(
        link.glyphComponentId
      )) {
        evidenceByComponent.set(
          link.glyphComponentId,
          []
        );
      }

      evidenceByComponent.get(
        link.glyphComponentId
      ).push({
        measurementComponentLabel:
          diagnostic.label ?? null,

        overlapPixels: link.overlapPixels,

        overlapRatioOfDiagnostic:
          link.overlapRatioOfDiagnostic,

        overlapRatioOfGlyphComponent:
          link.overlapRatioOfGlyphComponent,

        measurementIncludedInRefinedHeight:
          diagnostic.includedInRefinedHeight ?? null,

        measurementExclusionReason:
          diagnostic.exclusionReason ?? null,
      });
    }

    result.diagnostics.push({
      measurementComponentLabel:
        diagnostic.label ?? null,

      measurementPixelArea:
        Number(diagnostic.pixelArea) || 0,

      runPixelCount: runs.reduce(
        (sum, run) => {
          const start = Number(run?.[1]);
          const end = Number(run?.[2]);

          return (
            Number.isFinite(start) &&
            Number.isFinite(end) &&
            end > start
          )
            ? sum + end - start
            : sum;
        },
        0
      ),

      validOverlapPixelCount: validRunPixels,

      status: mapped
        ? "overlap-found"
        : "no-overlap",

      glyphComponentLinks,
    });
  }

  for (const component of components) {
    component.measurementEvidence =
      evidenceByComponent.get(component.id) || [];

    component.measurementEvidenceCount =
      component.measurementEvidence.length;

    const includedEvidence =
      component.measurementEvidence.filter(
        item =>
          item.measurementIncludedInRefinedHeight === true
      );

    component.measurementSelectionEvidence =
      includedEvidence.length > 0
        ? "included-in-existing-height-measurement"
        : component.measurementEvidence.length > 0
          ? "overlap-without-height-inclusion"
          : "no-overlap";
  }

  result.linkedGlyphComponentCount =
    components.filter(
      component =>
        component.measurementEvidenceCount > 0
    ).length;

  result.status =
    result.mappedDiagnosticComponentCount > 0
      ? "mapped"
      : "no-overlapping-pixel-runs";

  return result;
}

/* =======================================================
   9. PUBLIC GLYPH ANALYSIS
======================================================= */

/**
 * Analyse one extracted glyph without changing its source mask.
 *
 * Usage:
 *
 * const analysis = analyzeGlyphComponents(
 *   character.originalGlyphShape,
 *   {
 *     measurementCharacter: character,
 *   }
 * );
 *
 * Returns:
 *
 * {
 *   status,
 *   summary,
 *   components,
 *   labelMap,
 *   measurementEvidence
 * }
 */

export function analyzeGlyphComponents(
  glyph,
  options = {}
) {
  const normalizedOptions = normalizeOptions(
    options
  );

  const {
    width,
    height,
    pixelCount,
    mask,
  } = validateGlyph(
    glyph,
    normalizedOptions.maxPixelCount
  );

  const foregroundPixelCount =
    countForegroundPixels(mask);

  if (foregroundPixelCount === 0) {
    return {
      status: "empty-mask",

      method: "8-connected-component-labeling",

      connectivity: 8,

      width,
      height,

      summary: {
        componentCount: 0,
        foregroundPixelCount: 0,
        backgroundPixelCount: pixelCount,
        largestComponentPixelCount: 0,
        smallDetachedCandidateCount: 0,
        cropBoundaryTouchingComponentCount: 0,
      },

      components: [],

      labelMap: new Uint32Array(pixelCount),

      measurementEvidence: {
        status: "not-available",
      },
    };
  }

  const {
    labelMap,
    components,
  } = extractConnectedComponents(
    mask,
    width,
    height,
    foregroundPixelCount
  );

  // The largest component is selected only as a geometric
  // reference. It is not assumed to be the complete glyph.
  const largestComponent = [...components].sort(
    (a, b) =>
      b.pixelCount - a.pixelCount ||
      a.id - b.id
  )[0];

  const largestPixelCount =
    largestComponent.pixelCount;

  const smallComponentThreshold = Math.max(
    normalizedOptions.smallAbsolutePixelLimit,
    Math.floor(
      largestPixelCount *
      normalizedOptions.smallAreaRatio
    )
  );

  // Optional row-wise pixel runs.
  const runsByComponent =
    normalizedOptions.includePixelRuns
      ? buildComponentPixelRuns(
          labelMap,
          width,
          height,
          components.length
        )
      : null;

  let smallDetachedCandidateCount = 0;

  let cropBoundaryTouchingComponentCount = 0;

  for (const component of components) {
    const isLargest =
      component.id === largestComponent.id;

    const bounds = {
      x: component.minX,
      y: component.minY,

      width:
        component.maxX - component.minX + 1,

      height:
        component.maxY - component.minY + 1,

      rightExclusive:
        component.maxX + 1,

      bottomExclusive:
        component.maxY + 1,
    };

    const centroid = {
      x: component.sumX / component.pixelCount,
      y: component.sumY / component.pixelCount,
    };

    const nearestDistance = isLargest
      ? 0
      : findDistanceToLargestComponent(
          component,
          largestComponent,
          width,
          height,
          normalizedOptions.distanceSearchLimitPx
        );

    const isSmallRelativeToLargest =
      !isLargest &&
      component.pixelCount <=
        smallComponentThreshold;

    const isNearLargest =
      !isLargest &&
      nearestDistance !== null &&
      nearestDistance <=
        normalizedOptions.nearLargestDistancePx;

    const isSmallDetachedCandidate =
      isSmallRelativeToLargest &&
      isNearLargest;

    if (isSmallDetachedCandidate) {
      smallDetachedCandidateCount++;
    }

    if (component.touchesGlyphCropBoundary) {
      cropBoundaryTouchingComponentCount++;
    }

    const role = isLargest
      ? "largest-component"
      : isSmallDetachedCandidate
        ? "small-detached-candidate"
        : "secondary-component";

    const record = {
      id: component.id,

      pixelCount: component.pixelCount,

      areaRatioOfLargest:
        Number(
          (
            component.pixelCount /
            Math.max(1, largestPixelCount)
          ).toFixed(4)
        ),

      bounds,

      centroid,

      touchesGlyphCropBoundary:
        component.touchesGlyphCropBoundary,

      distanceFromLargest: {
        value: nearestDistance,

        metric: "chebyshev-pixel-distance",

        maximumSearchDistance:
          normalizedOptions.distanceSearchLimitPx,

        status: isLargest
          ? "reference-component"
          : nearestDistance === null
            ? "beyond-search-radius"
            : "measured",
      },

      role,

      flags: {
        isLargestComponent: isLargest,

        isSmallRelativeToLargest,

        isNearLargest,

        smallDetachedCandidate:
          isSmallDetachedCandidate,
      },

      pixelRuns:
        runsByComponent
          ? runsByComponent[component.id]
          : null,

      measurementEvidence: [],

      measurementEvidenceCount: 0,

      measurementSelectionEvidence: "not-analysed",
    };

    // Keep the public records separate from internal flood-fill data.
    Object.assign(component, record);
  }

  const publicComponents = components.map(
    (component) => {
      const {
        _pixelIndices,
        minX,
        minY,
        maxX,
        maxY,
        sumX,
        sumY,
        ...publicRecord
      } = component;

      return publicRecord;
    }
  );

  const measurementEvidence =
    collectMeasurementEvidence(
      glyph,
      options.measurementCharacter,
      labelMap,
      width,
      height,
      publicComponents
    );

  // A candidate is only a review suggestion. Existing measurement
  // evidence can help inspect it, but never authorizes deletion.
  const protectedDetachedDetailCount =
    publicComponents.filter(
      component =>
        component.role === "small-detached-candidate" &&
        component.measurementSelectionEvidence ===
          "included-in-existing-height-measurement"
    ).length;

  return {
    status: "complete",

    method: "8-connected-component-labeling",

    connectivity: 8,

    coordinateSpace: "glyph-local",

    source: {
      glyphIndex: glyph.index ?? null,
      character: glyph.text ?? "",
      width,
      height,
      maskSource:
        glyph.maskSource || "provided-glyph-mask",
    },

    options: {
      smallAbsolutePixelLimit:
        normalizedOptions.smallAbsolutePixelLimit,

      smallAreaRatio:
        normalizedOptions.smallAreaRatio,

      nearLargestDistancePx:
        normalizedOptions.nearLargestDistancePx,

      distanceSearchLimitPx:
        normalizedOptions.distanceSearchLimitPx,

      includePixelRuns:
        normalizedOptions.includePixelRuns,
    },

    summary: {
      componentCount: publicComponents.length,

      foregroundPixelCount,

      backgroundPixelCount:
        pixelCount - foregroundPixelCount,

      largestComponentId:
        largestComponent.id,

      largestComponentPixelCount:
        largestPixelCount,

      largestComponentAreaRatio:
        Number(
          (
            largestPixelCount /
            foregroundPixelCount
          ).toFixed(4)
        ),

      smallComponentThresholdPixels:
        smallComponentThreshold,

      smallDetachedCandidateCount,

      protectedDetachedDetailCount,

      cropBoundaryTouchingComponentCount,

      maskPixelCountMatchesComponentSum:
        publicComponents.reduce(
          (sum, component) =>
            sum + component.pixelCount,
          0
        ) === foregroundPixelCount,
    },

    components: publicComponents,

    // Useful for rendering component IDs in the preview.
    // 0 = background; 1..N = component IDs.
    labelMap,

    measurementEvidence,

    note:
      "Component classifications are diagnostic only. No mask pixels were removed or modified.",
  };
}

/* =======================================================
   10. CHARACTER-LEVEL CONVENIENCE FUNCTION
======================================================= */

/**
 * Analyse a measured OCR character directly.
 *
 * This wrapper automatically connects:
 *   character.originalGlyphShape
 *   character.componentDiagnostics
 *
 * Usage:
 *
 * const result =
 *   analyzeMeasuredCharacterComponents(character);
 */

export function analyzeMeasuredCharacterComponents(
  character,
  options = {}
) {
  const glyph = character?.originalGlyphShape;

  if (!glyph) {
    throw new Error(
      "The character does not contain originalGlyphShape data."
    );
  }

  return analyzeGlyphComponents(
    glyph,
    {
      ...options,
      measurementCharacter: character,
    }
  );
}
