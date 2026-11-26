
  /**
   * src/ocr/grayscale-glyph-diagnostics.js
   *
   * Read-only grayscale-aware glyph diagnostics.
   *
   * Uses:
   *   - Original rectified RGBA crop
   *   - Existing baseline binary mask
   *   - Existing measured character crop bounds
   *
   * Does not modify OCR, character measurements, font matching,
   * background repair, or PDF export.
   */

  const PANEL_ID = "paddle-original-glyph-shape-panel";
  const CONTEXT_PADDING = 3;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function median(values) {
    if (!values.length) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }


  /* -------------------------------------------------------
    SPATIAL GRAYSCALE INTENSITY PROFILER

    Classifies each pixel using the EXISTING binary mask.

    No thresholding, filtering, or mask modification.
  ------------------------------------------------------- */

  function summarizeIntensityGroup(values) {
    if (!values.length) {
      return {
        count: 0,
        min: null,
        p10: null,
        p25: null,
        median: null,
        p75: null,
        p90: null,
        max: null,
      };
    }

    const sorted = [...values].sort((a, b) => a - b);

    function percentile(p) {
      const index = Math.round(
        (sorted.length - 1) * p
      );

      return Number(sorted[index].toFixed(2));
    }

    return {
      count: sorted.length,
      min: sorted[0],
      p10: percentile(0.10),
      p25: percentile(0.25),
      median: percentile(0.50),
      p75: percentile(0.75),
      p90: percentile(0.90),
      max: sorted[sorted.length - 1],
    };
  }


  /* -------------------------------------------------------
    MULTI-DISTANCE GRAYSCALE INTENSITY PROFILER

    Distance is measured from the existing binary foreground
    using 8-connected pixel neighbours.

    Exterior rings:
      1 = immediately outside the binary glyph
      2 = two pixels away
      3 = three pixels away
      4+ = farther background

    No thresholding or mask modification.
  ------------------------------------------------------- */

  function collectSpatialIntensityBands(
    grayscale,
    binary,
    width,
    height
  ) {
    const totalPixels = width * height;
    const UNREACHED = 65535;

    const distance = new Uint16Array(totalPixels);
    distance.fill(UNREACHED);

    // Each pixel is inserted into the BFS queue at most once.
    const queue = new Int32Array(totalPixels);

    let head = 0;
    let tail = 0;

    const foregroundPixelCount = binary.reduce(
      (sum, value) => sum + (value !== 0 ? 1 : 0),
      0
    );

    // Every foreground pixel is a distance-zero seed.
    for (let i = 0; i < totalPixels; i++) {
      if (binary[i] !== 0) {
        distance[i] = 0;
        queue[tail++] = i;
      }
    }

    // No foreground means that distance rings cannot be measured.
    if (foregroundPixelCount === 0) {
      return {
        foregroundCore: summarizeIntensityGroup([]),
        foregroundCore4: summarizeIntensityGroup([]),
        foregroundBoundary: summarizeIntensityGroup([]),
        exteriorRing1: summarizeIntensityGroup([]),
        exteriorRing2: summarizeIntensityGroup([]),
        exteriorRing3: summarizeIntensityGroup([]),
        farBackground: summarizeIntensityGroup([]),
        foregroundCore4DiagonalAdded:
  summarizeIntensityGroup([]),

foregroundCore4DiagonalAddedSamples: [],
        distanceMethod: "8-connected-bfs",
        status: "no-foreground",
        foregroundCoreSamples: [],
        foregroundCore4Samples: [],
        distanceMap: distance,
      };
    }

    // -----------------------------------------------------
    // Calculate distances 1, 2 and 3 using multi-source BFS.
    // -----------------------------------------------------

    while (head < tail) {
      const currentIndex = queue[head++];
      const currentDistance = distance[currentIndex];

      // We only need the first three exterior rings.
      if (currentDistance >= 3) {
        continue;
      }

      const x = currentIndex % width;
      const y = Math.floor(currentIndex / width);

      const nextDistance = currentDistance + 1;

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

          const neighbourIndex = ny * width + nx;

          if (distance[neighbourIndex] !== UNREACHED) {
            continue;
          }

          distance[neighbourIndex] = nextDistance;

          if (nextDistance < 3) {
            queue[tail++] = neighbourIndex;
          }
        }
      }
    }

    const groups = {
  foregroundCore: [],
  foregroundCore4: [],
  foregroundCore4DiagonalAdded: [],
  foregroundBoundary: [],
  exteriorRing1: [],
  exteriorRing2: [],
  exteriorRing3: [],
  farBackground: [],
};

    // -----------------------------------------------------
    // Group grayscale values using their distance to ink.
    // -----------------------------------------------------

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        const value = grayscale[index];
        const isInk = binary[index] !== 0;

     if (isInk) {
  let touchesBackground8 = false;
  let touchesBackground4 = false;

  // Examine the same eight neighboring pixels.
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

      const neighbourIndex =
        ny * width + nx;

      if (binary[neighbourIndex] === 0) {
        // Existing strict 8-neighbor boundary.
        touchesBackground8 = true;

        // New 4-neighbor boundary:
        // only horizontal and vertical neighbors.
        if (dx === 0 || dy === 0) {
          touchesBackground4 = true;
        }
      }
    }
  }

  // Preserve the existing 8-neighbor classification.
  if (touchesBackground8) {
    groups.foregroundBoundary.push(value);
  } else {
    groups.foregroundCore.push(value);
  }

