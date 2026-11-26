
/**
 * src/ocr/paddle-document-adapter.js
 * 
 * Converts PaddleOCR + OpenCV results into editable
 * document text blocks.
 *
 * Responsibilities:
 * - Convert rendered-image coordinates to page coordinates.
 * - Preserve PaddleOCR line polygons and confidence.
 * - Preserve OpenCV character polygons and measurements.
 * - Preserve OpenCV word segmentation and word bounds.
 * - Estimate an initial font size.
 * - Produce the existing application text-block format.
 *
 * Does not modify page state.
 */

import {
  createId,
} from "../state.js";

import {
  clampRectToPage,
} from "../utils/coordinates.js";

import {
  estimateFontSizeFromTextBlock,
} from "../utils/text-metrics.js";

import {
  estimateTypographyCandidates,
} from "./paddle-typography-matcher.js";

import {
  showOriginalGlyphShapeContactSheet,
} from "./glyph-shape-preview.js";

import {
  showGrayscaleGlyphDiagnostics,
} from "./grayscale-glyph-diagnostics.js";

import {
  showGlyphVectorPreview,
} from "./glyph-graphics/glyph-vector-preview.js";

/* =========================================================
   VALIDATION
   ========================================================= */

function validateArguments({
  result,
  page,
  renderedPage,
}) {
  if (!result || !Array.isArray(result.items)) {
    throw new Error(
      "A valid PaddleOCR pipeline result is required."
    );
  }

  if (!page?.id) {
    throw new Error(
      "A valid registered document page is required."
    );
  }

  if (
    renderedPage?.page?.id &&
    renderedPage.page.id !== page.id
  ) {
    throw new Error(
      "The rendered page does not match the supplied page."
    );
  }

  const sourceWidth = Number(
    page.sourceWidth || page.width
  );

  const sourceHeight = Number(
    page.sourceHeight || page.height
  );

  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    throw new Error(
      "Invalid source page dimensions."
    );
  }

  const scaleX = Number(renderedPage.ocrScaleX ?? 1);
  const scaleY = Number(renderedPage.ocrScaleY ?? 1);

  if (
    !Number.isFinite(scaleX) ||
    !Number.isFinite(scaleY) ||
    scaleX <= 0 ||
    scaleY <= 0
  ) {
    throw new Error(
      "Invalid OCR coordinate conversion factors."
    );
  }

  const imageWidth = Number(result.imageWidth);
  const imageHeight = Number(result.imageHeight);

  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    throw new Error(
      "The PaddleOCR result has invalid image dimensions."
    );
  }

  return {
    sourceWidth,
    sourceHeight,
    imageWidth,
    imageHeight,
    scaleX,
    scaleY,
  };
}


/* =========================================================
   IMAGE COORDINATE NORMALIZATION
   ========================================================= */

function normalizeRect(rect) {
  if (!rect) {
    return null;
  }

  const result = {
    x: Number(rect.x),
    y: Number(rect.y),
    width: Number(rect.width),
    height: Number(rect.height),
  };

  if (
    !Object.values(result).every(Number.isFinite) ||
    result.width <= 0 ||
    result.height <= 0
  ) {
    return null;
  }

  return result;
}