if (!touchesBackground4) {
  groups.foregroundCore4.push(value);

  // Additional 4-neighbor pixels that fail
  // the original 8-neighbor core definition.
  if (touchesBackground8) {
    groups.foregroundCore4DiagonalAdded.push(value);
  }
}
  continue;
}

        const d = distance[index];

        if (d === 1) {
          groups.exteriorRing1.push(value);

        } else if (d === 2) {
          groups.exteriorRing2.push(value);

        } else if (d === 3) {
          groups.exteriorRing3.push(value);

        } else {
          groups.farBackground.push(value);
        }
      }
    }

    return {
      foregroundCore:
        summarizeIntensityGroup(groups.foregroundCore),
foregroundCore4:
  summarizeIntensityGroup(groups.foregroundCore4),
      foregroundBoundary:
        summarizeIntensityGroup(groups.foregroundBoundary),

      exteriorRing1:
        summarizeIntensityGroup(groups.exteriorRing1),

      exteriorRing2:
        summarizeIntensityGroup(groups.exteriorRing2),

      exteriorRing3:
        summarizeIntensityGroup(groups.exteriorRing3),

      farBackground:
        summarizeIntensityGroup(groups.farBackground),
  foregroundCoreSamples: groups.foregroundCore,
  foregroundCore4Samples: groups.foregroundCore4,
foregroundCore4DiagonalAddedSamples:
  groups.foregroundCore4DiagonalAdded,
  foregroundCore4DiagonalAdded:
  summarizeIntensityGroup(
    groups.foregroundCore4DiagonalAdded
  ),
      distanceMethod: "8-connected-bfs",
      maxExteriorDistance: 3,
      status: "complete",

      distanceMap: distance,
    };

    
  }
  /**
   * Estimates grayscale ink coverage in the three exterior
   * distance rings.
   *
   * Uses a linear grayscale-mixing model:
   *   0%   = background-like pixel
   *   100% = ink-like pixel
   *
   * This is an estimated coverage proxy, not a measurement
   * of physical ink opacity.
   *
   * Uses the existing grayscale, binary mask and BFS distance
   * map. Does not modify any input arrays.
   */
  function collectExteriorInkCoverage({
    grayscale,
    binary,
    distanceMap,
    backgroundGray,
    inkGray,
    polarity,
  } = {}) {
    const emptySummary = () =>
      summarizeIntensityGroup([]);

    const emptyResult = (status) => ({
      status,
      model: "linear-grayscale-mixing-estimate",
      rings: {
        ring1: emptySummary(),
        ring2: emptySummary(),
        ring3: emptySummary(),
      },
    });

    // Validate all source arrays.
    if (
      !grayscale ||
      !binary ||
      !distanceMap ||
      grayscale.length !== binary.length ||
      grayscale.length !== distanceMap.length
    ) {
      return emptyResult("invalid-or-missing-distance-data");
    }

    if (
      !Number.isFinite(backgroundGray) ||
      !Number.isFinite(inkGray)
    ) {
      return emptyResult("invalid-intensity-endpoints");
    }

    if (
      polarity !== "dark-ink" &&
      polarity !== "light-ink"
    ) {
      return emptyResult("unsupported-polarity");
    }

    // Calculate the intensity difference between the
    // estimated background and ink endpoints.
    const contrastRange = polarity === "dark-ink"
      ? backgroundGray - inkGray
      : inkGray - backgroundGray;

    if (contrastRange < 2) {
      return emptyResult("insufficient-intensity-contrast");
    }

    const groups = {
      ring1: [],
      ring2: [],
      ring3: [],
    };

    for (let i = 0; i < grayscale.length; i++) {
      // Only inspect pixels outside the original glyph mask.
      if (binary[i] !== 0) {
        continue;
      }

      const distance = distanceMap[i];

      if (distance < 1 || distance > 3) {
        continue;
      }

      const gray = grayscale[i];

      // Estimate ink contribution using the two grayscale
      // endpoints and the linear mixing assumption.
      const rawCoverage = polarity === "dark-ink"
        ? (backgroundGray - gray) / contrastRange
        : (gray - backgroundGray) / contrastRange;

      const coveragePercent =
        clamp(rawCoverage, 0, 1) * 100;

      if (distance === 1) {
        groups.ring1.push(coveragePercent);

      } else if (distance === 2) {
        groups.ring2.push(coveragePercent);

      } else if (distance === 3) {
        groups.ring3.push(coveragePercent);
      }
    }

    return {
      status: "complete",
      model: "linear-grayscale-mixing-estimate",
      polarity,

      backgroundReferenceGray: Number(
        backgroundGray.toFixed(2)
      ),

      inkReferenceGray: Number(
        inkGray.toFixed(2)
      ),

      contrastRange: Number(
        contrastRange.toFixed(2)
      ),

      rings: {
        ring1: summarizeIntensityGroup(groups.ring1),
        ring2: summarizeIntensityGroup(groups.ring2),
        ring3: summarizeIntensityGroup(groups.ring3),
      },
    };
  }

  function getGrayscale(rgba, pixelIndex) {
    const offset = pixelIndex * 4;

    const r = rgba[offset];
    const g = rgba[offset + 1];
    const b = rgba[offset + 2];
    const alpha = rgba[offset + 3] / 255;

    // Composite transparent pixels over white.
    const gray =
      0.299 * r +
      0.587 * g +
      0.114 * b;

    return Math.round(
      gray * alpha + 255 * (1 - alpha)
    );
  }

  /**
   * Extracts a padded, per-character grayscale sample.
   *
   * Character cropBounds are expressed in the final rectified
   * crop coordinate system, matching comparisonRaster.
   */
  function buildGrayscaleGlyphSample(
    character,
    raster,
    contextPadding = CONTEXT_PADDING
  ) {
    const width = Number(raster.width);
    const height = Number(raster.height);

    const bounds = character?.cropBounds;

    if (
      !bounds ||
      !Number.isFinite(Number(bounds.x)) ||
      !Number.isFinite(Number(bounds.y)) ||
      !Number.isFinite(Number(bounds.width)) ||
      !Number.isFinite(Number(bounds.height))
    ) {
      return {
        status: "missing-character-bounds",
        index: character?.index,
        text: character?.text,
      };
    }

    const rgba = raster.originalRGBA;
    const baselineMask = raster.baselineMask;

    if (
      !rgba ||
      !baselineMask ||
      rgba.length !== width * height * 4 ||
      baselineMask.length !== width * height
    ) {
      return {
        status: "invalid-comparison-raster",
        index: character.index,
        text: character.text,
      };
    }

    const glyphLeft = clamp(
      Math.floor(Number(bounds.x)),
      0,
      width
    );

    const glyphTop = clamp(
      Math.floor(Number(bounds.y)),
      0,
      height
    );

    const glyphRight = clamp(
      Math.ceil(Number(bounds.x) + Number(bounds.width)),
      0,
      width
    );

    const glyphBottom = clamp(
      Math.ceil(Number(bounds.y) + Number(bounds.height)),
      0,
      height
    );

    if (
      glyphRight <= glyphLeft ||
      glyphBottom <= glyphTop
    ) {
      return {
        status: "invalid-character-bounds",
        index: character.index,
        text: character.text,
      };
    }

    // Add context around the baseline glyph bounds.
    const left = Math.max(
      0,
      glyphLeft - contextPadding
    );

    const top = Math.max(
      0,
      glyphTop - contextPadding
    );

    const right = Math.min(
      width,
      glyphRight + contextPadding
    );

    const bottom = Math.min(
      height,
      glyphBottom + contextPadding
    );

    const cropWidth = right - left;
    const cropHeight = bottom - top;
    const totalPixels = cropWidth * cropHeight;

    const grayscale = new Uint8Array(totalPixels);
    const binary = new Uint8Array(totalPixels);

    const backgroundSamples = [];
    const inkSamples = [];

    // -----------------------------------------------------
    // 1. Extract original grayscale and baseline mask.
    // -----------------------------------------------------

    let destinationIndex = 0;

    for (let y = top; y < bottom; y++) {
      const rowOffset = y * width;

      for (let x = left; x < right; x++) {
        const sourceIndex = rowOffset + x;

        const gray = getGrayscale(
          rgba,
          sourceIndex
        );

        const isInk =
          baselineMask[sourceIndex] !== 0;

        grayscale[destinationIndex] = gray;

        binary[destinationIndex] = isInk ? 255 : 0;

        if (isInk) {
          inkSamples.push(gray);
        } else {
          backgroundSamples.push(gray);
        }

        destinationIndex++;
      }
    }

    if (
      !backgroundSamples.length ||
      !inkSamples.length
    ) {
      return {
        status: "insufficient-intensity-samples",
        index: character.index,
        text: character.text,
        backgroundSampleCount: backgroundSamples.length,
        inkSampleCount: inkSamples.length,
      };
    }
  // Measure intensity distribution by spatial relationship
  // to the existing baseline glyph boundary.

  const spatialIntensityBands =
    collectSpatialIntensityBands(
      grayscale,
      binary,
      cropWidth,
      cropHeight
    );
    // -----------------------------------------------------
    // 2. Estimate local background and ink intensity.
    // -----------------------------------------------------

    const backgroundMedian = median(backgroundSamples);
    const inkMedian = median(inkSamples);
  // Read-only intensity distributions for endpoint validation.
  const backgroundIntensityDistribution =
    summarizeIntensityGroup(backgroundSamples);

  const inkIntensityDistribution =
    summarizeIntensityGroup(inkSamples);
    const darkInk = inkMedian < backgroundMedian;

    const polarity = darkInk
      ? "dark-ink"
      : "light-ink";

    const contrastRange = Math.abs(
      backgroundMedian - inkMedian
    );

    if (contrastRange < 2) {
      return {
        status: "insufficient-grayscale-contrast",
        index: character.index,
        text: character.text,
        backgroundMedian,
        inkMedian,
        contrastRange,
      };
    }

    // -----------------------------------------------------
  // 2B. Estimate exterior-ring grayscale ink coverage.
  // -----------------------------------------------------

  const exteriorInkCoverage =
    collectExteriorInkCoverage({
      grayscale,
      binary,

      distanceMap:
        spatialIntensityBands.distanceMap,

      backgroundGray: backgroundMedian,
      inkGray: inkMedian,
      polarity,
    });

    // -----------------------------------------------------
    // 3. Build soft grayscale ink map.
    //
    // Background -> white.
    // Strong ink -> black.
    // Intermediate edge intensity -> intermediate gray.
    //
    // No binary threshold is applied here.
    // -----------------------------------------------------

    const softInkMap = new Uint8Array(totalPixels);

    let intermediateIntensityPixels = 0;
    let softInkStrengthSum = 0;
    let softInkStrengthMaximum = 0;

    for (let i = 0; i < totalPixels; i++) {
      const gray = grayscale[i];

      const signedInkDifference = darkInk
        ? backgroundMedian - gray
        : gray - backgroundMedian;

      const strength = clamp(
        signedInkDifference / contrastRange,
        0,
        1
      );

      // Visual convention: black = strongest ink.
      const softValue = Math.round(
        255 * (1 - strength)
      );

      softInkMap[i] = softValue;

      softInkStrengthSum += strength;

      softInkStrengthMaximum = Math.max(
        softInkStrengthMaximum,
        strength
      );

      if (strength > 0.05 && strength < 0.95) {
        intermediateIntensityPixels++;
      }
    }

    const baselineForegroundPixels =
      inkSamples.length;

    return {
      status: "complete",

      index: character.index,
      text: character.text,

      coordinateSpace: "final-rectified-crop",

      cropBounds: {
        x: left,
        y: top,
        width: cropWidth,
        height: cropHeight,
      },

      width: cropWidth,
      height: cropHeight,

      grayscale,
      binary,
      softInkMap,

      diagnostics: {
        polarity,

        backgroundMedianGray: Number(
          backgroundMedian.toFixed(2)
        ),

        inkMedianGray: Number(
          inkMedian.toFixed(2)
        ),

        contrastRange: Number(
          contrastRange.toFixed(2)
        ),

        backgroundIntensityDistribution,
  inkIntensityDistribution,

        backgroundSampleCount:
          backgroundSamples.length,

        inkSampleCount:
          inkSamples.length,

        baselineForegroundPixels,

        intermediateIntensityPixels,

        intermediateIntensityRatio: Number(
          (
            intermediateIntensityPixels /
            Math.max(1, totalPixels)
          ).toFixed(4)
        ),

        meanSoftInkStrength: Number(
          (
            softInkStrengthSum /
            Math.max(1, totalPixels)
          ).toFixed(4)
        ),

        maximumSoftInkStrength: Number(
          softInkStrengthMaximum.toFixed(4)
        ),

        spatialIntensityBands,
        exteriorInkCoverage,
      },
    };
  }

  /**
   * Draw an intensity array as grayscale pixels.
   */
  function drawGrayscalePixels(
    ctx,
    pixels,
    width,
    height,
    x,
    y,
    scale
  ) {
    const image = new ImageData(width, height);

    for (let i = 0; i < pixels.length; i++) {
      const offset = i * 4;
      const value = pixels[i];

      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }

    drawImageData(
      ctx,
      image,
      width,
      height,
      x,
      y,
      scale
    );
  }

  /**
   * Draw a binary mask.
   */
  function drawBinaryPixels(
    ctx,
    pixels,
    width,
    height,
    x,
    y,
    scale
  ) {
    const image = new ImageData(width, height);

    for (let i = 0; i < pixels.length; i++) {
      const value = pixels[i] !== 0 ? 15 : 255;
      const offset = i * 4;

      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }

    drawImageData(
      ctx,
      image,
      width,
      height,
      x,
      y,
      scale
    );
  }

  /**
   * Original grayscale + intensity-weighted spatial ring overlay.
   *
   * Ring 1 = red
   * Ring 2 = green
   * Ring 3 = blue
   *
   * Tint strength depends on grayscale darkening relative
   * to the measured local background.
   *
   * Original glyph pixels remain unchanged.
   */
  function drawSpatialRingOverlay(
    ctx,
    grayscale,
    binary,
    distanceMap,
    width,
    height,
    backgroundMedianGray,
    x,
    y,
    scale
  ) {
    if (
      !distanceMap ||
      distanceMap.length !== grayscale.length
    ) {
      drawGrayscalePixels(
        ctx,
        grayscale,
        width,
        height,
        x,
        y,
        scale
      );

      return;
    }

    const image = new ImageData(width, height);

    const ringColors = {
      1: [224, 82, 82],
      2: [53, 168, 121],
      3: [57, 137, 216],
    };

    const backgroundReference =
      Number.isFinite(backgroundMedianGray)
        ? backgroundMedianGray
        : 255;

    const maximumTint = 0.72;
    const noiseAllowance = 3;
    const intensityRange = 42;

    for (let i = 0; i < grayscale.length; i++) {
      const offset = i * 4;
      const gray = grayscale[i];

      // Keep original foreground pixels unchanged.
      const distance =
        binary[i] !== 0 ? 0 : distanceMap[i];

      const tint = ringColors[distance];

      let red = gray;
      let green = gray;
      let blue = gray;

      if (tint) {
        // Measure darkening relative to local background.
        const darkening = Math.max(
          0,
          backgroundReference - gray - noiseAllowance
        );

        // Soft intensity-based evidence, not a binary threshold.
        const intensityEvidence = clamp(
          darkening / intensityRange,
          0,
          1
        );

        const tintAmount =
          maximumTint * intensityEvidence;

        const baseAmount = 1 - tintAmount;

        red = Math.round(
          gray * baseAmount +
          tint[0] * tintAmount
        );

        green = Math.round(
          gray * baseAmount +
          tint[1] * tintAmount
        );

        blue = Math.round(
          gray * baseAmount +
          tint[2] * tintAmount
        );
      }

      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = 255;
    }

    drawImageData(
      ctx,
      image,
      width,
      height,
      x,
      y,
      scale
    );
  }

  function drawImageData(
    ctx,
    image,
    width,
    height,
    x,
    y,
    scale
  ) {
    const temporary = document.createElement("canvas");

    temporary.width = width;
    temporary.height = height;

    const temporaryContext = temporary.getContext("2d");

    if (!temporaryContext) {
      throw new Error(
        "Could not create grayscale glyph preview canvas."
      );
    }

    temporaryContext.putImageData(image, 0, 0);

    ctx.imageSmoothingEnabled = false;

    ctx.drawImage(
      temporary,
      x,
      y,
      width * scale,
      height * scale
    );
  }

  /**
   * Adds a read-only grayscale contact sheet to the existing
   * Original Glyph Shape Diagnostics panel.
   */
  export function showGrayscaleGlyphDiagnostics(
    label,
    measurement
  ) {
    if (
      typeof document === "undefined" ||
      !measurement
    ) {
      return;
    }

    const raster =
      measurement.glyphEnhancementDiagnostics
        ?.comparisonRaster;

    if (!raster) {
      console.warn(
        "[Grayscale Glyph Diagnostics] comparisonRaster is missing.",
        {
          text: label,
          enhancementStatus:
            measurement.glyphEnhancementDiagnostics?.status,
          expectedFields: [
            "width",
            "height",
            "originalRGBA",
            "baselineMask",
          ],
        }
      );

      return;
    }

    const panel = document.getElementById(PANEL_ID);

    if (!panel) {
      console.warn(
        "[Grayscale Glyph Diagnostics] Original glyph preview panel not found. Call showOriginalGlyphShapeContactSheet() first."
      );

      return;
    }

    const characters = Array.isArray(measurement.characters)
      ? measurement.characters
      : [];

    const samples = [];
    const rejected = [];

    for (const character of characters) {
      if (
        character.status !== "measured" &&
        character.status !== "measured-low-pixel-count"
      ) {
        continue;
      }

      const sample = buildGrayscaleGlyphSample(
        character,
        raster
      );

      if (sample.status === "complete") {
        samples.push(sample);
      } else {
        rejected.push(sample);
      }
    }

    if (!samples.length) {
      console.warn(
        "[Grayscale Glyph Diagnostics] No usable grayscale glyph samples.",
        {
          text: label,
          rejected,
        }
      );

      return;
    }

// -----------------------------------------------------
// Pooled and equal-glyph-weighted foreground-core references.
//
// Existing pooled calculation remains unchanged.
// The per-glyph calculation is diagnostic only.
// -----------------------------------------------------

const lineCoreSamples = [];

const lineCorePerGlyphMedians = [];

// Diagnostic-only 4-neighbor core collection.
const lineCore4Samples = [];

let lineCore4GlyphCount = 0;

const lineCore4DiagonalAddedSamples = [];

let lineCore4DiagonalAddedGlyphCount = 0;

const lineCorePerGlyphSampleCounts = [];

let lineCoreGlyphCount = 0;

for (const sample of samples) {
  const coreSamples =
    sample.diagnostics
      ?.spatialIntensityBands
      ?.foregroundCoreSamples;

const core4Samples =
  sample.diagnostics
    ?.spatialIntensityBands
    ?.foregroundCore4Samples;


const diagonalAddedSamples =
  sample.diagnostics
    ?.spatialIntensityBands
    ?.foregroundCore4DiagonalAddedSamples;

if (
  Array.isArray(diagonalAddedSamples) &&
  diagonalAddedSamples.length > 0
) {
  lineCore4DiagonalAddedGlyphCount++;

  lineCore4DiagonalAddedSamples.push(
    ...diagonalAddedSamples
  );
}

if (
  Array.isArray(core4Samples) &&
  core4Samples.length > 0
) {
  lineCore4GlyphCount++;

  lineCore4Samples.push(...core4Samples);
}


  if (Array.isArray(coreSamples) && coreSamples.length > 0) {
    lineCoreGlyphCount++;

    // Existing pixel-weighted pool.
    lineCoreSamples.push(...coreSamples);

    // New diagnostic: one median per contributing glyph.
    lineCorePerGlyphMedians.push(
      median(coreSamples)
    );

    lineCorePerGlyphSampleCounts.push(
      coreSamples.length
    );
  }
}

// -----------------------------------------------------
// Diagnostic-only sample-count sensitivity analysis.
// Compare equal-glyph medians using minimum core
// sample counts of 3 and 5.
// -----------------------------------------------------

const lineCorePerGlyphAtLeast3 = [];
const lineCorePerGlyphAtLeast5 = [];

for (
  let i = 0;
  i < lineCorePerGlyphMedians.length;
  i++
) {
  const coreSampleCount =
    lineCorePerGlyphSampleCounts[i];

  const glyphMedian =
    lineCorePerGlyphMedians[i];

  if (coreSampleCount >= 3) {
    lineCorePerGlyphAtLeast3.push(glyphMedian);
  }

  if (coreSampleCount >= 5) {
    lineCorePerGlyphAtLeast5.push(glyphMedian);
  }
}

const lineCorePerGlyphAtLeast3Distribution =
  summarizeIntensityGroup(
    lineCorePerGlyphAtLeast3
  );

const lineCorePerGlyphAtLeast5Distribution =
  summarizeIntensityGroup(
    lineCorePerGlyphAtLeast5
  );

// Existing pixel-weighted distribution.
const lineCoreDistribution =
  summarizeIntensityGroup(lineCoreSamples);
// New 4-neighbor diagnostic distribution.
const lineCore4Distribution =
  summarizeIntensityGroup(lineCore4Samples);
  const lineCore4DiagonalAddedDistribution =
  summarizeIntensityGroup(
    lineCore4DiagonalAddedSamples
  );
// New equal-glyph-weighted distribution.
const lineCorePerGlyphDistribution =
  summarizeIntensityGroup(lineCorePerGlyphMedians);

// Distribution of the number of core pixels per glyph.
const lineCorePerGlyphSampleCountDistribution =
  summarizeIntensityGroup(lineCorePerGlyphSampleCounts);

// Preserve the existing minimum-sample safeguard.
const hasLineCoreReference =
  lineCoreSamples.length >= 30;

const lineCoreInkP25ReferenceGray =
  hasLineCoreReference
    ? lineCoreDistribution.p25
    : null;

const lineCoreInkReferenceGray =
  hasLineCoreReference
    ? lineCoreDistribution.median
    : null;

const lineCoreInkP75ReferenceGray =
  hasLineCoreReference
    ? lineCoreDistribution.p75
    : null;

    const section = document.createElement("section");

    section.style.cssText = `
      margin:16px 0;
      padding:12px;
      background:#fff;
      border:1px solid #888;
      overflow-x:auto;
    `;

    const heading = document.createElement("h3");

    heading.textContent =
      `${label} — grayscale-aware glyph diagnostics`;

    heading.style.cssText =
      "margin:0 0 8px;font-size:16px;";

    const summary = document.createElement("div");

    summary.style.cssText = `
      margin-bottom:10px;
      color:#444;
      font:12px Arial,sans-serif;
      line-height:1.8;
    `;

  summary.textContent = [
    `usable glyphs: ${samples.length}`,
    `unavailable glyphs: ${rejected.length}`,
    `context padding: ${CONTEXT_PADDING}px`,
    "soft map: normalized grayscale contrast",
    "ring overlay: R1 red · R2 green · R3 blue",
    "no new thresholding or image modification",
  ].join(" · ");

    const maxWidth = Math.max(
      1,
      ...samples.map(sample => sample.width)
    );

    const maxHeight = Math.max(
      1,
      ...samples.map(sample => sample.height)
    );

    const scale = Math.max(
      4,
      Math.min(9, Math.floor(220 / maxHeight))
    );

    const padding = 8;
    const headerHeight = 42;
    const panelGap = 8;
  const panelCount = 4;

    const singlePanelWidth = Math.max(
      110,
      maxWidth * scale + padding * 2
    );

    const singlePanelHeight =
      maxHeight * scale +
      padding * 2 +
      headerHeight;

    const cellWidth =
      singlePanelWidth * panelCount +
      panelGap * (panelCount - 1);

    const cellHeight = singlePanelHeight + 8;

    const columns = Math.min(5, samples.length);
    const rows = Math.ceil(samples.length / columns);

    const canvas = document.createElement("canvas");

    canvas.width = columns * cellWidth;
    canvas.height = rows * cellHeight;

    canvas.style.cssText = `
      display:block;
      max-width:none;
      image-rendering:pixelated;
    `;

    const ctx = canvas.getContext("2d");

    if (!ctx) return;

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#e8e8e8";

    ctx.fillRect(
      0,
      0,
      canvas.width,
      canvas.height
    );

  const panelNames = [
    "Original grayscale",
    "Baseline binary mask",
    "Soft grayscale ink map",
    "Ring distance overlay",
  ];

    const diagnosticRows = [];

    samples.forEach((sample, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);

      const cellX = column * cellWidth;
      const cellY = row * cellHeight;

      ctx.fillStyle = "#fff";

      ctx.fillRect(
        cellX,
        cellY,
        cellWidth - 4,
        cellHeight - 4
      );

      ctx.strokeStyle = "#bdbdbd";

      ctx.strokeRect(
        cellX + 0.5,
        cellY + 0.5,
        cellWidth - 5,
        cellHeight - 5
      );

      ctx.fillStyle = "#222";
      ctx.font = "11px Arial";

      ctx.fillText(
        `${sample.index} "${sample.text}" ` +
        `${sample.width}×${sample.height}`,
        cellX + 6,
        cellY + 15
      );



  const bands = sample.diagnostics.spatialIntensityBands;

  const coverage =
    sample.diagnostics.exteriorInkCoverage;

  // Recalculate coverage using the pooled interior-ink
  // reference while retaining the existing background reference.

  const coreEndpointCoverage =
    Number.isFinite(lineCoreInkReferenceGray)
      ? collectExteriorInkCoverage({
          grayscale: sample.grayscale,
          binary: sample.binary,
          distanceMap: bands.distanceMap,

          backgroundGray:
            sample.diagnostics.backgroundMedianGray,

          inkGray: lineCoreInkReferenceGray,

          polarity: sample.diagnostics.polarity,
        })
      : null;

  const coreEndpointCoverageP25 =
    Number.isFinite(lineCoreInkP25ReferenceGray)
      ? collectExteriorInkCoverage({
          grayscale: sample.grayscale,
          binary: sample.binary,
          distanceMap: bands.distanceMap,
          backgroundGray:
            sample.diagnostics.backgroundMedianGray,
          inkGray: lineCoreInkP25ReferenceGray,
          polarity: sample.diagnostics.polarity,
        })
      : null;

  const coreEndpointCoverageP75 =
    Number.isFinite(lineCoreInkP75ReferenceGray)
      ? collectExteriorInkCoverage({
          grayscale: sample.grayscale,
          binary: sample.binary,
          distanceMap: bands.distanceMap,
          backgroundGray:
            sample.diagnostics.backgroundMedianGray,
          inkGray: lineCoreInkP75ReferenceGray,
          polarity: sample.diagnostics.polarity,
        })
      : null;

  const inkIntensity =
    sample.diagnostics.inkIntensityDistribution;

  const backgroundIntensity =
    sample.diagnostics.backgroundIntensityDistribution;

  diagnosticRows.push({
 
index: sample.index,
character: sample.text,

width: sample.width,
height: sample.height,

baselineForegroundPixels:
  sample.diagnostics.baselineForegroundPixels,

foregroundCoreCount:
  bands.foregroundCore.count,

foregroundBoundaryCount:
  bands.foregroundBoundary.count,

foregroundCoreRatio: Number(
  (
    bands.foregroundCore.count /
    Math.max(
      1,
      sample.diagnostics.baselineForegroundPixels
    )
  ).toFixed(4)
),

polarity: sample.diagnostics.polarity,

    foregroundCoreCount: bands.foregroundCore.count,
    foregroundCoreMedian: bands.foregroundCore.median,

    foregroundBoundaryCount: bands.foregroundBoundary.count,
    foregroundBoundaryMedian: bands.foregroundBoundary.median,

    ring1Count: bands.exteriorRing1.count,
    ring1P10: bands.exteriorRing1.p10,
    ring1P25: bands.exteriorRing1.p25,
    ring1Median: bands.exteriorRing1.median,
    ring1P75: bands.exteriorRing1.p75,

    ring2Count: bands.exteriorRing2.count,
    ring2P10: bands.exteriorRing2.p10,
    ring2P25: bands.exteriorRing2.p25,
    ring2Median: bands.exteriorRing2.median,
    ring2P75: bands.exteriorRing2.p75,

    ring3Count: bands.exteriorRing3.count,
    ring3P10: bands.exteriorRing3.p10,
    ring3P25: bands.exteriorRing3.p25,
    ring3Median: bands.exteriorRing3.median,
    ring3P75: bands.exteriorRing3.p75,

    farBackgroundCount: bands.farBackground.count,
    farBackgroundMedian: bands.farBackground.median,
    coverageStatus: coverage?.status,

    backgroundReferenceGray:
      coverage?.backgroundReferenceGray,

    inkReferenceGray:
      coverage?.inkReferenceGray,

    inkContrastRange:
      coverage?.contrastRange,

    ring1CoverageCount:
      coverage?.rings?.ring1?.count,

    ring1CoverageP10:
      coverage?.rings?.ring1?.p10,

    ring1CoverageMedian:
      coverage?.rings?.ring1?.median,

    ring1CoverageP75:
      coverage?.rings?.ring1?.p75,

    ring2CoverageCount:
      coverage?.rings?.ring2?.count,

    ring2CoverageP10:
      coverage?.rings?.ring2?.p10,

    ring2CoverageMedian:
      coverage?.rings?.ring2?.median,

    ring2CoverageP75:
      coverage?.rings?.ring2?.p75,

    ring3CoverageCount:
      coverage?.rings?.ring3?.count,

    ring3CoverageP10:
      coverage?.rings?.ring3?.p10,

    ring3CoverageMedian:
      coverage?.rings?.ring3?.median,

    ring3CoverageP75:
      coverage?.rings?.ring3?.p75,

    inkP10: inkIntensity?.p10,
    inkP25: inkIntensity?.p25,
    inkMedian: inkIntensity?.median,
    inkP75: inkIntensity?.p75,
    inkP90: inkIntensity?.p90,

    backgroundP10: backgroundIntensity?.p10,
    backgroundP25: backgroundIntensity?.p25,
    backgroundMedian: backgroundIntensity?.median,
    backgroundP75: backgroundIntensity?.p75,
    backgroundP90: backgroundIntensity?.p90,

    ring1CoverageP90:
      coverage?.rings?.ring1?.p90,

    ring2CoverageP90:
      coverage?.rings?.ring2?.p90,

    ring3CoverageP90:
      coverage?.rings?.ring3?.p90,

      lineCoreInkSampleCount:
    lineCoreSamples.length,

  lineCoreInkP10:
    lineCoreDistribution.p10,

  lineCoreInkP25:
    lineCoreDistribution.p25,

  lineCoreInkMedian:
    lineCoreDistribution.median,

  lineCoreInkP75:
    lineCoreDistribution.p75,

  lineCoreInkP90:
    lineCoreDistribution.p90,

  ring1CoreEndpointMedian:
    coreEndpointCoverage?.rings?.ring1?.median,

  ring1CoreEndpointP90:
    coreEndpointCoverage?.rings?.ring1?.p90,

  ring2CoreEndpointMedian:
    coreEndpointCoverage?.rings?.ring2?.median,

  ring2CoreEndpointP90:
    coreEndpointCoverage?.rings?.ring2?.p90,

  ring3CoreEndpointMedian:
    coreEndpointCoverage?.rings?.ring3?.median,

  ring3CoreEndpointP90:
    coreEndpointCoverage?.rings?.ring3?.p90,
  lineCoreGlyphCount,

  lineCoreInkP25ReferenceGray,
  lineCoreInkP75ReferenceGray,

  ring1CoreP25EndpointP90:
    coreEndpointCoverageP25?.rings?.ring1?.p90,

  ring1CoreP75EndpointP90:
    coreEndpointCoverageP75?.rings?.ring1?.p90,

  ring2CoreP25EndpointP90:
    coreEndpointCoverageP25?.rings?.ring2?.p90,

  ring2CoreP75EndpointP90:
    coreEndpointCoverageP75?.rings?.ring2?.p90,

  ring3CoreP25EndpointP90:
    coreEndpointCoverageP25?.rings?.ring3?.p90,

  ring3CoreP75EndpointP90:
    coreEndpointCoverageP75?.rings?.ring3?.p90,
    distanceMethod: bands.distanceMethod,
  });

      for (let viewIndex = 0; viewIndex < panelCount; viewIndex++) {
        const panelX =
          cellX +
          viewIndex * (singlePanelWidth + panelGap);

        const imageAreaX = panelX + padding;

        const imageX =
          imageAreaX +
          Math.floor((maxWidth - sample.width) * scale / 2);

        const imageY =
          cellY +
          headerHeight +
          padding +
          Math.floor((maxHeight - sample.height) * scale / 2);

        ctx.fillStyle = "#555";
        ctx.font = "10px Arial";

        ctx.fillText(
          panelNames[viewIndex],
          panelX + 5,
          cellY + 34
        );

        ctx.fillStyle = "#fafafa";

        ctx.fillRect(
          panelX + 2,
          cellY + headerHeight - 2,
          singlePanelWidth - 4,
          singlePanelHeight - headerHeight + 2
        );

      if (viewIndex === 0) {
    // Original grayscale.
    drawGrayscalePixels(
      ctx,
      sample.grayscale,
      sample.width,
      sample.height,
      imageX,
      imageY,
      scale
    );

  } else if (viewIndex === 1) {
    // Existing baseline binary mask.
    drawBinaryPixels(
      ctx,
      sample.binary,
      sample.width,
      sample.height,
      imageX,
      imageY,
      scale
    );

  } else if (viewIndex === 2) {
    // Existing soft grayscale ink map.
    drawGrayscalePixels(
      ctx,
      sample.softInkMap,
      sample.width,
      sample.height,
      imageX,
      imageY,
      scale
    );

  } else if (viewIndex === 3) {
    // Original grayscale + BFS distance-ring overlay.
    const distanceMap =
      sample.diagnostics.spatialIntensityBands.distanceMap;

  drawSpatialRingOverlay(
    ctx,
    sample.grayscale,
    sample.binary,
    distanceMap,
    sample.width,
    sample.height,

    sample.diagnostics.backgroundMedianGray,

    imageX,
    imageY,
    scale
  );
  }
      }
    });

    section.append(
      heading,
      summary,
      canvas
    );

    panel.appendChild(section);

    console.groupCollapsed(
      `[Grayscale Glyph Diagnostics] ${label}`
    );

    console.log("Grayscale extraction summary:", {
      status: "complete",
      usableGlyphs: samples.length,
      rejectedGlyphs: rejected.length,
      contextPadding: CONTEXT_PADDING,
      sourceWidth: raster.width,
      sourceHeight: raster.height,
    });

  console.log(
    "Pooled foreground-core ink endpoint:",
    {
      status:
        lineCoreSamples.length >= 30
          ? "candidate-available"
          : "insufficient-core-samples",

      sampleCount: lineCoreSamples.length,
  contributingGlyphCount: lineCoreGlyphCount,

  p25ReferenceGray: lineCoreInkP25ReferenceGray,

  medianReferenceGray: lineCoreInkReferenceGray,

  p75ReferenceGray: lineCoreInkP75ReferenceGray,
      p10: lineCoreDistribution.p10,
      p25: lineCoreDistribution.p25,
      median: lineCoreDistribution.median,
      p75: lineCoreDistribution.p75,
      p90: lineCoreDistribution.p90,

      candidateInkReferenceGray:
        lineCoreInkReferenceGray,
    }
  );

console.log(
  "4-neighbor foreground-core diagnostic:",
  {
    status: "exploratory-only",

    usableGlyphs: samples.length,

    contributingGlyphs:
      lineCore4GlyphCount,

    glyphsWithoutCoreSamples:
      samples.length - lineCore4GlyphCount,

    totalCoreSamples:
      lineCore4Samples.length,

    additionalSamplesComparedWith8Neighbor:
      lineCore4Samples.length -
      lineCoreSamples.length,

    p10:
      lineCore4Distribution.p10,

    p25:
      lineCore4Distribution.p25,

    median:
      lineCore4Distribution.median,

    p75:
      lineCore4Distribution.p75,

    p90:
      lineCore4Distribution.p90,
  }
);

console.log(
  "Additional diagonal-exposure foreground-core diagnostic:",
  {
    status: "exploratory-only",

    contributingGlyphs:
      lineCore4DiagonalAddedGlyphCount,

    totalAdditionalSamples:
      lineCore4DiagonalAddedSamples.length,

    p10:
      lineCore4DiagonalAddedDistribution.p10,

    p25:
      lineCore4DiagonalAddedDistribution.p25,

    median:
      lineCore4DiagonalAddedDistribution.median,

    p75:
      lineCore4DiagonalAddedDistribution.p75,

    p90:
      lineCore4DiagonalAddedDistribution.p90,
  }
);