function normalizePolygon(polygon) {
  if (!Array.isArray(polygon)) {
    return null;
  }

  const points = polygon.map((point) => {
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

  if (
    points.length < 3 ||
    !points.every(
      ([x, y]) =>
        Number.isFinite(x) &&
        Number.isFinite(y)
    )
  ) {
    return null;
  }

  return points;
}


/* =========================================================
   COORDINATE CONVERSION
   ========================================================= */

/**
 * Convert rendered-image pixel coordinates into the
 * page's scale-1 source coordinate system.
 */
function imageRectToSource(
  imageRect,
  scaleX,
  scaleY,
  sourceWidth,
  sourceHeight
) {
  const normalized = normalizeRect(imageRect);

  if (!normalized) {
    return null;
  }

  const converted = {
    x: normalized.x / scaleX,
    y: normalized.y / scaleY,
    width: normalized.width / scaleX,
    height: normalized.height / scaleY,
  };

  return clampRectToPage(
    converted,
    sourceWidth,
    sourceHeight
  );
}


/**
 * Convert a polygon while preserving its quadrilateral shape.
 */
function imagePolygonToSource(
  imagePolygon,
  scaleX,
  scaleY
) {
  const points = normalizePolygon(imagePolygon);

  if (!points) {
    return null;
  }

  return points.map(([x, y]) => [
    x / scaleX,
    y / scaleY,
  ]);
}


/* =========================================================
   CHARACTER MEASUREMENTS
   ========================================================= */

/**
 * Convert page-level character geometry.
 *
 * Important:
 * polygon and inkBounds are page-image coordinates.
 * estimatedRegion, cropBounds, centerX and component
 * diagnostics are recognition-crop-relative data.
 *
 * Crop-relative diagnostic values are intentionally preserved
 * without coordinate conversion.
 */
function adaptCharacterMeasurements(
  measurement,
  scaleX,
  scaleY,
  sourceWidth,
  sourceHeight
) {
  if (!measurement) {
    return null;
  }

  const originalCharacters =
    Array.isArray(measurement.characters)
      ? measurement.characters
      : [];

  const characters = originalCharacters.map(
    (character) => {
      const imagePolygon = normalizePolygon(
        character.polygon
      );

      const imageInkBounds = normalizeRect(
        character.inkBounds
      );

      const sourcePolygon = imagePolygon
        ? imagePolygonToSource(
            imagePolygon,
            scaleX,
            scaleY
          )
        : null;

      const sourceInkBounds = imageInkBounds
        ? imageRectToSource(
            imageInkBounds,
            scaleX,
            scaleY,
            sourceWidth,
            sourceHeight
          )
        : null;

      return {
        ...character,

        // Original coordinates, retained for diagnostics.
        imagePolygon,
        imageInkBounds,

        // Canonical document-coordinate geometry.
        polygon: sourcePolygon,
        inkBounds: sourceInkBounds,

        coordinateSpace: "page-source",
      };
    }
  );

  return {
    ...measurement,

    characters,

    totalCharacterRecords: characters.length,

    coordinateSpace: "page-source",

    // The measurement crop dimensions remain crop-local.
    crop: measurement.crop
      ? { ...measurement.crop }
      : null,
  };
}


/* =========================================================
   WORD SEGMENTATION
   ========================================================= */

function adaptWordSegmentation(
  segmentation,
  scaleX,
  scaleY,
  sourceWidth,
  sourceHeight
) {
  if (!segmentation) {
    return null;
  }

  const originalWords = Array.isArray(segmentation.words)
    ? segmentation.words
    : [];

  const words = originalWords.map((word) => {
    const imageBounds = normalizeRect(word.bounds);

    const imagePolygon = normalizePolygon(
      word.polygon
    );

    return {
      ...word,

      imageBounds,
      imagePolygon,

      bounds: imageBounds
        ? imageRectToSource(
            imageBounds,
            scaleX,
            scaleY,
            sourceWidth,
            sourceHeight
          )
        : null,

      polygon: imagePolygon
        ? imagePolygonToSource(
            imagePolygon,
            scaleX,
            scaleY
          )
        : null,

      coordinateSpace: "page-source",
    };
  }).filter((word) => word.bounds);

  return {
    ...segmentation,
    words,
    coordinateSpace: "page-source",
  };
}


/* =========================================================
   CONFIDENCE
   ========================================================= */

/**
 * PaddleOCR generally reports confidence as 0–1.
 * The existing editor model uses 0–100.
 */
function normalizeConfidence(score) {
  const value = Number(score);

  if (!Number.isFinite(value)) {
    return 0;
  }

  const percentage = value <= 1
    ? value * 100
    : value;

  return Math.max(
    0,
    Math.min(100, percentage)
  );
}


/* =========================================================
   ORIGINAL TEXT COLOR SAMPLING
   ========================================================= */

const DEFAULT_ORIGINAL_TEXT_COLOR = "#000000";
const MAX_COLOR_SAMPLE_PIXELS = 300_000;
const COLOR_BIN_SIZE = 32;
const MIN_INK_CONTRAST = 12;

function medianChannel(values) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function colorDistance(rgb, background) {
  const dr = rgb[0] - background[0];
  const dg = rgb[1] - background[1];
  const db = rgb[2] - background[2];

  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function rgbToHex(rgb) {
  return "#" + rgb
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("");
}

/**
 * Get the untouched page raster used as the PaddleOCR source.
 * Prefer the original image element over a rendered canvas so
 * text color is sampled before any editor overlays are applied.
 */
function getOriginalPageRaster(renderedPage, page) {
  const imageElement = renderedPage?.backgroundElement;

  const canvasElement = renderedPage?.canvas;

  const source =
    imageElement &&
    Number(imageElement.naturalWidth) > 0 &&
    Number(imageElement.naturalHeight) > 0
      ? imageElement
      : canvasElement &&
          Number(canvasElement.width) > 0 &&
          Number(canvasElement.height) > 0
        ? canvasElement
        : null;

  if (!source) {
    return null;
  }

  const bitmapWidth = Number(
    source.naturalWidth || source.width
  );

  const bitmapHeight = Number(
    source.naturalHeight || source.height
  );

  const sourceWidth = Number(
    page.sourceWidth || page.width
  );

  const sourceHeight = Number(
    page.sourceHeight || page.height
  );

  if (
    !Number.isFinite(bitmapWidth) ||
    !Number.isFinite(bitmapHeight) ||
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    bitmapWidth <= 0 ||
    bitmapHeight <= 0 ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return null;
  }

  return {
    source,
    bitmapWidth,
    bitmapHeight,
    scaleX: bitmapWidth / sourceWidth,
    scaleY: bitmapHeight / sourceHeight,
  };
}

/**
 * Estimate the solid ink color from the original pixels inside
 * one line's visible-ink bounds.
 *
 * The local outside ring estimates the background. Stronger
 * contrast pixels inside the text bounds are then clustered so
 * antialiased edge pixels have less influence on the result.
 */
function sampleOriginalTextColor(raster, textBounds) {
  if (!raster || !textBounds) {
    return {
      color: DEFAULT_ORIGINAL_TEXT_COLOR,
      confidence: 0,
      sampleCount: 0,
      source: "fallback",
    };
  }

  const paddingX = Math.max(
    2,
    Math.min(12, textBounds.height * 0.18)
  );

  const paddingY = Math.max(
    2,
    Math.min(10, textBounds.height * 0.24)
  );

  const left = Math.max(
    0,
    Math.floor((textBounds.x - paddingX) * raster.scaleX)
  );

  const top = Math.max(
    0,
    Math.floor((textBounds.y - paddingY) * raster.scaleY)
  );

  const right = Math.min(
    raster.bitmapWidth,
    Math.ceil(
      (textBounds.x + textBounds.width + paddingX) *
      raster.scaleX
    )
  );

  const bottom = Math.min(
    raster.bitmapHeight,
    Math.ceil(
      (textBounds.y + textBounds.height + paddingY) *
      raster.scaleY
    )
  );

  const cropWidth = right - left;
  const cropHeight = bottom - top;

  if (cropWidth < 1 || cropHeight < 1) {
    return {
      color: DEFAULT_ORIGINAL_TEXT_COLOR,
      confidence: 0,
      sampleCount: 0,
      source: "fallback",
    };
  }

  // Downsample exceptionally large line regions to cap memory use.
  const reduction = cropWidth * cropHeight > MAX_COLOR_SAMPLE_PIXELS
    ? Math.sqrt(
        MAX_COLOR_SAMPLE_PIXELS /
        (cropWidth * cropHeight)
      )
    : 1;

  const sampleWidth = Math.max(
    1,
    Math.floor(cropWidth * reduction)
  );

  const sampleHeight = Math.max(
    1,
    Math.floor(cropHeight * reduction)
  );

  try {
    const canvas = document.createElement("canvas");
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;

    const context = canvas.getContext("2d", {
      willReadFrequently: true,
    });

    if (!context) {
      throw new Error("Could not create the text-color sampling canvas.");
    }

    context.drawImage(
      raster.source,
      left,
      top,
      cropWidth,
      cropHeight,
      0,
      0,
      sampleWidth,
      sampleHeight
    );

    const imageData = context.getImageData(
      0,
      0,
      sampleWidth,
      sampleHeight
    );

    const { data } = imageData;

    const target = {
      left: Math.max(
        0,
        Math.floor(
          (textBounds.x * raster.scaleX - left) *
          (sampleWidth / cropWidth)
        )
      ),
      top: Math.max(
        0,
        Math.floor(
          (textBounds.y * raster.scaleY - top) *
          (sampleHeight / cropHeight)
        )
      ),
      right: Math.min(
        sampleWidth,
        Math.ceil(
          (
            (textBounds.x + textBounds.width) *
            raster.scaleX - left
          ) *
          (sampleWidth / cropWidth)
        )
      ),
      bottom: Math.min(
        sampleHeight,
        Math.ceil(
          (
            (textBounds.y + textBounds.height) *
            raster.scaleY - top
          ) *
          (sampleHeight / cropHeight)
        )
      ),
    };

    if (
      target.right <= target.left ||
      target.bottom <= target.top
    ) {
      return {
        color: DEFAULT_ORIGINAL_TEXT_COLOR,
        confidence: 0,
        sampleCount: 0,
        source: "fallback",
      };
    }

    // Estimate the local paper/background color from the ring
    // immediately outside the actual visible ink rectangle.
    const ringPixels = [];

    for (let y = 0; y < sampleHeight; y++) {
      for (let x = 0; x < sampleWidth; x++) {
        const insideTarget =
          x >= target.left &&
          x < target.right &&
          y >= target.top &&
          y < target.bottom;

        if (insideTarget) {
          continue;
        }

        const index = (y * sampleWidth + x) * 4;

        if (data[index + 3] < 200) {
          continue;
        }

        ringPixels.push([
          data[index],
          data[index + 1],
          data[index + 2],
        ]);
      }
    }

    if (ringPixels.length < 3) {
      return {
        color: DEFAULT_ORIGINAL_TEXT_COLOR,
        confidence: 0,
        sampleCount: 0,
        source: "fallback",
      };
    }

    const background = [
      medianChannel(ringPixels.map((pixel) => pixel[0])),
      medianChannel(ringPixels.map((pixel) => pixel[1])),
      medianChannel(ringPixels.map((pixel) => pixel[2])),
    ];

    // Keep only pixels that differ clearly from the local background.
    const foreground = [];

    for (let y = target.top; y < target.bottom; y++) {
      for (let x = target.left; x < target.right; x++) {
        const index = (y * sampleWidth + x) * 4;

        if (data[index + 3] < 200) {
          continue;
        }

        const rgb = [
          data[index],
          data[index + 1],
          data[index + 2],
        ];

        const distance = colorDistance(rgb, background);

        if (distance >= MIN_INK_CONTRAST) {
       foreground.push({
  rgb,
  distance,
  x,
  y,
});
        }
      }
    }

    if (!foreground.length) {
      return {
        color: DEFAULT_ORIGINAL_TEXT_COLOR,
        confidence: 0,
        sampleCount: 0,
        source: "fallback",
      };
    }

        /*
     * STEP 1: Prioritize solid text-stroke pixels.
     *
     * Use the original 35% selection rather than 20%.
     * This gives the color clustering more samples to work with.
     */
    foreground.sort((a, b) => b.distance - a.distance);

    const coreCount = Math.min(
      foreground.length,
      Math.max(3, Math.ceil(foreground.length * 0.35))
    );

    const corePixels = foreground.slice(0, coreCount);

    /*
     * STEP 2: Group similar RGB colors.
     */
    const buckets = new Map();

    for (const pixel of corePixels) {
      const key = pixel.rgb
        .map((channel) =>
          Math.floor(channel / COLOR_BIN_SIZE)
        )
        .join(",");

      if (!buckets.has(key)) {
        buckets.set(key, []);
      }

      buckets.get(key).push(pixel);
    }

    /*
     * STEP 3: Evaluate each cluster.
     *
     * A genuine text color should:
     * - Have sufficient pixel support.
     * - Have reasonable contrast from the background.
     * - Appear across multiple horizontal regions of the line.
     */
    const targetWidth = Math.max(
      1,
      target.right - target.left
    );

    const horizontalBandCount = 6;

    const minimumClusterSize = Math.max(
      6,
      Math.ceil(corePixels.length * 0.02)
    );

    const candidateClusters = [...buckets.values()]
      .map((cluster) => {
        const horizontalBands = new Set(
          cluster.map((pixel) => {
            const relativeX =
              (pixel.x - target.left) / targetWidth;

            return Math.max(
              0,
              Math.min(
                horizontalBandCount - 1,
                Math.floor(
                  relativeX * horizontalBandCount
                )
              )
            );
          })
        );

        const medianContrast = medianChannel(
          cluster.map((pixel) => pixel.distance)
        );

        const horizontalCoverage =
          horizontalBands.size / horizontalBandCount;

        const support =
          cluster.length / Math.max(1, corePixels.length);

        /*
         * Balance pixel support, contrast and distribution.
         *
         * The square root prevents contrast from dominating
         * the cluster-size contribution.
         */
        const score =
          Math.sqrt(support) *
          (medianContrast / Math.sqrt(3 * 255 * 255)) *
          (0.35 + 0.65 * horizontalCoverage);

        return {
          cluster,
          medianContrast,
          horizontalCoverage,
          support,
          score,
        };
      })
      .filter(
        (candidate) =>
          candidate.cluster.length >= minimumClusterSize
      );

    /*
     * STEP 4: Choose the best-supported cluster.
     *
     * Unlike the previous implementation, a tiny cluster
     * cannot win just because it has extreme contrast.
     */
    candidateClusters.sort(
      (a, b) => b.score - a.score
    );

    const bestCluster = candidateClusters[0] || null;

    /*
     * STEP 5: Calculate the final color.
     *
     * When no cluster has enough support, use the core
     * pixel median as a low-confidence fallback.
     */
    const selectedPixels = bestCluster
      ? bestCluster.cluster.map((pixel) => pixel.rgb)
      : corePixels.map((pixel) => pixel.rgb);

    let color = [
      medianChannel(
        selectedPixels.map((pixel) => pixel[0])
      ),
      medianChannel(
        selectedPixels.map((pixel) => pixel[1])
      ),
      medianChannel(
        selectedPixels.map((pixel) => pixel[2])
      ),
    ];

    /*
     * STEP 6: Calculate reliability.
     */
    const clusterPurity = bestCluster
      ? bestCluster.cluster.length /
        Math.max(1, corePixels.length)
      : 0;

    const sampleReliability = Math.min(
      1,
      foreground.length / 40
    );

  let confidence = Math.min(
  0.98,
  clusterPurity * sampleReliability
);


/*
 * LIGHT TEXT CORE CORRECTION
 *
 * For light text on a dark or colored background,
 * the normal RGB cluster can select antialiased
 * pixels instead of the solid text-stroke pixels.
 *
 * Use a small high-contrast pixel sample only when
 * the current cluster result is suspiciously close
 * to the background.
 */

let colorSelectionMethod = "balanced-rgb-cluster";

let finalSelectedSampleCount = selectedPixels.length;

const getLuminance = (rgb) =>
  0.2126 * rgb[0] +
  0.7152 * rgb[1] +
  0.0722 * rgb[2];

const backgroundLuminance =
  getLuminance(background);

const detectedLuminance =
  getLuminance(color);

const luminanceDifference =
  detectedLuminance - backgroundLuminance;

// Only consider light text on a relatively dark background.
if (
  backgroundLuminance < 170 &&
  luminanceDifference > 0 &&
  luminanceDifference < 110
) {
  /*
   * foreground is already sorted from highest
   * background contrast to lowest background contrast.
   *
   * Select the strongest 1.5% of pixels, with
   * at least 16 samples where available.
   */
  const highContrastSampleCount = Math.min(
    foreground.length,
    Math.max(
      16,
      Math.ceil(foreground.length * 0.015)
    )
  );

  const highContrastCore = foreground.slice(
    0,
    highContrastSampleCount
  );

  if (highContrastCore.length >= 12) {
    color = [
      medianChannel(
        highContrastCore.map((pixel) => pixel.rgb[0])
      ),
      medianChannel(
        highContrastCore.map((pixel) => pixel.rgb[1])
      ),
      medianChannel(
        highContrastCore.map((pixel) => pixel.rgb[2])
      ),
    ];

    colorSelectionMethod = "bright-stroke-core";

    finalSelectedSampleCount = highContrastCore.length;

    confidence = Math.min(
      0.98,
      sampleReliability *
      Math.min(1, highContrastCore.length / 25)
    );
  }
}

/*
 * WHITE-BACKGROUND CHROMA ENDPOINT ESTIMATION
 *
 * Designed for small, faded, anti-aliased colored text
 * on white or near-white backgrounds.
 *
 * Instead of selecting the darkest pixel cluster,
 * estimate the underlying ink color from the RGB
 * channel relationships of the foreground pixels.
 */

let whiteBackgroundDiagnostics = null;

if (backgroundLuminance >= 220) {

  const ratioSamples = [];

  for (const sample of foreground) {

    const deltaR =
      background[0] - sample.rgb[0];

    const deltaG =
      background[1] - sample.rgb[1];

    const deltaB =
      background[2] - sample.rgb[2];

    // Ignore weak or invalid channel differences.
    if (
      deltaG <= 15 ||
      deltaR < 0 ||
      deltaB < 0
    ) {
      continue;
    }

    ratioSamples.push({
      redRatio: deltaR / deltaG,
      blueRatio: deltaB / deltaG,
      greenDeficit: deltaG,
    });
  }

  /*
   * Require enough reliable samples before replacing
   * the original cluster estimate.
   */
  if (ratioSamples.length >= 40) {

    const medianRedRatio = medianChannel(
      ratioSamples.map(
        (sample) => sample.redRatio
      )
    );

    const medianBlueRatio = medianChannel(
      ratioSamples.map(
        (sample) => sample.blueRatio
      )
    );

    /*
     * Retain pixels with a consistent RGB color direction.
     * This rejects many compression and ringing outliers.
     */
    const alignedSamples = ratioSamples.filter(
      (sample) =>
        Math.abs(
          sample.redRatio - medianRedRatio
        ) <= 0.05 &&
        Math.abs(
          sample.blueRatio - medianBlueRatio
        ) <= 0.08
    );

    if (alignedSamples.length >= 30) {

      /*
       * Estimate the near-solid ink strength using
       * the 90th percentile of green-channel deficits.
       *
       * This avoids relying on a single darkest pixel.
       */
      const sortedDeficits = alignedSamples
        .map((sample) => sample.greenDeficit)
        .sort((a, b) => a - b);

      const quantilePosition =
        (sortedDeficits.length - 1) * 0.90;

      const lowerIndex = Math.floor(
        quantilePosition
      );

      const upperIndex = Math.ceil(
        quantilePosition
      );

      const fraction =
        quantilePosition - lowerIndex;

      const greenDeficit =
        sortedDeficits[lowerIndex] *
          (1 - fraction) +
        sortedDeficits[upperIndex] *
          fraction;

      /*
       * Reconstruct the underlying RGB color.
       */
      color = [
        background[0] -
          medianRedRatio * greenDeficit,

        background[1] -
          greenDeficit,

        background[2] -
          medianBlueRatio * greenDeficit,
      ].map((channel) =>
        Math.max(
          0,
          Math.min(255, Math.round(channel))
        )
      );

      colorSelectionMethod =
        "white-background-chroma-endpoint";

      finalSelectedSampleCount =
        alignedSamples.length;

      confidence = Math.min(
        0.95,
        alignedSamples.length / 80
      );

      whiteBackgroundDiagnostics = {
        ratioSampleCount: ratioSamples.length,

        alignedSampleCount: alignedSamples.length,

        redDeficitRatio: Number(
          medianRedRatio.toFixed(3)
        ),

        blueDeficitRatio: Number(
          medianBlueRatio.toFixed(3)
        ),

        strengthPercentile: 0.90,

        greenDeficit: Number(
          greenDeficit.toFixed(2)
        ),
      };
    }
  }
}
    return {
      color: rgbToHex(color),

      confidence,

      sampleCount: foreground.length,

      source: "original-image-pixels",

      backgroundColor: rgbToHex(background),

      foregroundCount: foreground.length,

      coreCount: corePixels.length,

      dominantClusterCount: bestCluster
        ? bestCluster.cluster.length
        : 0,

     selectedSampleCount: finalSelectedSampleCount,

colorSelectionMethod,
      clusterPurity,

      sampleReliability,

      // Additional diagnostics.
      selectedMedianContrast: bestCluster
        ? bestCluster.medianContrast
        : 0,

      horizontalCoverage: bestCluster
        ? bestCluster.horizontalCoverage
        : 0,

      colorSelectionFallback: !bestCluster,
       whiteBackgroundDiagnostics,
    };
  } catch (error) {
    // Color sampling must never prevent OCR text blocks from being created.
    console.warn(
      "[Paddle Adapter] Original text color sampling failed; using black fallback:",
      error
    );

    return {
      color: DEFAULT_ORIGINAL_TEXT_COLOR,
      confidence: 0,
      sampleCount: 0,
      source: "fallback",
    };
  }
}


/* =========================================================
   INITIAL TEXT STYLE
   ========================================================= */

function estimateInitialStyle(text, bounds) {
  const fontSize = estimateFontSizeFromTextBlock({
    text,
    targetWidth: bounds.width,
    targetHeight: bounds.height,
    fontFamily: "Arial, sans-serif",
    fontWeight: 400,
    fontStyle: "normal",
  });

  return {
    fontSize: Number.isFinite(Number(fontSize))
      ? Math.max(1, Number(fontSize))
      : Math.max(1, bounds.height * 0.82),

    fontFamily: "Arial, sans-serif",
    fontWeight: 400,
    fontStyle: "normal",
    color: "#000000",

    styleSource: "estimated",
  };
}
/* =========================================================
   DOCUMENT-LEVEL TYPOGRAPHY GROUPING
   ========================================================= */

function getTypographyGroup(text) {
  const normalized = String(text || "").trim();

/*
 * Section headings:
 * Include short uppercase labels and abbreviations such as IBM
 * when they appear in the document's heading group.
 */
  if (
  normalized.length >= 2 &&
    normalized.length <= 12 &&
    /^[A-Z][A-Z0-9 &().,'’/-]+$/.test(normalized)
  ) {
    return "uppercase-section-headings";
  }

  /*
   * Body paragraphs with recognizable bullet markers.
   */
  if (/^[•●▪◦‣*-]\s*/u.test(normalized)) {
    return "bullet-paragraphs";
  }

  return null;
}

function logTypographyGroupMatches(records) {
  const groups = new Map();

 

  function median(values) {
    if (!values.length) {
      return 0;
    }

    const sorted = [...values].sort(
      (a, b) => a - b
    );

    const middle = Math.floor(
      sorted.length / 2
    );

    return sorted.length % 2
      ? sorted[middle]
      : (
          sorted[middle - 1] +
          sorted[middle]
        ) / 2;
  }

  for (const record of records) {
    const groupName = getTypographyGroup(
      record.text
    );

    if (!groupName) {
      continue;
    }

    const candidates =
      record.estimate?.familyCandidates;

    if (!Array.isArray(candidates)) {
      continue;
    }

    if (!groups.has(groupName)) {
      groups.set(groupName, []);
    }

    groups.get(groupName).push(record);
  }

  for (const [groupName, groupRecords] of groups) {
    if (groupRecords.length < 2) {
      continue;
    }

    const pairScores = new Map();

    /*
     * Build the best family/style candidate for every line.
     */
    const perLineResults = groupRecords.map(
      (record) => {
        const linePairs = new Map();

        for (const candidate of record.estimate.familyCandidates) {
          

const key =
  `${candidate.family}|${candidate.style}|${candidate.weight}`;
          const previous = linePairs.get(key);

          if (
            !previous ||
            candidate.score > previous.score
          ) {
            linePairs.set(key, candidate);
          }
        }

        const candidates = [
          ...linePairs.values(),
        ];

        const lineBestScore = candidates.length
          ? Math.max(
              ...candidates.map(
                (candidate) => candidate.score
              )
            )
          : 0;

        return {
          text: record.text,
          candidates,
          lineBestScore,
        };
      }
    );

    /*
     * Accumulate shared family/style scores.
     */
    for (const line of perLineResults) {
      for (const candidate of line.candidates) {
      
const key =
  `${candidate.family}|${candidate.style}|${candidate.weight}`;

        if (!pairScores.has(key)) {
          pairScores.set(key, {
            family: candidate.family,
            source: candidate.source,
            category: candidate.category || null,
            style: candidate.style,

            scoreSum: 0,
            relativeScoreSum: 0,

            coverage: 0,

            weights: [],
            widthRatios: [],

            lines: [],
          });
        }

        const stats = pairScores.get(key);

        const relativeScore =
          line.lineBestScore > 0
            ? candidate.score / line.lineBestScore
            : 0;

        stats.scoreSum += candidate.score;

        stats.relativeScoreSum += relativeScore;

        stats.coverage++;

        stats.weights.push(candidate.weight);

        if (
          Number.isFinite(candidate.widthRatio) &&
          candidate.widthRatio > 0
        ) {
          stats.widthRatios.push(
            candidate.widthRatio
          );
        }

     stats.lines.push({
  text: line.text,

  score: candidate.score,

  relativeScore,

  weight: candidate.weight,

  widthRatio: candidate.widthRatio,

  textScaleX: candidate.textScaleX,

  tolerantF1: candidate.tolerantF1,

  exactF1: candidate.exactF1,

  rowProfileScore: candidate.rowProfileScore,

  columnProfileScore: candidate.columnProfileScore,
});

      }
    }

    /*
     * Rank candidates using:
     *
     * 1. Average similarity across document lines.
     * 2. How close each candidate is to each line's own
     *    strongest candidate.
     * 3. Consistency of natural width across lines.
     * 4. Coverage across the entire group.
     */
    const ranked = [...pairScores.values()]
      .map((item) => {
        const groupCount = groupRecords.length;

        const meanScore =
          item.scoreSum / groupCount;

        const meanRelativeScore =
          item.relativeScoreSum / groupCount;

        const coverageRatio =
          item.coverage / groupCount;

        /*
         * Work in log-width space so ratios such as 0.8
         * and 1.25 are treated as comparable deviations.
         */
        const logWidthRatios =
          item.widthRatios.map((ratio) =>
            Math.log(ratio)
          );

        const meanLogWidth = logWidthRatios.length
          ? logWidthRatios.reduce(
              (sum, value) => sum + value,
              0
            ) / logWidthRatios.length
          : 0;

        const widthVariance = logWidthRatios.length
          ? logWidthRatios.reduce(
              (sum, value) =>
                sum +
                Math.pow(value - meanLogWidth, 2),
              0
            ) / logWidthRatios.length
          : 0;

        const widthRatioSpread =
          Math.sqrt(widthVariance);

        const medianWidthRatio = median(
          item.widthRatios
        );

        /*
         * Penalize inconsistent natural width across lines.
         * This is a consistency adjustment, not a probability.
         */
        const widthConsistency = Math.exp(
          -0.8 * widthRatioSpread
        );

/*
 * Combine absolute glyph similarity with relative ranking.
 *
 * Relative ranking is given more importance because a shared
 * font should perform well against each line's own alternatives.
 */
const coverageFactor =
  0.85 + 0.15 * coverageRatio;

const groupScore =
  (
    0.40 * meanScore +
    0.60 * meanRelativeScore
  ) *
  coverageFactor *
  widthConsistency;

        return {
          ...item,

          meanScore,

          meanRelativeScore,

          coverageRatio,

          medianWidthRatio,

          widthRatioSpread,

          widthConsistency,

          groupScore,

          uniqueWeights: [
            ...new Set(item.weights),
          ].sort((a, b) => a - b),
        };
      })
      .sort((a, b) =>
        b.groupScore - a.groupScore
      );

    console.log(
      "[Paddle Typography Group]",
      {
        group: groupName,

        lineCount: groupRecords.length,

        lines: groupRecords.map(
          (record) => record.text
        ),

        bestSharedCandidate: ranked[0]
          ? {
              family: ranked[0].family,

              source: ranked[0].source,

              category: ranked[0].category,

              style: ranked[0].style,

              groupScore: Number(
                ranked[0].groupScore.toFixed(4)
              ),

              meanScore: Number(
                ranked[0].meanScore.toFixed(4)
              ),

              meanRelativeScore: Number(
                ranked[0].meanRelativeScore.toFixed(4)
              ),

              coverage: ranked[0].coverage,

              widthConsistency: Number(
                ranked[0].widthConsistency.toFixed(4)
              ),

              medianWidthRatio: Number(
                ranked[0].medianWidthRatio.toFixed(4)
              ),

              widthRatioSpread: Number(
                ranked[0].widthRatioSpread.toFixed(4)
              ),

              uniqueWeights:
                ranked[0].uniqueWeights,
            }
          : null,

        topSharedCandidates: ranked
          .slice(0, 5)
          .map((candidate) => ({
            family: candidate.family,

            source: candidate.source,

            category: candidate.category,

            style: candidate.style,

            groupScore: Number(
              candidate.groupScore.toFixed(4)
            ),

            meanScore: Number(
              candidate.meanScore.toFixed(4)
            ),

            meanRelativeScore: Number(
              candidate.meanRelativeScore.toFixed(4)
            ),

            coverage: candidate.coverage,

            widthConsistency: Number(
              candidate.widthConsistency.toFixed(4)
            ),

            medianWidthRatio: Number(
              candidate.medianWidthRatio.toFixed(4)
            ),

            widthRatioSpread: Number(
              candidate.widthRatioSpread.toFixed(4)
            ),

            uniqueWeights:
              candidate.uniqueWeights,

perLineMatches: candidate.lines.map((line) => ({
  text: line.text,

  score: Number(line.score.toFixed(4)),

  relativeScore: Number(
    line.relativeScore.toFixed(4)
  ),

tolerantF1: Number(
  line.tolerantF1.toFixed(4)
),

exactF1: Number(
  line.exactF1.toFixed(4)
),

rowProfileScore: Number(
  line.rowProfileScore.toFixed(4)
),

columnProfileScore: Number(
  line.columnProfileScore.toFixed(4)
),

  weight: line.weight,

  widthRatio: Number(
    line.widthRatio.toFixed(4)
  ),

  textScaleX: Number(
    line.textScaleX.toFixed(4)
  ),
})),

          })),

        perLineMatches: ranked[0]?.lines || [],
      }
    );
  }
}


function showPaddleGlyphMaskContactSheet(label, glyphs) {
  if (
    typeof document === "undefined" ||
    !Array.isArray(glyphs) ||
    !glyphs.length
  ) {
    return;
  }

  const panelId = "paddle-glyph-mask-debug-panel";

  let panel = document.getElementById(panelId);

  if (!panel) {
    panel = document.createElement("div");
    panel.id = panelId;

    panel.style.cssText = `
      position: fixed;
      inset: 12px;
      z-index: 2147483647;
      overflow: auto;
      padding: 16px;
      background: #f2f2f2;
      color: #111;
      border: 2px solid #555;
      box-shadow: 0 4px 24px rgba(0,0,0,.35);
      font-family: Arial, sans-serif;
    `;

    const header = document.createElement("div");

    header.style.cssText = `
      position: sticky;
      top: 0;
      z-index: 2;
      padding: 10px;
      background: #fff;
      border-bottom: 1px solid #aaa;
      display: flex;
      justify-content: space-between;
      align-items: center;
    `;

    const title = document.createElement("strong");
    title.textContent = "Original OCR Glyph Masks";

    const closeButton = document.createElement("button");
    closeButton.textContent = "Close Preview";

    closeButton.style.cssText = `
      padding: 8px 14px;
      cursor: pointer;
    `;

    closeButton.onclick = () => panel.remove();

    header.append(title, closeButton);
    panel.appendChild(header);
    document.body.appendChild(panel);
  }

  const section = document.createElement("section");

  section.style.cssText = `
    margin: 18px 0;
    padding: 12px;
    background: #fff;
    border: 1px solid #ccc;
    overflow-x: auto;
  `;

  const heading = document.createElement("h3");
  heading.textContent = label;

  const columns = 12;
  const scale = 5;
  const padding = 8;
  const labelHeight = 22;

  const maxWidth = Math.max(
    1,
    ...glyphs.map(g => g.width || 0)
  );

  const maxHeight = Math.max(
    1,
    ...glyphs.map(g => g.height || 0)
  );

  const cellWidth = maxWidth * scale + padding * 2;
  const cellHeight =
    maxHeight * scale + labelHeight + padding;

  const actualColumns = Math.min(columns, glyphs.length);

  const rows = Math.ceil(
    glyphs.length / actualColumns
  );

  const canvas = document.createElement("canvas");

  canvas.width = actualColumns * cellWidth;
  canvas.height = rows * cellHeight;

  canvas.style.cssText = `
    display: block;
    max-width: none;
    image-rendering: pixelated;
  `;

  const ctx = canvas.getContext("2d");

  if (!ctx) return;

  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  glyphs.forEach((glyph, i) => {
    const col = i % actualColumns;
    const row = Math.floor(i / actualColumns);

    const cellX = col * cellWidth;
    const cellY = row * cellHeight;

    const width = Number(glyph.width);
    const height = Number(glyph.height);
    const mask = glyph.mask;

    ctx.strokeStyle = "#ccc";
    ctx.strokeRect(
      cellX,
      cellY,
      cellWidth,
      cellHeight
    );

    ctx.fillStyle = "#333";
    ctx.font = "11px Arial";

    ctx.fillText(
      `${glyph.index} "${glyph.text}" ${width}x${height}`,
      cellX + 4,
      cellY + 14
    );

    if (
      !mask ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      mask.length < width * height
    ) {
      return;
    }

    const offsetX =
      cellX + padding +
      Math.floor((maxWidth - width) * scale / 2);

    const offsetY = cellY + labelHeight;

    ctx.fillStyle = "#111";

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (mask[y * width + x]) {
          ctx.fillRect(
            offsetX + x * scale,
            offsetY + y * scale,
            scale,
            scale
          );
        }
      }
    }
  });

  section.append(heading, canvas);
  panel.appendChild(section);
}


/**
 * Run typography analysis after editable text blocks exist.
 *
 * This pass does not change block.style or document state.
 * It only logs and returns diagnostic information.
 */
async function runTypographyDiagnostics(records) {

  const results = [];

console.log(
  "[Paddle Typography] Starting asynchronous document analysis:",
  {
    lineCount: records.length,
    fontLoadingStrategy: "per-line OCR text",
  }
);

  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    let estimate;

    try {
 
estimate = await estimateTypographyCandidates({
  raster: record.raster,

  text: record.text,

  inkBounds: record.inkBounds,

  backgroundColor: record.backgroundColor,

  characterMeasurements:
    record.characterMeasurements,

 ocrScaleX:
  record.ocrScaleX || 1,

ocrScaleY:
  record.ocrScaleY || 1,
});


    } catch (error) {
      estimate = {
        status: "error",
        error: error?.message || String(error),
        best: null,
        familyCandidates: [],
      };
    }

    results.push({
      text: record.text,
      estimate,
    });

/*
 * TEMPORARY GLYPH EXTRACTION TEST
 *
 * Only print the three diagnostic lines.
 * This avoids flooding the console with every OCR line.
 */
const shouldLogGlyphExtraction =
  record.text === "IBM" ||
  record.text.startsWith(
    "• Monitoring and managing supplier performance"
  ) ||
  record.text.startsWith(
    "• Conducting cost analysis"
  );

if (shouldLogGlyphExtraction) {
 
const shapeMeasurement = record.characterMeasurements;

const shapeCharacters = Array.isArray(
  shapeMeasurement?.characters
)
  ? shapeMeasurement.characters
  : [];

const shapeDiagnosticRows = shapeCharacters
  .filter(character => !/^\s+$/u.test(
    String(character.text ?? "")
  ))
  .map(character => {
    const shape = character.originalGlyphShape;

    return {
      index: character.index,
      text: character.text,

      measurementStatus: character.status,

      shapeStatus: shape?.status || "missing",

      error: shape?.message || null,

      cellLeft: shape?.cellBounds?.left ?? null,
      cellRight: shape?.cellBounds?.right ?? null,

      pixelLeft: shape?.cellBounds?.pixelLeft ?? null,
      pixelRight: shape?.cellBounds?.pixelRightExclusive ?? null,

      width: shape?.width ?? null,
      height: shape?.height ?? null,

      pixelCount: shape?.pixelCount ?? null,

      contourCount: shape?.contourCount ?? null,
    };
  });

const shapeStatusCounts = shapeDiagnosticRows.reduce(
  (counts, item) => {
    counts[item.shapeStatus] =
      (counts[item.shapeStatus] || 0) + 1;

    return counts;
  },
  {}
);

console.groupCollapsed(
  "[Paddle Original Glyph Shape Extraction]",
  record.text
);

console.log(
  "Extraction summary:",
  shapeMeasurement?.originalGlyphShapeSummary || null
);

console.log(
  "Per-character status counts:",
  shapeStatusCounts
);

console.table(shapeDiagnosticRows);

const shapeFailures = shapeDiagnosticRows.filter(
  item => item.shapeStatus !== "complete"
);

if (shapeFailures.length) {
  console.error(
    "[Paddle Original Glyph Shape Failures]",
    shapeFailures
  );
}

console.groupEnd();
// 1. Create the original glyph contact sheet.
showOriginalGlyphShapeContactSheet(
  record.text,
  shapeMeasurement
);

// 2. Append grayscale diagnostics while the shared panel exists.
showGrayscaleGlyphDiagnostics(
  record.text,
  record.characterMeasurements
);

// 3. Render the separate vector preview afterward.
showGlyphVectorPreview(
  record.text,
  shapeMeasurement
);

  const extraction = estimate.glyphExtraction || {};

const {
  glyphs,

  componentRunGlyphs = [],
  componentRunDiagnostics = null,

  spatialRunGlyphs = [],
  spatialRunDiagnostics = null,

  // NEW: Boundary-fragment candidate.
  boundaryFragmentGlyphs = [],
  boundaryFragmentDiagnostics = null,

  ...extractionDiagnostics
} = extraction;

showPaddleGlyphMaskContactSheet(
  record.text,
  glyphs
);

const previewText = String(
  record.text ?? ""
).trim();

const shouldPreviewComponentRuns =
  previewText === "IBM" ||
  /Monitoring and managing supplier performance/i.test(
    previewText
  ) ||
  /Conducting market research and analysis/i.test(
    previewText
  ) ||
  /Conducting cost analysis/i.test(
    previewText
  );

if (shouldPreviewComponentRuns) {
  console.log(
    "[Paddle Component-Run Mask Diagnostics]",
    previewText,
    componentRunDiagnostics
  );

  showPaddleGlyphMaskContactSheet(
    `${previewText} — component ownership candidate`,
    componentRunGlyphs
  );


// ================================================
// SPATIAL ASSOCIATION DIAGNOSTICS
// ================================================

const spatialCharacters =
  spatialRunDiagnostics?.characters ?? [];

console.log(
  "[Paddle Spatial Association Diagnostics]",
  previewText,
  spatialRunDiagnostics
);

// Display the overall character-level diagnostics.
console.table(spatialCharacters);

// Display individual component decisions for each character.
for (const spatialGlyph of spatialCharacters) {

  // Do not silently interpret missing diagnostics as zero decisions.
  if (!Array.isArray(spatialGlyph.componentDecisions)) {
    console.warn(
      "[Paddle Decision Diagnostics Missing]",
      {
        character: spatialGlyph.text,
        index: spatialGlyph.index,

        message:
          "componentDecisions is missing from spatialRunDiagnostics.characters",
      }
    );

    continue;
  }

  const decisions = spatialGlyph.componentDecisions;

  const accepted = decisions.filter(
    item => item.decision === "accepted"
  );

  const rejected = decisions.filter(
    item => item.decision === "rejected"
  );

  const unknown = decisions.filter(
    item =>
      item.decision !== "accepted" &&
      item.decision !== "rejected"
  );

  const expectedAccepted = Number(
    spatialGlyph.acceptedComponentCount
  );

  const expectedRejected = Number(
    spatialGlyph.rejectedComponentCount
  );

  const expectedTotal = Number(
    spatialGlyph.totalComponentCount
  );

  console.groupCollapsed(
    `[Paddle Component Decisions] Character: ${
      spatialGlyph.text
    } | Index: ${spatialGlyph.index}`
  );

  console.table(decisions);

  console.log("[Paddle Decision Integrity]", {

    character: spatialGlyph.text,
    index: spatialGlyph.index,

    accepted: accepted.length,
    rejected: rejected.length,
    unknown: unknown.length,

    decisionCount: decisions.length,

    expectedAccepted,
    expectedRejected,
    expectedTotal,

    // Compare actual decisions with the matcher's counters.
    acceptedCountMatches:
      Number.isFinite(expectedAccepted) &&
      accepted.length === expectedAccepted,

    rejectedCountMatches:
      Number.isFinite(expectedRejected) &&
      rejected.length === expectedRejected,

    // Check whether every OpenCV component received a decision.
    allComponentsAccountedFor:
      Number.isFinite(expectedTotal)
        ? decisions.length === expectedTotal
        : null,

    noUnknownDecisions: unknown.length === 0,

    reasons: decisions.reduce((result, item) => {
      const key = `${item.decision}: ${item.reason}`;

      result[key] = (result[key] || 0) + 1;

      return result;
    }, {}),
  });

  console.groupEnd();
}

// Display the spatially associated candidate masks.
showPaddleGlyphMaskContactSheet(
  `${previewText} — spatially associated candidate`,
  spatialRunGlyphs
);

// ================================================
// SPATIAL + BOUNDARY-FRAGMENT CANDIDATE PREVIEW
// ================================================

console.log(
  "[Paddle Boundary Fragment Diagnostics]",
  previewText,
  {
    diagnostics: boundaryFragmentDiagnostics,

    glyphCount: boundaryFragmentGlyphs.length,

    affectedGlyphs: boundaryFragmentGlyphs
      .filter(
        glyph =>
          Number(glyph.boundaryFragmentPixels) > 0
      )
      .map(glyph => ({
        index: glyph.index,
        text: glyph.text,
        originalSpatialPixels:
          glyph.pixelCount -
          glyph.boundaryFragmentPixels,
        boundaryFragmentPixels:
          glyph.boundaryFragmentPixels,
        combinedPixelCount: glyph.pixelCount,
      })),
  }
);

if (boundaryFragmentGlyphs.length > 0) {
  showPaddleGlyphMaskContactSheet(
    `${previewText} — spatial + boundary fragments candidate`,
    boundaryFragmentGlyphs
  );
} else {
  console.warn(
    "[Paddle Boundary Fragment Preview] No glyph masks received",
    {
      text: previewText,
      boundaryFragmentDiagnostics,
    }
  );
}

}

  console.log(
    "[Paddle Typography Glyph Extraction]",
    {
      text: record.text,

      ...extractionDiagnostics,

      glyphMaskCount: glyphs?.length || 0,
    }
  );
}



    console.log("[Paddle Typography Match]", {
      text: record.text,

      status: estimate.status,

      method: estimate.method,

      matchScore: estimate.matchScore,

      familyMargin: estimate.familyMargin,

      familyAmbiguous: estimate.familyAmbiguous,

      best: estimate.best,

      topCandidates: estimate.topCandidates,

      topFamilies: estimate.topFamilies,

      candidateCount: estimate.candidateCount,

      catalogFamilyCount: estimate.catalogFamilyCount,

      googleCandidateCount: estimate.googleCandidateCount,

      googleLoadedFamilyCount:
        estimate.googleLoadedFamilyCount,

      googleLoadFailures: estimate.googleLoadFailures,
    });

    /*
     * Yield between lines so that the browser can process
     * rendering and user-interface updates.
     */
    await new Promise((resolve) =>
      setTimeout(resolve, 0)
    );
  }

  // Run document-level comparisons only after all line
  // candidates have been collected.
  logTypographyGroupMatches(results);

  const matchedLines = results.filter(
    (record) =>
      record.estimate?.status === "candidate-match"
  ).length;

  const failedLines = results.length - matchedLines;

  const report = {
    status: "complete",

    totalLines: results.length,

    matchedLines,

    failedLines,

    results,
  };

  console.log(
    "[Paddle Typography] Document analysis completed:",
    {
      totalLines: report.totalLines,
      matchedLines: report.matchedLines,
      failedLines: report.failedLines,
    }
  );

  return report;
}

/* =========================================================
   CREATE ONE EDITABLE TEXT BLOCK
   ========================================================= */

function createPaddleTextBlock({
  item,
  page,
  originalRaster,
  typographyDiagnostics,
  scaleX,
  scaleY,
  sourceWidth,
  sourceHeight,
}) {
  const text = String(item.text ?? "");

  if (!text.trim()) {
    return null;
  }

  const imageOCRBounds = normalizeRect(
    item.ocrBounds
  );

  const imageInkBounds = normalizeRect(
    item.inkBounds
  );

  // Use PaddleOCR's full line rectangle as the primary
  // editable geometry. It retains useful vertical padding.
  const sourceBounds = imageRectToSource(
    imageOCRBounds || imageInkBounds,
    scaleX,
    scaleY,
    sourceWidth,
    sourceHeight
  );

  if (!sourceBounds) {
    return null;
  }

  const confidence = normalizeConfidence(item.score);

  const characterMeasurements =
    adaptCharacterMeasurements(
      item.characterMeasurements,
      scaleX,
      scaleY,
      sourceWidth,
      sourceHeight
    );

  const wordSegmentation =
    adaptWordSegmentation(
      item.wordSegmentation,
      scaleX,
      scaleY,
      sourceWidth,
      sourceHeight
    );

  const words = wordSegmentation?.words || [];

/*
 * TEMPORARY TYPOGRAPHY GEOMETRY DIAGNOSTIC
 *
 * Inspect the actual OpenCV character records before
 * implementing character-level font comparison.
 */
const typographyGeometryDebug =
  text === "IBM" ||
  text.startsWith("• Monitoring and managing supplier performance") ||
  text.startsWith("• Conducting cost analysis");

if (typographyGeometryDebug) {
  console.log(
    "[Paddle Typography Character Geometry]",
    {
      text,

      measurementStatus:
        characterMeasurements?.status || null,

      coordinateSpace:
        characterMeasurements?.coordinateSpace || null,

      characterCount:
        characterMeasurements?.characters?.length || 0,

      characterSamples:
        characterMeasurements?.characters?.slice(0, 12) || [],

      wordSamples:
        wordSegmentation?.words?.slice(0, 5) || [],
    }
  );
}


  const sourcePolygon = imagePolygonToSource(
    item.points,
    scaleX,
    scaleY
  );

  const sourceInkBounds = imageInkBounds
    ? imageRectToSource(
        imageInkBounds,
        scaleX,
        scaleY,
        sourceWidth,
        sourceHeight
      )
    : null;

  const sourceOCRBounds = imageOCRBounds
    ? imageRectToSource(
        imageOCRBounds,
        scaleX,
        scaleY,
        sourceWidth,
        sourceHeight
      )
    : null;

  const style = estimateInitialStyle(
    text,
    sourceBounds
  );

  // Prefer OpenCV's measured visible-ink bounds. Fall back to the
  // PaddleOCR line box when no reliable ink rectangle is available.
  const colorEstimate = sampleOriginalTextColor(
    originalRaster,
    sourceInkBounds || sourceBounds
  );

  /*
   * Queue typography diagnostics for the asynchronous pass.
   *
   * The OCR block is created immediately. Google Fonts are
   * loaded later, without delaying OCR or changing its style.
   */
  if (Array.isArray(typographyDiagnostics)) {
  typographyDiagnostics.push({
  text,

  raster: originalRaster,

  inkBounds:
    sourceInkBounds || sourceBounds,

  backgroundColor:
    colorEstimate.backgroundColor || "#ffffff",

  // Original OpenCV character geometry.
  characterMeasurements,

  // OCR-image pixels per page-source unit.
ocrScaleX: scaleX,
ocrScaleY: scaleY,

});
  }

  style.color = colorEstimate.color;
  style.colorSource = colorEstimate.source;
  style.colorConfidence = colorEstimate.confidence;
  style.colorSampleCount = colorEstimate.sampleCount;

  // Keep this diagnostic during color-matching tests. It runs
  // once per OCR text block, before the user starts editing.
  console.log("[Paddle Color Match]", {
    text,
    detectedColor: colorEstimate.color,
    backgroundColor: colorEstimate.backgroundColor || null,
    source: colorEstimate.source,
    confidence: Number(
      (Number(colorEstimate.confidence) || 0).toFixed(3)
    ),
    sampleCount: colorEstimate.sampleCount,
    foregroundCount: colorEstimate.foregroundCount || 0,
    coreCount: colorEstimate.coreCount || 0,
    dominantClusterCount: colorEstimate.dominantClusterCount || 0,
    selectedSampleCount: colorEstimate.selectedSampleCount || 0,
    clusterPurity: Number(
      (Number(colorEstimate.clusterPurity) || 0).toFixed(3)
    ),
    sampleReliability: Number(
      (Number(colorEstimate.sampleReliability) || 0).toFixed(3)
    ),
colorSelectionMethod:
  colorEstimate.colorSelectionMethod || "balanced-rgb-cluster",

    inkBounds: sourceInkBounds,
    ocrBounds: sourceOCRBounds,
    characterCount:
      characterMeasurements?.characters?.length || 0,
  });

  return {
    id: createId("text"),

    type: "text",

    text,
    originalText: text,
    modified: false,

    x: sourceBounds.x,
    y: sourceBounds.y,
    width: sourceBounds.width,
    height: sourceBounds.height,

    bounds: { ...sourceBounds },

    confidence,

    // PaddleOCR + OpenCV provenance.
    origin: "ocr-engine",
    source: "ocr",
    ocrProvider: "paddleocr",

    editable: true,

    // Keep detailed recognition geometry.
    paddleGeometry: {
      imagePolygon: item.points,
      polygon: sourcePolygon,

      imageOCRBounds,
      ocrBounds: sourceOCRBounds,

      imageInkBounds,
      inkBounds: sourceInkBounds,

      recognition: item.geometry
        ? { ...item.geometry }
        : null,

      crop: item.cropGeometry
        ? { ...item.cropGeometry }
        : null,

      coordinateSpace: "page-source",
    },

    // Individual OpenCV character polygons and diagnostics.
    characterMeasurements,

    // OpenCV word segmentation with source-coordinate bounds.
    wordSegmentation,

    words: words.map((word) => ({
      id: createId("ocr-word"),
      text: word.text,
      bounds: { ...word.bounds },
      confidence,
      polygon: word.polygon,
    })),

    measurementStatus:
      item.characterMeasurements?.status || "missing",

    characterMeasurementError:
      item.characterMeasurementError || null,

    ocrError:
      item.errorMessage || null,

    style,
  };
}


/* =========================================================
   PUBLIC ADAPTER API
   ========================================================= */

/**
 * Convert PaddleOCR + OpenCV pipeline results into
 * the existing application's editable text-block model.
 *
 * Usage:
 *
 * const adapted = buildPaddleTextBlocks({
 *   result,
 *   page,
 *   renderedPage,
 * });
 *
 * page.textBlocks.push(...adapted.textBlocks);
 */
export function buildPaddleTextBlocks({
  result,
  page,
  renderedPage,
} = {}) {
  const dimensions = validateArguments({
    result,
    page,
    renderedPage,
  });

  const {
    sourceWidth,
    sourceHeight,
    scaleX,
    scaleY,
  } = dimensions;

const textBlocks = [];
const skippedLines = [];

const typographyDiagnostics = [];
  // Sample from the untouched original image, before any text repair patches.
  const originalRaster = getOriginalPageRaster(
    renderedPage,
    page
  );

  for (const item of result.items) {
    try {
    const block = createPaddleTextBlock({
  item,
  page,
  originalRaster,
  typographyDiagnostics,
  scaleX,
        scaleY,
        sourceWidth,
        sourceHeight,
      });

      if (!block) {
        skippedLines.push({
          index: item.index,
          text: item.text,
          reason: "Empty text or invalid line bounds.",
        });

        continue;
      }

      textBlocks.push(block);

    } catch (error) {
      skippedLines.push({
        index: item.index,
        text: item.text,
        reason: error.message,
      });
    }
  }

/*
 * Start typography analysis after all OCR blocks have been
 * created. Do not await it here: the adapter's existing
 * synchronous return behavior is preserved.
 */
const typographyReady = runTypographyDiagnostics(
  typographyDiagnostics
).catch((error) => {
  console.warn(
    "[Paddle Typography] Document analysis failed:",
    error
  );

  return {
    status: "failed",
    error: error?.message || String(error),
    results: [],
  };
});


  const measuredLines = textBlocks.filter(
    (block) => block.measurementStatus === "measured"
  ).length;

  const totalCharacters = textBlocks.reduce(
    (sum, block) =>
      sum +
      (block.characterMeasurements?.characters?.length || 0),
    0
  );

  return {
    pageId: page.id,

    textBlocks,

    totalLines: result.items.length,
    createdLines: textBlocks.length,
    skippedLines,

    measuredLines,
    totalCharacterRecords: totalCharacters,

    sourceWidth,
    sourceHeight,

    coordinateScale: {
      x: scaleX,
      y: scaleY,
    },

   typographyReady,

  };
}