console.log(
  "Equal-glyph-weighted foreground-core diagnostic:",
  {
    status: "exploratory-only",

    usableGlyphs: samples.length,

    contributingGlyphs:
      lineCorePerGlyphMedians.length,

    glyphsWithoutCoreSamples:
      samples.length - lineCorePerGlyphMedians.length,

    medianOfGlyphMedians:
      lineCorePerGlyphDistribution.median,

    p10:
      lineCorePerGlyphDistribution.p10,

    p25:
      lineCorePerGlyphDistribution.p25,

    p75:
      lineCorePerGlyphDistribution.p75,

    p90:
      lineCorePerGlyphDistribution.p90,

sampleCountSensitivity: {
  minimum3: {
    contributingGlyphs:
      lineCorePerGlyphAtLeast3.length,

    median:
      lineCorePerGlyphAtLeast3Distribution.median,

    p25:
      lineCorePerGlyphAtLeast3Distribution.p25,

    p75:
      lineCorePerGlyphAtLeast3Distribution.p75,
  },

  minimum5: {
    contributingGlyphs:
      lineCorePerGlyphAtLeast5.length,

    median:
      lineCorePerGlyphAtLeast5Distribution.median,

    p25:
      lineCorePerGlyphAtLeast5Distribution.p25,

    p75:
      lineCorePerGlyphAtLeast5Distribution.p75,
  },
},

   coreSamplesPerGlyph: {
  min: lineCorePerGlyphSampleCountDistribution.min,
  median: lineCorePerGlyphSampleCountDistribution.median,
  max: lineCorePerGlyphSampleCountDistribution.max,
},
  }
);

    console.table(diagnosticRows);

// Show glyphs that have no interior foreground pixels.
const glyphsWithoutCore =
  diagnosticRows.filter(
    row => row.foregroundCoreCount === 0
  );

console.log(
  "[Grayscale Glyph Diagnostics] Glyphs without foreground core:",
  {
    count: glyphsWithoutCore.length,
    totalGlyphs: diagnosticRows.length,
  }
);

const zeroCoreDetails = glyphsWithoutCore
  .map(row => ({
    index: row.index,
    character: row.character,
    width: row.width,
    height: row.height,
    baselineForegroundPixels:
      row.baselineForegroundPixels,
    foregroundBoundaryCount:
      row.foregroundBoundaryCount,
    foregroundCoreRatio:
      row.foregroundCoreRatio,
  }))
  .sort((a, b) => a.index - b.index);

console.log(
  "[Zero-Core Glyph Details]",
  JSON.stringify(zeroCoreDetails, null, 2)
);


// -----------------------------------------------------
// Inspect glyphs that contribute foreground-core pixels.
// Diagnostic only.
// -----------------------------------------------------

const glyphsWithCore = diagnosticRows
  .filter(row => row.foregroundCoreCount > 0)
  .map(row => ({
    index: row.index,
    character: row.character,

    width: row.width,
    height: row.height,

    baselineForegroundPixels:
      row.baselineForegroundPixels,

    foregroundBoundaryCount:
      row.foregroundBoundaryCount,

    foregroundCoreCount:
      row.foregroundCoreCount,

    foregroundCoreRatio:
      row.foregroundCoreRatio,

    shareOfLineCoreSamples: Number(
      (
        row.foregroundCoreCount /
        Math.max(1, lineCoreSamples.length) *
        100
      ).toFixed(2)
    ),
  }))
  .sort(
    (a, b) =>
      b.foregroundCoreCount -
      a.foregroundCoreCount
  );

console.log(
  "[Foreground-Core Contributing Glyphs]",
  JSON.stringify(glyphsWithCore, null, 2)
);

    if (rejected.length) {
      console.warn("Rejected grayscale samples:", rejected);
    }

    console.groupEnd();
  }
