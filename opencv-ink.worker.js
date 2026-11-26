
/*
 * public/workers/opencv-ink.worker.js
 *
 * OpenCV visible-ink measurement worker.
 *
 * Receives:
 *   - Transferred ImageBitmap
 *   - OCR bounding boxes
 *
 * Returns:
 *   - Individual ink measurements
 *   - Progress messages
 *
 * Uses the same measurement algorithm as src/editor/opencv-ink.js.
 */

let cvRuntime = null;
let cvLoadError = null;

/* -------------------------------------------------------
   1. Initialize OpenCV.js inside this worker
------------------------------------------------------- */

function send(type, message, extra = {}) {
  self.postMessage({
    type,
    message,
    ...extra,
  });
}


function loadOpenCV() {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;

    function finishSuccessfully(cv) {
      if (settled) return;

      if (
        !cv?.Mat ||
        !cv?.cvtColor ||
        !cv?.adaptiveThreshold
      ) {
        settled = true;

        if (timeout) clearTimeout(timeout);

        reject(
          new Error(
            "OpenCV initialized without required functions."
          )
        );

        return;
      }

      // Keep the actual OpenCV object outside the Promise.
      cvRuntime = cv;

      settled = true;

      if (timeout) clearTimeout(timeout);

      // IMPORTANT: Resolve with a boolean, NOT the cv object.
      resolve(true);
    }

    try {
      importScripts("/vendor/opencv.js");

importScripts("/workers/original-glyph-shape-extractor.js");

if (
  typeof self.OriginalGlyphShapeExtractor?.extractCharacterGlyphShapes !==
    "function" ||
  typeof self.OriginalGlyphShapeExtractor?.attachCharacterAppearanceCrops !==
    "function"
) {
  throw new Error(
    "Original Glyph Shape Extractor or appearance-crop helper did not load in the OpenCV worker."
  );
}

      const cv = self.cv;

      if (!cv) {
        throw new Error(
          "OpenCV did not create self.cv."
        );
      }

      // Handle an already initialized runtime.
      if (
        cv.Mat &&
        cv.cvtColor &&
        cv.adaptiveThreshold
      ) {
        finishSuccessfully(cv);
        return;
      }

      timeout = setTimeout(() => {
        if (settled) return;

        settled = true;

        reject(
          new Error(
            "OpenCV WebAssembly initialization timed out after 180 seconds."
          )
        );
      }, 180000);

      const previousInitialized =
        cv.onRuntimeInitialized;

      const previousAbort = cv.onAbort;

      cv.onRuntimeInitialized = (...args) => {
        try {
          if (typeof previousInitialized === "function") {
            previousInitialized.apply(cv, args);
          }
        } catch (error) {
          console.warn(
            "Previous OpenCV initialization callback failed:",
            error
          );
        }

        finishSuccessfully(cv);
      };

      cv.onAbort = (reason) => {
        if (settled) return;

        settled = true;

        if (timeout) clearTimeout(timeout);

        reject(
          new Error(
            "OpenCV runtime aborted: " + String(reason)
          )
        );

        if (typeof previousAbort === "function") {
          try {
            previousAbort.call(cv, reason);
          } catch (error) {
            console.warn(
              "Previous OpenCV abort callback failed:",
              error
            );
          }
        }
      };

      // Check again after installing the callback.
      if (
        cv.Mat &&
        cv.cvtColor &&
        cv.adaptiveThreshold
      ) {
        finishSuccessfully(cv);
      }

    } catch (error) {
      if (settled) return;

      settled = true;

      if (timeout) clearTimeout(timeout);

      reject(error);
    }
  });
}

const cvReadyPromise = loadOpenCV()
  .then(() => {
    const cv = cvRuntime;

    send(
      "ready",
      "OpenCV initialized successfully inside the measurement worker.",
      {
       details: {
  workerType: "classic",
  runtime: "WebAssembly",

  // Existing measurement capabilities.
  matAvailable: typeof cv.Mat === "function",

  adaptiveThresholdAvailable:
    typeof cv.adaptiveThreshold === "function",

  connectedComponentsAvailable:
    typeof cv.connectedComponentsWithStats === "function",

  countNonZeroAvailable:
    typeof cv.countNonZero === "function",

  // Background inpainting capabilities.
  inpaintAvailable:
    typeof cv.inpaint === "function",

  inpaintTelea:
    Number.isFinite(cv.INPAINT_TELEA)
      ? cv.INPAINT_TELEA
      : null,

  inpaintNavierStokes:
    Number.isFinite(cv.INPAINT_NS)
      ? cv.INPAINT_NS
      : null,
},
      }
    );

    // IMPORTANT: Never return cv from this Promise.
    return true;
  })
  .catch((error) => {
    cvLoadError =
      error?.stack ||
      error?.message ||
      String(error);

    send("error", cvLoadError);

    return false;
  });


/* -------------------------------------------------------
   2. Utility functions
------------------------------------------------------- */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getImageDimensions(imageSource) {
  return {
    width: Number(
      imageSource?.naturalWidth ||
      imageSource?.videoWidth ||
      imageSource?.width
    ),

    height: Number(
      imageSource?.naturalHeight ||
      imageSource?.videoHeight ||
      imageSource?.height
    ),
  };
}


/* -------------------------------------------------------
   3. Measure visible ink in one OCR rectangle
------------------------------------------------------- */

async function detectInkBoundsOpenCV(
  imageSource,
  bounds,
  options = {},
  cv
) {
  if (!imageSource || !bounds) {
    return null;
  }

  const imageDimensions =
    getImageDimensions(imageSource);

  const imageWidth = imageDimensions.width;
  const imageHeight = imageDimensions.height;

  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);

  if (
    ![
      imageWidth,
      imageHeight,
      x,
      y,
      width,
      height,
    ].every(Number.isFinite) ||
    imageWidth < 1 ||
    imageHeight < 1 ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  if (
    Math.min(width, height) < 2 ||
    x + width <= 0 ||
    y + height <= 0 ||
    x >= imageWidth ||
    y >= imageHeight
  ) {
    return null;
  }

  const padding = clamp(
    Math.round(Number(options.padding ?? 4)),
    1,
    20
  );

  // Add a small background ring around the OCR box.
  const cropLeft = clamp(
    Math.floor(x) - padding,
    0,
    imageWidth - 1
  );

  const cropTop = clamp(
    Math.floor(y) - padding,
    0,
    imageHeight - 1
  );

  const cropRight = clamp(
    Math.ceil(x + width) + padding,
    cropLeft + 1,
    imageWidth
  );

  const cropBottom = clamp(
    Math.ceil(y + height) + padding,
    cropTop + 1,
    imageHeight
  );

  const cropWidth = cropRight - cropLeft;
  const cropHeight = cropBottom - cropTop;

  // Exact OCR rectangle inside the padded crop.
  const boxLeft = clamp(
    Math.floor(x) - cropLeft,
    0,
    cropWidth - 1
  );

  const boxTop = clamp(
    Math.floor(y) - cropTop,
    0,
    cropHeight - 1
  );

  const boxRight = clamp(
    Math.ceil(x + width) - cropLeft,
    boxLeft + 1,
    cropWidth
  );

  const boxBottom = clamp(
    Math.ceil(y + height) - cropTop,
    boxTop + 1,
    cropHeight
  );

  const boxWidth = boxRight - boxLeft;
  const boxHeight = boxBottom - boxTop;

  /*
   * Workers have no document.createElement().
   * OffscreenCanvas provides the same 2D crop operation.
   */
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error(
      "OffscreenCanvas is not supported in this browser worker."
    );
  }

  const cropCanvas = new OffscreenCanvas(
    cropWidth,
    cropHeight
  );

  const context = cropCanvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!context) {
    throw new Error(
      "Could not create the OpenCV OffscreenCanvas context."
    );
  }

  context.drawImage(
    imageSource,
    cropLeft,
    cropTop,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight
  );

  let rgba = null;
  let gray = null;
  let invertedGray = null;

  let darkMask = null;
  let lightMask = null;

  let darkROI = null;
  let lightROI = null;
  let selectedROI = null;

  let labels = null;
  let stats = null;
  let centroids = null;

  try {
  // Read pixels directly from OffscreenCanvas.
// Do not use cv.imread() inside the worker because
// it may reference HTMLImageElement or HTMLCanvasElement.

const cropImageData = context.getImageData(
  0,
  0,
  cropWidth,
  cropHeight
);

// Construct the same RGBA image matrix manually.
rgba = new cv.Mat(
  cropHeight,
  cropWidth,
  cv.CV_8UC4
);

// Copy the original RGBA pixel values without
// resizing, filtering, or changing image quality.
rgba.data.set(cropImageData.data);
    gray = new cv.Mat();

    cv.cvtColor(
      rgba,
      gray,
      cv.COLOR_RGBA2GRAY
    );

    invertedGray = new cv.Mat();

    cv.bitwise_not(
      gray,
      invertedGray
    );

    /*
     * Choose an odd adaptive-threshold block size.
     * This is the same calculation as the original.
     */

    const minDimension = Math.min(
      cropWidth,
      cropHeight
    );

    let maximumOddBlock =
      minDimension % 2 === 1
        ? minDimension
        : minDimension - 1;

    if (maximumOddBlock < 3) {
      return null;
    }

    let blockSize =
      Math.round(boxHeight * 0.6);

    if (blockSize % 2 === 0) {
      blockSize += 1;
    }

    blockSize = clamp(
      blockSize,
      3,
      Math.min(31, maximumOddBlock)
    );

    const adaptiveC = Number.isFinite(
      Number(options.adaptiveC)
    )
      ? Number(options.adaptiveC)
      : 5;

    // Candidate 1: dark ink on light background.
    darkMask = new cv.Mat();

    cv.adaptiveThreshold(
      gray,
      darkMask,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      blockSize,
      adaptiveC
    );

    // Candidate 2: light ink on dark background.
    lightMask = new cv.Mat();

    cv.adaptiveThreshold(
      invertedGray,
      lightMask,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      blockSize,
      adaptiveC
    );

    const roiRect = new cv.Rect(
      boxLeft,
      boxTop,
      boxWidth,
      boxHeight
    );

    darkROI = darkMask.roi(roiRect);
    lightROI = lightMask.roi(roiRect);

    const darkPixelCount =
      cv.countNonZero(darkROI);

    const lightPixelCount =
      cv.countNonZero(lightROI);

    const roiPixelCount =
      boxWidth * boxHeight;

    const darkRatio =
      darkPixelCount / roiPixelCount;

    const lightRatio =
      lightPixelCount / roiPixelCount;

    // Preserve original mask-selection logic.
    const useDarkMask =
      darkPixelCount <= lightPixelCount;

    selectedROI = useDarkMask
      ? darkMask.roi(roiRect)
      : lightMask.roi(roiRect);

    const foregroundRatio = useDarkMask
      ? darkRatio
      : lightRatio;

    if (
      foregroundRatio < 0.001 ||
      foregroundRatio > 0.75
    ) {
      return null;
    }

    // Connected-component analysis.
    labels = new cv.Mat();
    stats = new cv.Mat();
    centroids = new cv.Mat();

    const componentCount =
      cv.connectedComponentsWithStats(
        selectedROI,
        labels,
        stats,
        centroids,
        8,
        cv.CV_32S
      );

    const minimumComponentArea = Math.max(
      1,
      Math.round(
        Number(options.minComponentArea ?? 2)
      )
    );

    let minX = boxWidth;
    let minY = boxHeight;
    let maxX = -1;
    let maxY = -1;

    let pixelCount = 0;
    let acceptedComponents = 0;

    for (
      let component = 1;
      component < componentCount;
      component++
    ) {
      const area = stats.intAt(
        component,
        cv.CC_STAT_AREA
      );

      if (
        !Number.isFinite(area) ||
        area < minimumComponentArea
      ) {
        continue;
      }

      const componentX = stats.intAt(
        component,
        cv.CC_STAT_LEFT
      );

      const componentY = stats.intAt(
        component,
        cv.CC_STAT_TOP
      );

      const componentWidth = stats.intAt(
        component,
        cv.CC_STAT_WIDTH
      );

      const componentHeight = stats.intAt(
        component,
        cv.CC_STAT_HEIGHT
      );

      if (
        componentWidth < 1 ||
        componentHeight < 1
      ) {
        continue;
      }

      minX = Math.min(minX, componentX);
      minY = Math.min(minY, componentY);

      maxX = Math.max(
        maxX,
        componentX + componentWidth - 1
      );

      maxY = Math.max(
        maxY,
        componentY + componentHeight - 1
      );

      pixelCount += area;
      acceptedComponents++;
    }

    if (
      acceptedComponents === 0 ||
      maxX < minX ||
      maxY < minY
    ) {
      return null;
    }

    const inkBounds = {
      x: cropLeft + boxLeft + minX,
      y: cropTop + boxTop + minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };

    // Preserve original sanity checks.
    if (
      inkBounds.width > width * 1.5 ||
      inkBounds.height > height * 1.5
    ) {
      return null;
    }

    return {
      ...inkBounds,

      margins: {
        left: Math.max(0, inkBounds.x - x),
        top: Math.max(0, inkBounds.y - y),

        right: Math.max(
          0,
          x + width -
            (inkBounds.x + inkBounds.width)
        ),

        bottom: Math.max(
          0,
          y + height -
            (inkBounds.y + inkBounds.height)
        ),
      },

      pixelCount,
      acceptedComponents,
      foregroundRatio,

      polarity: useDarkMask
        ? "dark-ink"
        : "light-ink",
    };
  } finally {
    // Release all OpenCV WASM allocations.
    for (const mat of [
      selectedROI,
      darkROI,
      lightROI,
      labels,
      stats,
      centroids,
      darkMask,
      lightMask,
      invertedGray,
      gray,
      rgba,
    ]) {
      if (mat && typeof mat.delete === "function") {
        mat.delete();
      }
    }
  }
}


/* -------------------------------------------------------
   4. Segment a PaddleOCR text line into word regions
------------------------------------------------------- */

function segmentWordsFromLine(
  imageSource,
  job,
  options,
  cv
) {

const text = String(job.text ?? "").trim();

// A leading bullet is a list marker, not a word.
const hasLeadingBullet = /^\s*[•●▪◦]\s+/u.test(text);

const textWithoutLeadingBullet = text.replace(
  /^\s*[•●▪◦]\s+/u,
  ""
);

const tokens = textWithoutLeadingBullet
  .split(/\s+/u)
  .filter(Boolean);

  if (!tokens.length || !job.bounds) {
    return {
      status: "no-text",
      words: [],
    };
  }

 
  const imageDimensions = getImageDimensions(imageSource);
  const imageWidth = imageDimensions.width;
  const imageHeight = imageDimensions.height;

  const bounds = job.bounds;

  const padding = clamp(
    Math.round(Number(options.segmentationPadding ?? 4)),
    2,
    16
  );

  /*
   * PaddleOCR normally returns four polygon points in this order:
   * top-left, top-right, bottom-right, bottom-left.
   *
   * If a valid quadrilateral is unavailable, use the
   * existing axis-aligned rectangle as a fallback.
   */
  let quad = null;

  if (
    Array.isArray(job.points) &&
    job.points.length === 4 &&
    job.points.every(
      (point) =>
        Array.isArray(point) &&
        Number.isFinite(Number(point[0])) &&
        Number.isFinite(Number(point[1]))
    )
  ) {
    quad = job.points.map((point) => [
      Number(point[0]),
      Number(point[1]),
    ]);
  } else {
    quad = [
      [bounds.x, bounds.y],
      [bounds.x + bounds.width, bounds.y],
      [bounds.x + bounds.width, bounds.y + bounds.height],
      [bounds.x, bounds.y + bounds.height],
    ];
  }

  function distance(a, b) {
    return Math.hypot(
      b[0] - a[0],
      b[1] - a[1]
    );
  }

  const topWidth = distance(quad[0], quad[1]);
  const bottomWidth = distance(quad[3], quad[2]);

  const leftHeight = distance(quad[0], quad[3]);
  const rightHeight = distance(quad[1], quad[2]);

  const contentWidth = Math.max(
    2,
    Math.round((topWidth + bottomWidth) / 2)
  );

  const contentHeight = Math.max(
    2,
    Math.round((leftHeight + rightHeight) / 2)
  );

  if (
    !Number.isFinite(contentWidth) ||
    !Number.isFinite(contentHeight) ||
    contentWidth < 2 ||
    contentHeight < 2
  ) {
    return {
      status: "invalid-line-geometry",
      words: [],
    };
  }

  // Crop the original line with surrounding background.
  const cropLeft = clamp(
    Math.floor(bounds.x) - padding,
    0,
    imageWidth - 1
  );

  const cropTop = clamp(
    Math.floor(bounds.y) - padding,
    0,
    imageHeight - 1
  );

  const cropRight = clamp(
    Math.ceil(bounds.x + bounds.width) + padding,
    cropLeft + 1,
    imageWidth
  );

  const cropBottom = clamp(
    Math.ceil(bounds.y + bounds.height) + padding,
    cropTop + 1,
    imageHeight
  );

  const cropWidth = cropRight - cropLeft;
  const cropHeight = cropBottom - cropTop;

  const destinationWidth =
    contentWidth + padding * 2;

  const destinationHeight =
    contentHeight + padding * 2;

  let rgba = null;
  let warpedRGBA = null;
  let gray = null;
  let invertedGray = null;

  let darkMask = null;
  let lightMask = null;

  let darkROI = null;
  let lightROI = null;

  let sourcePoints = null;
  let destinationPoints = null;
  let forwardTransform = null;
  let inverseTransform = null;

  try {
    /*
     * Draw the original line crop.
     */
    const canvas = new OffscreenCanvas(
      cropWidth,
      cropHeight
    );

    const context = canvas.getContext("2d", {
      willReadFrequently: true,
    });

    if (!context) {
      throw new Error(
        "Could not create line segmentation canvas."
      );
    }

    context.drawImage(
      imageSource,
      cropLeft,
      cropTop,
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight
    );

    const imageData = context.getImageData(
      0,
      0,
      cropWidth,
      cropHeight
    );

    rgba = new cv.Mat(
      cropHeight,
      cropWidth,
      cv.CV_8UC4
    );

    rgba.data.set(imageData.data);

    /*
     * Rectify the line polygon into a horizontal rectangle.
     */
    const sourceCoordinates = quad.flatMap(
      ([x, y]) => [
        x - cropLeft,
        y - cropTop,
      ]
    );

    const destinationCoordinates = [
      padding,
      padding,

      padding + contentWidth - 1,
      padding,

      padding + contentWidth - 1,
      padding + contentHeight - 1,

      padding,
      padding + contentHeight - 1,
    ];

    sourcePoints = cv.matFromArray(
      4,
      1,
      cv.CV_32FC2,
      sourceCoordinates
    );

    destinationPoints = cv.matFromArray(
      4,
      1,
      cv.CV_32FC2,
      destinationCoordinates
    );

    forwardTransform = cv.getPerspectiveTransform(
      sourcePoints,
      destinationPoints
    );

    inverseTransform = cv.getPerspectiveTransform(
      destinationPoints,
      sourcePoints
    );

    warpedRGBA = new cv.Mat();

    cv.warpPerspective(
      rgba,
      warpedRGBA,
      forwardTransform,
      new cv.Size(
        destinationWidth,
        destinationHeight
      ),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE
    );

    /*
     * Convert rectified line to grayscale.
     */
    gray = new cv.Mat();

    cv.cvtColor(
      warpedRGBA,
      gray,
      cv.COLOR_RGBA2GRAY
    );

    invertedGray = new cv.Mat();

    cv.bitwise_not(
      gray,
      invertedGray
    );

    /*
     * Create both foreground polarities.
     * This supports both dark text on light backgrounds
     * and light text on dark backgrounds.
     */
    const minimumDimension = Math.min(
      destinationWidth,
      destinationHeight
    );

    const maximumOddBlock =
      minimumDimension % 2 === 1
        ? minimumDimension
        : minimumDimension - 1;

    if (maximumOddBlock < 3) {
      return {
        status: "line-too-small",
        words: [],
      };
    }

    let blockSize = Math.round(
      contentHeight * 0.6
    );

    if (blockSize % 2 === 0) {
      blockSize += 1;
    }

    blockSize = clamp(
      blockSize,
      3,
      Math.min(31, maximumOddBlock)
    );

    const adaptiveC = Number.isFinite(
      Number(options.adaptiveC)
    )
      ? Number(options.adaptiveC)
      : 5;

    darkMask = new cv.Mat();

    cv.adaptiveThreshold(
      gray,
      darkMask,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      blockSize,
      adaptiveC
    );

    lightMask = new cv.Mat();

    cv.adaptiveThreshold(
      invertedGray,
      lightMask,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      blockSize,
      adaptiveC
    );

    /*
     * Only count foreground within the actual rectified line,
     * not the added padding.
     */
    const contentRect = new cv.Rect(
      padding,
      padding,
      contentWidth,
      contentHeight
    );

    darkROI = darkMask.roi(contentRect);
    lightROI = lightMask.roi(contentRect);

    const darkPixels = cv.countNonZero(darkROI);
    const lightPixels = cv.countNonZero(lightROI);

    const useDarkMask = darkPixels <= lightPixels;

    const selectedMask = useDarkMask
      ? darkMask
      : lightMask;

    const foregroundRatio =
      Math.min(darkPixels, lightPixels) /
      (contentWidth * contentHeight);

    if (
      foregroundRatio < 0.001 ||
      foregroundRatio > 0.75
    ) {
      return {
        status: "unreliable-foreground-mask",
        words: [],
        foregroundRatio,
      };
    }

    
    /*
     * OPENCV CONNECTED-COMPONENT WORD DETECTION
     *
     * Word positions are detected from foreground components.
     * PaddleOCR's expected word count is used only to validate
     * the result, never to force the number of word boxes.
     */

    const componentROI = selectedMask.roi(
      new cv.Rect(
        padding,
        padding,
        contentWidth,
        contentHeight
      )
    );

    const componentLabels = new cv.Mat();
    const componentStats = new cv.Mat();
    const componentCentroids = new cv.Mat();

    let components = [];

    try {
      const componentCount =
        cv.connectedComponentsWithStats(
          componentROI,
          componentLabels,
          componentStats,
          componentCentroids,
          8,
          cv.CV_32S
        );

      const minimumArea = Math.max(
        2,
        Math.round(Number(options.minComponentArea ?? 2))
      );

      for (
        let i = 1;
        i < componentCount;
        i++
      ) {
        const area = componentStats.intAt(
          i,
          cv.CC_STAT_AREA
        );

        if (area < minimumArea) {
          continue;
        }

        const x = componentStats.intAt(
          i,
          cv.CC_STAT_LEFT
        );

        const y = componentStats.intAt(
          i,
          cv.CC_STAT_TOP
        );

        const width = componentStats.intAt(
          i,
          cv.CC_STAT_WIDTH
        );

        const height = componentStats.intAt(
          i,
          cv.CC_STAT_HEIGHT
        );

        if (
          width < 1 ||
          height < 1 ||
          width > contentWidth * 0.8 ||
          height > contentHeight
        ) {
          continue;
        }


components.push({
  left: x,
  right: x + width,
  top: y,
  bottom: y + height,
  width,
  height,
  area,
});
      }
    } finally {
      componentROI.delete();
      componentLabels.delete();
      componentStats.delete();
      componentCentroids.delete();
    }

    if (components.length === 0) {
      return {
        status: "no-components",
        words: [],
      };
    }


/*
 * OPENCV NOISE-FILTERED PIXEL-PROJECTION SEGMENTATION
 *
 * Word boundaries are identified from actual foreground
 * pixels and their horizontal whitespace gaps.
 */

components.sort(
  (a, b) =>
    a.left - b.left ||
    a.top - b.top
);

if (components.length === 0) {
  return {
    status: "no-components",
    words: [],
  };
}

const projectionROI = selectedMask.roi(
  new cv.Rect(
    padding,
    padding,
    contentWidth,
    contentHeight
  )
);

let projectionLabels = null;
let projectionStats = null;
let projectionCentroids = null;

const cleanComponents = [];
const columnCounts = new Uint16Array(contentWidth);

try {
  projectionLabels = new cv.Mat();
  projectionStats = new cv.Mat();
  projectionCentroids = new cv.Mat();

  const count = cv.connectedComponentsWithStats(
    projectionROI,
    projectionLabels,
    projectionStats,
    projectionCentroids,
    8,
    cv.CV_32S
  );

  // Ignore tiny isolated noise components.
  const minimumArea = Math.max(
    4,
    Math.round(contentHeight * 0.08)
  );

  const acceptedLabels = new Uint8Array(count);

  for (let label = 1; label < count; label++) {
    const area = projectionStats.intAt(
      label,
      cv.CC_STAT_AREA
    );

    if (area < minimumArea) continue;

    acceptedLabels[label] = 1;

    const left = projectionStats.intAt(
      label,
      cv.CC_STAT_LEFT
    );

    const top = projectionStats.intAt(
      label,
      cv.CC_STAT_TOP
    );

    const width = projectionStats.intAt(
      label,
      cv.CC_STAT_WIDTH
    );

    const height = projectionStats.intAt(
      label,
      cv.CC_STAT_HEIGHT
    );

    cleanComponents.push({
      left,
      right: left + width,
      top,
      bottom: top + height,
      width,
      height,
      area,
      centerX: left + width / 2,
    });
  }

  // Calculate foreground pixels in every vertical column.
  for (let y = 0; y < contentHeight; y++) {
    for (let x = 0; x < contentWidth; x++) {
      const label = projectionLabels.intAt(y, x);

      if (label > 0 && acceptedLabels[label]) {
        columnCounts[x]++;
      }
    }
  }
} finally {
  projectionROI.delete();

  for (const mat of [
    projectionLabels,
    projectionStats,
    projectionCentroids,
  ]) {
    if (mat) mat.delete();
  }
}

if (!cleanComponents.length) {
  return {
    status: "no-clean-components",
    words: [],
  };
}

/*
 * Smooth isolated one-column gaps using a three-column median.
 */
const smoothCounts = new Uint16Array(contentWidth);

for (let x = 0; x < contentWidth; x++) {
  const a = columnCounts[Math.max(0, x - 1)];
  const b = columnCounts[x];
  const c = columnCounts[
    Math.min(contentWidth - 1, x + 1)
  ];

  const values = [a, b, c].sort(
    (m, n) => m - n
  );

  smoothCounts[x] = values[1];
}

const occupied = Array.from(
  smoothCounts,
  (value) => value > 0
);

let firstOccupied = occupied.findIndex(Boolean);
let lastOccupied = occupied.length - 1;

while (
  lastOccupied >= 0 &&
  !occupied[lastOccupied]
) {
  lastOccupied--;
}

if (firstOccupied < 0 || lastOccupied < firstOccupied) {
  return {
    status: "no-usable-projection",
    words: [],
  };
}

/*
 * Detect actual consecutive empty-column regions.
 */
const candidateGaps = [];

let column = firstOccupied;

const minimumGapWidth = Math.max(
  2,
  Math.round(contentHeight * 0.10)
);

while (column <= lastOccupied) {
  if (occupied[column]) {
    column++;
    continue;
  }

  const gapStart = column;

  while (
    column <= lastOccupied &&
    !occupied[column]
  ) {
    column++;
  }

  const gapEnd = column;
  const gapWidth = gapEnd - gapStart;

  if (gapWidth >= minimumGapWidth) {
    candidateGaps.push({
      start: gapStart,
      end: gapEnd,
      width: gapWidth,
      center: (gapStart + gapEnd) / 2,
    });
  }
}

/*
 * Exclude a leading bullet from the recognized word regions.
 */
let markerGap = null;
let firstWordStart = firstOccupied;

if (hasLeadingBullet && candidateGaps.length > 0) {
  const firstGap = candidateGaps[0];

  const minimumMarkerGap = Math.max(
    5,
    Math.round(contentHeight * 0.45)
  );

  if (firstGap.width >= minimumMarkerGap) {
    markerGap = candidateGaps.shift();
    firstWordStart = markerGap.end;
  }
}

/*
 * Use PaddleOCR's spaces only to establish the expected
 * number of separators. Their actual positions come from
 * OpenCV's measured empty-column regions.
 */
const requiredGapCount = tokens.length - 1;

if (candidateGaps.length < requiredGapCount) {
  return {
    status: "insufficient-word-gaps",
    method: "opencv-pixel-projection",
    expectedWordCount: tokens.length,
    availableGapCount: candidateGaps.length,
    requiredGapCount,
    candidateGaps,
    words: [],
  };
}

/*
 * Select the widest actual whitespace regions.
 */
const selectedGaps = [...candidateGaps]
  .sort(
    (a, b) =>
      b.width - a.width ||
      a.start - b.start
  )
  .slice(0, requiredGapCount)
  .sort((a, b) => a.start - b.start);

/*
 * Convert whitespace intervals into word ranges.
 */
const wordRanges = [];

let rangeStart = firstWordStart;

for (const gap of selectedGaps) {
  if (gap.start > rangeStart) {
    wordRanges.push({
      start: rangeStart,
      end: gap.start,
    });
  }

  rangeStart = gap.end;
}

if (rangeStart <= lastOccupied) {
  wordRanges.push({
    start: rangeStart,
    end: lastOccupied + 1,
  });
}

/*
 * Calculate each box from the original connected
 * foreground components, not the smoothed projection.
 */
const wordGroups = [];

for (let i = 0; i < wordRanges.length; i++) {
  const range = wordRanges[i];

  const members = cleanComponents.filter(
    (component) =>
      component.centerX >= range.start &&
      component.centerX < range.end
  );

  if (!members.length) continue;

  wordGroups.push({
    left: Math.min(
      ...members.map((component) => component.left)
    ),

    right: Math.max(
      ...members.map((component) => component.right)
    ),

    top: Math.min(
      ...members.map((component) => component.top)
    ),

    bottom: Math.max(
      ...members.map((component) => component.bottom)
    ),

    componentCount: members.length,

    area: members.reduce(
      (sum, component) => sum + component.area,
      0
    ),

    gapBefore:
      i === 0 ? null : selectedGaps[i - 1].width,
  });
}

const textMappingValid =
  wordGroups.length === tokens.length;

const selectedWidths = selectedGaps.map(
  (gap) => gap.width
);

const rejectedWidths = candidateGaps
  .filter((gap) => !selectedGaps.includes(gap))
  .map((gap) => gap.width);

const selectedMinimumWidth = selectedWidths.length
  ? Math.min(...selectedWidths)
  : 0;

const rejectedMaximumWidth = rejectedWidths.length
  ? Math.max(...rejectedWidths)
  : 0;

let segmentationConfidence = "low";

if (requiredGapCount === 0) {
  segmentationConfidence = "high";
} else if (
  selectedMinimumWidth >= rejectedMaximumWidth * 1.25 &&
  selectedMinimumWidth >= contentHeight * 0.15
) {
  segmentationConfidence = "high";
} else if (selectedMinimumWidth > rejectedMaximumWidth) {
  segmentationConfidence = "medium";
}

const gapThreshold = selectedMinimumWidth;

const gapSeparation = {
  selectedMinimumWidth,
  rejectedMaximumWidth,
  markerGapWidth: markerGap?.width ?? null,
};

const detectedGaps = selectedGaps.map(
  (gap) => gap.width
);


 const words = [];
    for (let i = 0; i < wordGroups.length; i++) {
      const group = wordGroups[i];

      // Actual component boundaries in the rectified image.
      const rectifiedLeft =
        padding + group.left;

      const rectifiedRight =
        padding + group.right - 1;

      const rectifiedTop =
        padding + group.top;

      const rectifiedBottom =
        padding + group.bottom - 1;

      const wordRectPoints = cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        [
          rectifiedLeft,
          rectifiedTop,

          rectifiedRight,
          rectifiedTop,

          rectifiedRight,
          rectifiedBottom,

          rectifiedLeft,
          rectifiedBottom,
        ]
      );

      const mappedWordPoints = new cv.Mat();

      try {
        cv.perspectiveTransform(
          wordRectPoints,
          mappedWordPoints,
          inverseTransform
        );

        const mapped = mappedWordPoints.data32F;

        if (!mapped || mapped.length < 8) {
          continue;
        }

        const polygon = [];

        for (let p = 0; p < 4; p++) {
          polygon.push([
            Number(mapped[p * 2]) + cropLeft,
            Number(mapped[p * 2 + 1]) + cropTop,
          ]);
        }

        const xs = polygon.map((point) => point[0]);
        const ys = polygon.map((point) => point[1]);

        const minX = Math.max(
          0,
          Math.floor(Math.min(...xs))
        );

        const minY = Math.max(
          0,
          Math.floor(Math.min(...ys))
        );

        const maxX = Math.min(
          imageWidth,
          Math.ceil(Math.max(...xs))
        );

        const maxY = Math.min(
          imageHeight,
          Math.ceil(Math.max(...ys))
        );

        if (maxX <= minX || maxY <= minY) {
          continue;
        }

        words.push({
          index: i,

          // Never assign the wrong word when counts differ.
          text: textMappingValid
            ? tokens[i]
            : null,

          bounds: {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
          },

          polygon,

          componentCount: group.componentCount,
          foregroundPixels: group.area,

          gapBefore: group.gapBefore,
        });

      } finally {
        wordRectPoints.delete();
        mappedWordPoints.delete();
      }
    }

const completeMapping =
  textMappingValid &&
  words.length === tokens.length;

      return {
    status: completeMapping
  ? "segmented"
  : "word-count-mismatch",
      confidence: segmentationConfidence,

   method: "opencv-pixel-projection",

      expectedWordCount: tokens.length,
      detectedWordCount: wordGroups.length,

     textMappingValid: completeMapping,
      recognizedTokens: tokens,

      foregroundRatio,
      polarity: useDarkMask
        ? "dark-ink"
        : "light-ink",

      gapThreshold,
      gapSeparation,
      detectedGaps,

      words,
    };

  } finally {
    // Explicitly release every OpenCV allocation.
    for (const mat of [
      sourcePoints,
      destinationPoints,
      forwardTransform,
      inverseTransform,
      darkROI,
      lightROI,
      darkMask,
      lightMask,
      invertedGray,
      gray,
      warpedRGBA,
      rgba,
    ]) {
      if (mat && typeof mat.delete === "function") {
        mat.delete();
      }
    }
  }
}

// Preserve the existing selection behavior for unsharp-mask
// enhancement comparisons.
function shouldRunGlyphEnhancementDiagnostics(job, options = {}) {
  if (options.originalGlyphShapeDiagnostics === false) {
    return false;
  }

  if (options.originalGlyphShapeDiagnostics === true) {
    return true;
  }

  const text = String(job?.text ?? "").trim();

  return (
    text === "IBM" ||
    text.startsWith(
      "• Monitoring and managing supplier performance"
    ) ||
    text.startsWith("• Conducting cost analysis")
  );
}


// Select OCR lines for original glyph-shape extraction.
function shouldExtractOriginalGlyphShapes(job, options = {}) {
  if (options.originalGlyphShapeDiagnostics === false) {
    return false;
  }

  if (options.originalGlyphShapeDiagnostics === true) {
    return true;
  }

  // An explicitly supplied index array takes precedence
  // over the default three-line test set.
  const selectedLineIndices =
    options.originalGlyphShapeLineIndices;

  if (Array.isArray(selectedLineIndices)) {
    return (
      Number.isInteger(job?.index) &&
      selectedLineIndices.includes(job.index)
    );
  }

  // Preserve the existing default test set when no
  // explicit line-index array is supplied.
  const text = String(job?.text ?? "").trim();

  return (
    text === "IBM" ||
    text.startsWith(
      "• Monitoring and managing supplier performance"
    ) ||
    text.startsWith("• Conducting cost analysis")
  );
}

/* -------------------------------------------------------
   4. Measure individual character ink using exact PaddleOCR crop
------------------------------------------------------- */

function measureCharactersFromLine(
  imageSource,
  job,
  options = {},
  cv
) {
  const crop = job?.cropGeometry;
  const geometry = job?.geometry;

  const characters = Array.isArray(job?.characters)
    ? job.characters
    : [];

  if (!imageSource || !crop || !geometry || !characters.length) {
    return {
      status: "missing-character-geometry",
      method: "paddle-exact-crop-opencv",
      characters: [],
    };
  }

  const cropWidth = Number(crop.cropWidth);
  const cropHeight = Number(crop.cropHeight);
  const finalWidth = Number(crop.finalWidth);
  const finalHeight = Number(crop.finalHeight);

  const sourceWidth = Number(geometry.sourceWidth);
  const sourceHeight = Number(geometry.sourceHeight);
  const resizedWidth = Number(geometry.resizedWidth);
  const inputWidth = Number(geometry.inputWidth);
  const timeSteps = Number(geometry.timeSteps);

  const rotated = crop.rotated;

  const orderedValid =
    Array.isArray(crop.ordered) &&
    crop.ordered.length === 4 &&
    crop.ordered.every(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        Number.isFinite(Number(point[0])) &&
        Number.isFinite(Number(point[1]))
    );

  if (
    !orderedValid ||
    !Number.isInteger(cropWidth) ||
    !Number.isInteger(cropHeight) ||
    cropWidth < 2 ||
    cropHeight < 2 ||
    typeof rotated !== "boolean" ||
    !Number.isInteger(finalWidth) ||
    !Number.isInteger(finalHeight) ||
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    !Number.isFinite(resizedWidth) ||
    !Number.isFinite(inputWidth) ||
    !Number.isFinite(timeSteps) ||
    resizedWidth <= 0 ||
    inputWidth < resizedWidth ||
    timeSteps <= 0
  ) {
    return {
      status: "invalid-character-geometry",
      method: "paddle-exact-crop-opencv",
      characters: [],
    };
  }

  const expectedFinalWidth = rotated
    ? cropHeight
    : cropWidth;

  const expectedFinalHeight = rotated
    ? cropWidth
    : cropHeight;

  if (
    finalWidth !== expectedFinalWidth ||
    finalHeight !== expectedFinalHeight ||
    sourceWidth !== finalWidth ||
    sourceHeight !== finalHeight
  ) {
    return {
      status: "crop-recognizer-dimension-mismatch",
      method: "paddle-exact-crop-opencv",
      characters: [],
    };
  }

  const imageDimensions = getImageDimensions(imageSource);
  const imageWidth = imageDimensions.width;
  const imageHeight = imageDimensions.height;

  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth < 2 ||
    imageHeight < 2
  ) {
    return {
      status: "invalid-image-dimensions",
      method: "paddle-exact-crop-opencv",
      characters: [],
    };
  }

  const ordered = crop.ordered.map((point) => [
    Number(point[0]),
    Number(point[1]),
  ]);

  const minSourceX = Math.min(
    ...ordered.map((point) => point[0])
  );

  const maxSourceX = Math.max(
    ...ordered.map((point) => point[0])
  );

  const minSourceY = Math.min(
    ...ordered.map((point) => point[1])
  );

  const maxSourceY = Math.max(
    ...ordered.map((point) => point[1])
  );

  /*
   * Use a small source-image margin so cubic interpolation
   * has neighboring pixels around the quadrilateral.
   */
  const sourcePadding = 3;

  const sourceLeft = clamp(
    Math.floor(minSourceX) - sourcePadding,
    0,
    imageWidth - 1
  );

  const sourceTop = clamp(
    Math.floor(minSourceY) - sourcePadding,
    0,
    imageHeight - 1
  );

  const sourceRight = clamp(
    Math.ceil(maxSourceX) + sourcePadding,
    sourceLeft + 1,
    imageWidth
  );

  const sourceBottom = clamp(
    Math.ceil(maxSourceY) + sourcePadding,
    sourceTop + 1,
    imageHeight
  );

  const sourceCropWidth = sourceRight - sourceLeft;
  const sourceCropHeight = sourceBottom - sourceTop;

  let sourceRGBA = null;
  let warpedRGBA = null;
  let finalRGBA = null;

  let gray = null;
  let invertedGray = null;
  let darkMask = null;
  let lightMask = null;

  let sourcePoints = null;
  let destinationPoints = null;
  let forwardTransform = null;
  let inverseTransform = null;

  try {
    /*
     * Read only the source region surrounding the exact
     * PaddleOCR quadrilateral.
     */
    const canvas = new OffscreenCanvas(
      sourceCropWidth,
      sourceCropHeight
    );

    const context = canvas.getContext("2d", {
      willReadFrequently: true,
    });

    if (!context) {
      throw new Error(
        "Could not create the exact character crop canvas."
      );
    }

    context.drawImage(
      imageSource,
      sourceLeft,
      sourceTop,
      sourceCropWidth,
      sourceCropHeight,
      0,
      0,
      sourceCropWidth,
      sourceCropHeight
    );

    const imageData = context.getImageData(
      0,
      0,
      sourceCropWidth,
      sourceCropHeight
    );

    sourceRGBA = new cv.Mat(
      sourceCropHeight,
      sourceCropWidth,
      cv.CV_8UC4
    );

    sourceRGBA.data.set(imageData.data);

    /*
     * Reproduce PaddleOCR's exact perspective transformation.
     *
     * The source coordinates are shifted by sourceLeft/sourceTop.
     * This translation does not change the resulting crop geometry.
     */
    const localSourceCoordinates = ordered.flatMap(
      ([x, y]) => [
        x - sourceLeft,
        y - sourceTop,
      ]
    );

    const destinationCoordinates = [
      0, 0,
      cropWidth, 0,
      cropWidth, cropHeight,
      0, cropHeight,
    ];

    sourcePoints = cv.matFromArray(
      4,
      1,
      cv.CV_32FC2,
      localSourceCoordinates
    );

    destinationPoints = cv.matFromArray(
      4,
      1,
      cv.CV_32FC2,
      destinationCoordinates
    );

    forwardTransform = cv.getPerspectiveTransform(
      sourcePoints,
      destinationPoints
    );

    inverseTransform = cv.getPerspectiveTransform(
      destinationPoints,
      sourcePoints
    );

    warpedRGBA = new cv.Mat();

    cv.warpPerspective(
      sourceRGBA,
      warpedRGBA,
      forwardTransform,
      new cv.Size(cropWidth, cropHeight),
      cv.INTER_CUBIC,
      cv.BORDER_REPLICATE,
      new cv.Scalar()
    );

    /*
     * Apply PaddleOCR's own 90-degree counterclockwise rotation.
     */
    if (rotated) {
      finalRGBA = new cv.Mat();

      cv.rotate(
        warpedRGBA,
        finalRGBA,
        cv.ROTATE_90_COUNTERCLOCKWISE
      );
    } else {
      finalRGBA = warpedRGBA;
      warpedRGBA = null;
    }

    if (
      finalRGBA.cols !== finalWidth ||
      finalRGBA.rows !== finalHeight
    ) {
      return {
        status: "reconstructed-crop-dimension-mismatch",
        method: "paddle-exact-crop-opencv",
        characters: [],
      };
    }

    /*
     * Create the two threshold masks.
     */
    gray = new cv.Mat();

    cv.cvtColor(
      finalRGBA,
      gray,
      cv.COLOR_RGBA2GRAY
    );

    invertedGray = new cv.Mat();

    cv.bitwise_not(
      gray,
      invertedGray
    );

    const minimumDimension = Math.min(
      finalWidth,
      finalHeight
    );

    const maximumOddBlock =
      minimumDimension % 2 === 1
        ? minimumDimension
        : minimumDimension - 1;

    if (maximumOddBlock < 3) {
      return {
        status: "character-crop-too-small",
        method: "paddle-exact-crop-opencv",
        characters: [],
      };
    }

    let blockSize = Math.round(
      finalHeight * 0.6
    );

    if (blockSize % 2 === 0) {
      blockSize += 1;
    }

    blockSize = clamp(
      blockSize,
      3,
      Math.min(31, maximumOddBlock)
    );

    const adaptiveC = Number.isFinite(
      Number(options.characterAdaptiveC)
    )
      ? Number(options.characterAdaptiveC)
      : Number(options.adaptiveC ?? 5);

    darkMask = new cv.Mat();

    cv.adaptiveThreshold(
      gray,
      darkMask,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      blockSize,
      adaptiveC
    );

    lightMask = new cv.Mat();

    cv.adaptiveThreshold(
      invertedGray,
      lightMask,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      blockSize,
      adaptiveC
    );

    /*
     * Select polarity using the complete rectified line.
     * Do not choose polarity independently for each letter,
     * because small glyphs such as "i" could be misclassified.
     */
    const darkPixels = cv.countNonZero(darkMask);
    const lightPixels = cv.countNonZero(lightMask);

    const useDarkMask = darkPixels <= lightPixels;

    const selectedMask = useDarkMask
      ? darkMask
      : lightMask;

    const foregroundRatio =
      Math.min(darkPixels, lightPixels) /
      (finalWidth * finalHeight);

    if (
      foregroundRatio < 0.001 ||
      foregroundRatio > 0.75
    ) {
      return {
        status: "unreliable-character-mask",
        method: "paddle-exact-crop-opencv",
        foregroundRatio,
        characters: [],
      };
    }

    /*
     * Calculate CTC character centers in the exact final crop.
     * Spaces remain in the center list so that they define
     * boundaries between words, but they do not get ink boxes.
     */
    /*
     * PP-OCRv6 CTC horizontal feature spacing.
     *
     * Each recognizer timestep represents 8 input pixels.
     * Do not calculate this as inputWidth / timeSteps:
     * the output width is subject to CNN padding and rounding.
     *
     * Batch padding is on the right. The sample content is
     * left-aligned, so map through resizedWidth, not inputWidth.
     */
    const ctcHorizontalStride = 8;

    const cropScale = sourceWidth / resizedWidth;

    const tokenCenters = [];

    // STEP 66: Identify the first and last visible CTC characters.
    // Spaces are retained in tokenCenters but are not edge glyphs.
    let firstVisibleCharacterIndex = -1;
    let lastVisibleCharacterIndex = -1;

    for (
      let visibleIndex = 0;
      visibleIndex < characters.length;
      visibleIndex++
    ) {
      const visibleText =
        String(characters[visibleIndex].text ?? "");

      if (!/^\s+$/u.test(visibleText)) {
        if (firstVisibleCharacterIndex === -1) {
          firstVisibleCharacterIndex = visibleIndex;
        }

        lastVisibleCharacterIndex = visibleIndex;
      }
    }

    for (const [characterIndex, character] of characters.entries()) {
      const startStep = Number(character.startStep);
      const endStep = Number(character.endStep);

      if (
        !Number.isInteger(startStep) ||
        !Number.isInteger(endStep) ||
        startStep < 0 ||
        endStep < startStep ||
        endStep >= timeSteps
      ) {
        return {
          status: "invalid-ctc-character-span",
          method: "paddle-exact-crop-opencv",
          characters: [],
        };
      }

      const stepCenter =
        (startStep + endStep + 1) / 2;

      const centerX =
        stepCenter * ctcHorizontalStride * cropScale;

      /*
       * A final CTC feature cell may have its nominal center
       * exactly on the right image boundary. Allow only a tiny
       * floating-point tolerance, then clamp that edge center.
       */
      const edgeTolerance = 0.01;

      // One CTC output cell represents 8 resized-image pixels.
      // Its half-cell width, mapped back to the source crop,
      // defines the maximum acceptable terminal-centre overflow.
      const edgeCellTolerance =
        (ctcHorizontalStride * cropScale) / 2 +
        edgeTolerance;

      const isFirstVisibleCharacter =
        characterIndex === firstVisibleCharacterIndex;

      const isLastVisibleCharacter =
        characterIndex === lastVisibleCharacterIndex;

      const acceptableLeftEdgeOverflow =
        isFirstVisibleCharacter &&
        centerX >= -edgeCellTolerance;

      const acceptableRightEdgeOverflow =
        isLastVisibleCharacter &&
        centerX <= finalWidth + edgeCellTolerance;

      const outsideLeftBoundary =
        centerX < -edgeTolerance &&
        !acceptableLeftEdgeOverflow;

      const outsideRightBoundary =
        centerX > finalWidth + edgeTolerance &&
        !acceptableRightEdgeOverflow;

      if (
        !Number.isFinite(centerX) ||
        outsideLeftBoundary ||
        outsideRightBoundary
      ) {
        return {
          status: "character-center-outside-crop",
          method: "paddle-exact-crop-opencv",
          offendingCharacter: {
            index: characterIndex,
            text: character.text,
            centerX,
            cropWidth: finalWidth,
            allowedEdgeOverflowPx: edgeCellTolerance,
            actualEdgeOverflowPx: Number.isFinite(centerX)
              ? Math.max(
                  0,
                  -centerX,
                  centerX - finalWidth
                )
              : null,
          },
          characters: [],
        };
      }

      // Accepted terminal feature-cell centres are clamped
      // to the actual image boundary.
      tokenCenters.push(
        clamp(centerX, 0, finalWidth)
      );
    }

    for (let i = 1; i < tokenCenters.length; i++) {
      if (tokenCenters[i] <= tokenCenters[i - 1]) {
        return {
          status: "invalid-ctc-center-order",
          method: "paddle-exact-crop-opencv",
          characters: [],
        };
      }
    }

    /*
     * Estimate each token's horizontal region from adjacent
     * CTC centers. These are measurement regions, not claimed
     * to be exact glyph boundaries.
     */
    const boundaries = new Array(
      characters.length + 1
    );

    boundaries[0] = 0;
    boundaries[characters.length] = finalWidth;

    for (let i = 1; i < characters.length; i++) {
      boundaries[i] =
        (tokenCenters[i - 1] + tokenCenters[i]) / 2;
    }

/* -------------------------------------------------------
   GLYPH ENHANCEMENT COMPARISON — DIAGNOSTIC ONLY

   Baseline:
     Existing selectedMask

   Candidate:
     Mild linear contrast enhancement of a COPY of gray

   Both masks use:
     - Same image dimensions
     - Same adaptive threshold blockSize
     - Same adaptiveC
     - Same CTC character boundaries

   IMPORTANT:
     Candidate mask is never used for actual measurement.
------------------------------------------------------- */

let glyphEnhancementDiagnostics = {
  status: "not-requested",
  method: "unsharp-mask-comparison",
};

if (shouldRunGlyphEnhancementDiagnostics(job, options)) {
let enhancedGray = null;
let blurredGray = null;
let enhancedInvertedGray = null;
let enhancedDarkMask = null;
let enhancedLightMask = null;

  try {
  
// -----------------------------------------------------
// 1. UNsharp-mask sharpening on a separate grayscale copy.
//
// Original gray is never modified.
//
// Formula:
// sharpened = original * (1 + amount)
//             - blurred * amount
// -----------------------------------------------------

const sharpenAmount = 0.35;
const sharpenSigma = 0.8;

if (
  typeof cv.GaussianBlur !== "function" ||
  typeof cv.addWeighted !== "function"
) {
  throw new Error(
    "GaussianBlur or addWeighted is unavailable."
  );
}

// -----------------------------------------------------
// 2. Create a blurred copy of the original grayscale.
// -----------------------------------------------------

blurredGray = new cv.Mat();

cv.GaussianBlur(
  gray,
  blurredGray,
  new cv.Size(3, 3),
  sharpenSigma,
  sharpenSigma,
  cv.BORDER_REPLICATE
);

// -----------------------------------------------------
// 3. Apply mild unsharp-mask sharpening.
//
// amount = 0.35
// Original weight = 1.35
// Blur weight = -0.35
// -----------------------------------------------------

enhancedGray = new cv.Mat();

cv.addWeighted(
  gray,
  1 + sharpenAmount,
  blurredGray,
  -sharpenAmount,
  0,
  enhancedGray
);

// -----------------------------------------------------
// 4. Recreate inverted grayscale.
// -----------------------------------------------------

enhancedInvertedGray = new cv.Mat();

cv.bitwise_not(
  enhancedGray,
  enhancedInvertedGray
);

    // -----------------------------------------------------
    // 4. Apply EXACTLY the same adaptive threshold settings.
    // -----------------------------------------------------

    enhancedDarkMask = new cv.Mat();

    cv.adaptiveThreshold(
      enhancedGray,
      enhancedDarkMask,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      blockSize,
      adaptiveC
    );

    enhancedLightMask = new cv.Mat();

    cv.adaptiveThreshold(
      enhancedInvertedGray,
      enhancedLightMask,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      blockSize,
      adaptiveC
    );

    // -----------------------------------------------------
    // 5. Select the candidate polarity using the same
    //    whole-line rule as the original baseline.
    // -----------------------------------------------------

    function countForegroundPixels(mat) {
      const data = mat.data;
      let count = 0;

      for (let p = 0; p < data.length; p++) {
        if (data[p] !== 0) {
          count++;
        }
      }

      return count;
    }

    const enhancedDarkPixels =
      countForegroundPixels(enhancedDarkMask);

    const enhancedLightPixels =
      countForegroundPixels(enhancedLightMask);

    const enhancedUsesDarkMask =
      enhancedDarkPixels <= enhancedLightPixels;

    const enhancedSelectedMask = enhancedUsesDarkMask
      ? enhancedDarkMask
      : enhancedLightMask;

    // -----------------------------------------------------
    // 6. Compare full-line binary masks.
    // -----------------------------------------------------

    const baselineData = selectedMask.data;
    const candidateData = enhancedSelectedMask.data;

    if (
      !baselineData ||
      !candidateData ||
      baselineData.length !== candidateData.length ||
      baselineData.length !== finalWidth * finalHeight
    ) {
      throw new Error(
        "Baseline and enhanced mask dimensions do not match."
      );
    }

    let baselinePixels = 0;
    let candidatePixels = 0;
    let addedPixels = 0;
    let removedPixels = 0;
    let intersectionPixels = 0;
    let unionPixels = 0;

    for (let p = 0; p < baselineData.length; p++) {
      const baselineInk = baselineData[p] !== 0;
      const candidateInk = candidateData[p] !== 0;

      if (baselineInk) baselinePixels++;
      if (candidateInk) candidatePixels++;

      if (baselineInk && candidateInk) {
        intersectionPixels++;
      }

      if (baselineInk || candidateInk) {
        unionPixels++;
      }

      if (!baselineInk && candidateInk) {
        addedPixels++;
      }

      if (baselineInk && !candidateInk) {
        removedPixels++;
      }
    }

    const fullLineIoU =
      unionPixels > 0
        ? intersectionPixels / unionPixels
        : 1;

    // -----------------------------------------------------
    // 7. Compare masks inside identical CTC character cells.
    //
    // Pixel ownership:
    // pixel center = x + 0.5
    //
    // This preserves the same fractional boundaries
    // used by the original glyph-shape extraction.
    // -----------------------------------------------------

    const perGlyph = [];

    for (let i = 0; i < characters.length; i++) {
      const characterText = String(
        characters[i].text ?? ""
      );

      if (/^\s+$/u.test(characterText)) {
        continue;
      }

      const left = clamp(
        Math.ceil(boundaries[i] - 0.5),
        0,
        finalWidth
      );

      const right = clamp(
        Math.ceil(boundaries[i + 1] - 0.5),
        left,
        finalWidth
      );

      let glyphBaselinePixels = 0;
      let glyphCandidatePixels = 0;
      let glyphAddedPixels = 0;
      let glyphRemovedPixels = 0;
      let glyphIntersectionPixels = 0;
      let glyphUnionPixels = 0;

      for (let y = 0; y < finalHeight; y++) {
        const rowOffset = y * finalWidth;

        for (let x = left; x < right; x++) {
          const pixelIndex = rowOffset + x;

          const baselineInk =
            baselineData[pixelIndex] !== 0;

          const candidateInk =
            candidateData[pixelIndex] !== 0;

          if (baselineInk) {
            glyphBaselinePixels++;
          }

          if (candidateInk) {
            glyphCandidatePixels++;
          }

          if (baselineInk && candidateInk) {
            glyphIntersectionPixels++;
          }

          if (baselineInk || candidateInk) {
            glyphUnionPixels++;
          }

          if (!baselineInk && candidateInk) {
            glyphAddedPixels++;
          }

          if (baselineInk && !candidateInk) {
            glyphRemovedPixels++;
          }
        }
      }

      const glyphIoU =
        glyphUnionPixels > 0
          ? glyphIntersectionPixels / glyphUnionPixels
          : 1;

      perGlyph.push({
        index: i,
        character: characterText,

        regionLeft: left,
        regionRight: right,

        baselinePixels: glyphBaselinePixels,
        enhancedPixels: glyphCandidatePixels,

        addedPixels: glyphAddedPixels,
        removedPixels: glyphRemovedPixels,

        netPixelChange:
          glyphAddedPixels - glyphRemovedPixels,

        intersectionPixels: glyphIntersectionPixels,
        unionPixels: glyphUnionPixels,

        iou: Number(glyphIoU.toFixed(4)),
      });
    }

    // -----------------------------------------------------
    // 8. Store compact, serializable diagnostics.
    // -----------------------------------------------------

    glyphEnhancementDiagnostics = {
      status: "complete",
      method: "unsharp-mask-comparison",

  enhancement: {
  type: "unsharp-mask",
  amount: sharpenAmount,
  sigma: sharpenSigma,
  kernelSize: {
    width: 3,
    height: 3,
  },
},

      crop: {
        width: finalWidth,
        height: finalHeight,
      },

      threshold: {
        method: "adaptive-gaussian",
        blockSize,
        adaptiveC,
      },

      baseline: {
        polarity: useDarkMask
          ? "dark-ink"
          : "light-ink",
        foregroundPixels: baselinePixels,
      },

      enhanced: {
        polarity: enhancedUsesDarkMask
          ? "dark-ink"
          : "light-ink",
        foregroundPixels: candidatePixels,
      },

      comparison: {
        addedPixels,
        removedPixels,
        netPixelChange: addedPixels - removedPixels,
        intersectionPixels,
        unionPixels,
        iou: Number(fullLineIoU.toFixed(5)),
      },

    perGlyph,

// Preserve the complete rectified crop and both masks.
// This allows the preview to compare pixels using a shared
// coordinate system, including pixels added outside the
// original glyph's tight bounding box.
comparisonRaster: {
  width: finalWidth,
  height: finalHeight,

  originalRGBA: new Uint8ClampedArray(
    finalRGBA.data
  ),

  baselineMask: new Uint8Array(
    baselineData
  ),

  enhancedMask: new Uint8Array(
    candidateData
  ),
},

note:
  "Diagnostic comparison only. The enhanced mask is not used for character measurement or glyph extraction.",
    };

    console.groupCollapsed(
      `[Paddle Glyph Enhancement Comparison] Line ${job.index}: ${job.text}`
    );

    console.log(
      "Enhancement settings:",
      glyphEnhancementDiagnostics.enhancement
    );

    console.log(
      "Full-line mask comparison:",
      glyphEnhancementDiagnostics
    );

    console.table(perGlyph);

    console.groupEnd();

  } catch (error) {
    glyphEnhancementDiagnostics = {
      status: "error",
      method: "unsharp-mask-comparison",
      message:
        error?.stack ||
        error?.message ||
        String(error),
    };

    console.warn(
      `[Paddle Glyph Enhancement Comparison] Line ${job.index} failed:`,
      error
    );

 } finally {
  // Release enhancement matrices.
  for (const mat of [
    enhancedGray,
    blurredGray,
    enhancedInvertedGray,
    enhancedDarkMask,
    enhancedLightMask,
  ]) {
    if (mat && typeof mat.delete === "function") {
      mat.delete();
    }
  }
}
}

/* -------------------------------------------------------
   ORIGINAL GLYPH SHAPE EXTRACTION — DIAGNOSTIC ONLY
   Reuses finalRGBA and selectedMask. Does not alter either.
------------------------------------------------------- */

let originalGlyphShapeExtraction = null;

if (shouldExtractOriginalGlyphShapes(job, options)) {
  try {
    originalGlyphShapeExtraction =
      self.OriginalGlyphShapeExtractor.extractCharacterGlyphShapes(
        {
          rgbaMat: finalRGBA,
          binaryMaskMat: selectedMask,
          characters,
          boundaries,
        },
        cv
      );
  } catch (error) {
    originalGlyphShapeExtraction = {
      status: "error",
      method: "opencv-ctc-cell-mask-contours",
      message: error?.stack || error?.message || String(error),
      glyphs: [],
      extractedGlyphCount: 0,
      integrityFailures: 1,
    };

    console.warn(
      "Original glyph shape extraction failed for line " + job.index,
      error
    );
  }
}

const originalGlyphShapeByIndex = new Map(
  (originalGlyphShapeExtraction?.glyphs || []).map((glyph) => [
    glyph.index,
    glyph,
  ])
);

const originalGlyphShapeSummary = originalGlyphShapeExtraction
  ? {
      status: originalGlyphShapeExtraction.status,
      method: originalGlyphShapeExtraction.method,
      coordinateSpace: originalGlyphShapeExtraction.coordinateSpace,
      maskSource: originalGlyphShapeExtraction.maskSource,
      tokenCount: originalGlyphShapeExtraction.tokenCount,
      extractedGlyphCount: originalGlyphShapeExtraction.extractedGlyphCount,
      emptyGlyphCount: originalGlyphShapeExtraction.emptyGlyphCount,
      totalMaskPixels: originalGlyphShapeExtraction.totalMaskPixels,
      totalContours: originalGlyphShapeExtraction.totalContours,
      totalContourPoints: originalGlyphShapeExtraction.totalContourPoints,
      totalHoles: originalGlyphShapeExtraction.totalHoles,
      integrityFailures: originalGlyphShapeExtraction.integrityFailures,
      message: originalGlyphShapeExtraction.message || null,
    }
  : {
      status: "not-requested",
      method: "opencv-ctc-cell-mask-contours",
      extractedGlyphCount: 0,
    };

    const minimumComponentArea = Math.max(
      1,
      Math.floor(
        Number(options.characterMinComponentArea ?? 1)
      )
    );

    const measuredCharacters = [];

    /*
     * Measure each non-space token independently.
     */
    for (let i = 0; i < characters.length; i++) {
      const character = characters[i];
      const characterText = String(character.text ?? "");

      const estimatedLeft = boundaries[i];
      const estimatedRight = boundaries[i + 1];

      if (/^\s+$/u.test(characterText)) {
        measuredCharacters.push({
          index: i,
          text: characterText,
          meanScore: Number(character.meanScore ?? 0),
          status: "space",
          centerX: tokenCenters[i],
          estimatedRegion: {
            left: estimatedLeft,
            right: estimatedRight,
          },
          inkBounds: null,
          polygon: null,
        });

        continue;
      }

      const regionLeft = clamp(
        Math.floor(estimatedLeft),
        0,
        finalWidth - 1
      );

      const regionRight = clamp(
        Math.ceil(estimatedRight),
        regionLeft + 1,
        finalWidth
      );

      const regionWidth = regionRight - regionLeft;

      let characterROI = null;
      let labels = null;
      let stats = null;
      let centroids = null;

      try {
        characterROI = selectedMask.roi(
          new cv.Rect(
            regionLeft,
            0,
            regionWidth,
            finalHeight
          )
        );

        labels = new cv.Mat();
        stats = new cv.Mat();
        centroids = new cv.Mat();

        const componentCount =
          cv.connectedComponentsWithStats(
            characterROI,
            labels,
            stats,
            centroids,
            8,
            cv.CV_32S
          );

        // Horizontal bounds retain every accepted component.
        let minX = regionWidth;
        let maxX = -1;

        // Original vertical bounds: all accepted components.
        let allMinY = finalHeight;
        let allMaxY = -1;

        // Refined vertical bounds: components near the CTC center.
        let centralMinY = finalHeight;
        let centralMaxY = -1;

        let pixelCount = 0;
        let acceptedComponents = 0;

        // STEP 25: Diagnostic records for every component
        // that passes the existing minimum-area filter.
        // This array does not affect component selection.
        const componentDiagnostics = [];
        let centralHeightComponents = 0;
        const minimumVerticalComponentArea = 3;

        // All components with sufficient area.
        let significantMinY = finalHeight;
        let significantMaxY = -1;
        let significantHeightComponents = 0;

        // Significant components that also pass the CTC-centre filter.
        let centralSignificantMinY = finalHeight;
        let centralSignificantMaxY = -1;
        let centralSignificantHeightComponents = 0;

        /*
         * A component is considered central when its horizontal
         * center is within 32% of the estimated character-region
         * width from this character's CTC center.
         *
         * This rejects many clipped neighboring-character fragments
         * while retaining detached details such as i/j dots.
         */
        const centralTolerance = Math.max(
          1,
          regionWidth * (characterText === "j" || characterText === "J" ? 0.34 : 0.32)
        );

        const characterCenterInRegion =
          tokenCenters[i] - regionLeft;

        for (
          let label = 1;
          label < componentCount;
          label++
        ) {
          const area = stats.intAt(
            label,
            cv.CC_STAT_AREA
          );

          if (
            !Number.isFinite(area) ||
            area < minimumComponentArea
          ) {
            continue;
          }

          const componentX = stats.intAt(
            label,
            cv.CC_STAT_LEFT
          );

          const componentY = stats.intAt(
            label,
            cv.CC_STAT_TOP
          );

          const componentWidth = stats.intAt(
            label,
            cv.CC_STAT_WIDTH
          );

          const componentHeight = stats.intAt(
            label,
            cv.CC_STAT_HEIGHT
          );

          if (
            componentWidth < 1 ||
            componentHeight < 1
          ) {
            continue;
          }

          // STEP 58: Collect ink profiles only for y/Y.
          // These profiles are diagnostic and do not
          // participate in character selection.

          const collectInkProfile =
            /^[pPyY]$/.test(characterText);

          const rowPixelProfile = collectInkProfile
            ? new Array(componentHeight).fill(0)
            : null;

          const columnPixelProfile = collectInkProfile
            ? new Array(componentWidth).fill(0)
            : null;

          const componentCenterX =
            componentX + componentWidth / 2;

          const centerDistance = Math.abs(
            componentCenterX - characterCenterInRegion
          );

          const isCentralComponent =
            centerDistance <= centralTolerance;

          // STEP 57: Measure actual connected-component pixels
          // against the fractional character-region boundaries.
          // This is diagnostic only; it does not change selection.

          let pixelsLeftOfCharacterRegion = 0;
          let pixelsInsideCharacterRegion = 0;
          let pixelsRightOfCharacterRegion = 0;

// Exact connected-component pixels in final PaddleOCR crop coordinates.
// Each run is [y, startXInclusive, endXExclusive].
const pixelRunsInCrop = [];

         
for (
  let scanY = componentY;
  scanY < componentY + componentHeight;
  scanY++
) {
  let runStartX = -1;

  for (
    let scanX = componentX;
    scanX < componentX + componentWidth;
    scanX++
  ) {
    const isComponentPixel =
      labels.intAt(scanY, scanX) === label;

    // Finish the previous horizontal run.
    if (!isComponentPixel) {
      if (runStartX >= 0) {
        pixelRunsInCrop.push([
          scanY,
          regionLeft + runStartX,
          regionLeft + scanX,
        ]);

        runStartX = -1;
      }

      continue;
    }

    // Start a new horizontal run.
    if (runStartX < 0) {
      runStartX = scanX;
    }

    if (collectInkProfile) {
      rowPixelProfile[scanY - componentY]++;

      columnPixelProfile[scanX - componentX]++;
    }

    const pixelCenterXInCrop =
      regionLeft + scanX + 0.5;

    if (pixelCenterXInCrop < estimatedLeft) {
      pixelsLeftOfCharacterRegion++;
    } else if (
      pixelCenterXInCrop >= estimatedRight
    ) {
      pixelsRightOfCharacterRegion++;
    } else {
      pixelsInsideCharacterRegion++;
    }
  }

  // Finish a run that reaches the right side of the component.
  if (runStartX >= 0) {
    pixelRunsInCrop.push([
      scanY,
      regionLeft + runStartX,
      regionLeft + componentX + componentWidth,
    ]);
  }
}


          const measuredComponentPixelCount =
            pixelsLeftOfCharacterRegion +
            pixelsInsideCharacterRegion +
            pixelsRightOfCharacterRegion;

          // STEP 25: Record the existing decision without
          // changing whether this component is selected.
          componentDiagnostics.push({
            label,

            // Coordinates are relative to the complete
            // final PaddleOCR crop.
            boundsInCrop: {
              x: regionLeft + componentX,
              y: componentY,
              width: componentWidth,
              height: componentHeight,
            },

            // Coordinates relative to this character ROI.
            boundsInRegion: {
              x: componentX,
              y: componentY,
              width: componentWidth,
              height: componentHeight,
            },

            pixelArea: area,
// Exact foreground-pixel runs, not bounding-box approximations.
pixelRunsInCrop,
            // STEP 57: Actual pixel ownership diagnostics.
            pixelOwnership: {
              leftOfRegion: pixelsLeftOfCharacterRegion,
              insideRegion: pixelsInsideCharacterRegion,
              rightOfRegion: pixelsRightOfCharacterRegion,

              measuredTotal: measuredComponentPixelCount,

              matchesComponentArea:
                measuredComponentPixelCount === area,

              insideRatio: Number(
                (
                  pixelsInsideCharacterRegion /
                  Math.max(1, measuredComponentPixelCount)
                ).toFixed(3)
              ),

              inkProfile: collectInkProfile
                ? {
                    rowStartY: componentY,
                    rowPixelCounts: rowPixelProfile,

                    columnStartX:
                      regionLeft + componentX,

                    columnPixelCounts: columnPixelProfile,
                  }
                : null,
            },

            centerXInRegion: componentCenterX,

            centerXInCrop:
              regionLeft + componentCenterX,

            ctcCenterXInRegion:
              characterCenterInRegion,

            ctcCenterXInCrop:
              tokenCenters[i],

            centerDistancePx: Number(
              centerDistance.toFixed(3)
            ),

            centerTolerancePx: Number(
              centralTolerance.toFixed(3)
            ),

            passedCenterTolerance:
              isCentralComponent,

            includedInOriginalHeight: true,

            includedInRefinedHeight:
              isCentralComponent,

            exclusionReason: isCentralComponent
              ? null
              : "outside-ctc-center-tolerance",
          });

          // Preserve existing horizontal measurement.
          minX = Math.min(minX, componentX);

          maxX = Math.max(
            maxX,
            componentX + componentWidth
          );

          // Keep all-component height for comparison/fallback.
          allMinY = Math.min(allMinY, componentY);

          allMaxY = Math.max(
            allMaxY,
            componentY + componentHeight
          );

          // Refine vertical measurement using central components.
          if (isCentralComponent) {
            centralMinY = Math.min(
              centralMinY,
              componentY
            );

            centralMaxY = Math.max(
              centralMaxY,
              componentY + componentHeight
            );

            centralHeightComponents++;
          }

          // STEP 27: Track components that contain at least
          // the minimum number of ink pixels for height selection.
          // Horizontal bounds and original bounds remain unchanged.
          if (area >= minimumVerticalComponentArea) {
            significantMinY = Math.min(
              significantMinY,
              componentY
            );

            significantMaxY = Math.max(
              significantMaxY,
              componentY + componentHeight
            );

            significantHeightComponents++;

            if (isCentralComponent) {
              centralSignificantMinY = Math.min(
                centralSignificantMinY,
                componentY
              );

              centralSignificantMaxY = Math.max(
                centralSignificantMaxY,
                componentY + componentHeight
              );

              centralSignificantHeightComponents++;
            }
          }
          pixelCount += area;
          acceptedComponents++;
        }

        const usedCentralHeight =
          centralHeightComponents > 0;

        const useCentralSignificantHeight =
          centralSignificantHeightComponents > 0;

        const useAnySignificantHeight =
          !useCentralSignificantHeight &&
          significantHeightComponents > 0;

        /*
         * Selection priority:
         * 1. Significant components passing the CTC-centre filter.
         * 2. Any significant components in the character region.
         * 3. Existing central-component selection.
         * 4. All accepted components as a final fallback.
         */
        const minY = useCentralSignificantHeight
          ? centralSignificantMinY
          : useAnySignificantHeight
            ? significantMinY
            : usedCentralHeight
              ? centralMinY
              : allMinY;

        const maxY = useCentralSignificantHeight
          ? centralSignificantMaxY
          : useAnySignificantHeight
            ? significantMaxY
            : usedCentralHeight
              ? centralMaxY
              : allMaxY;

        const selectedHeightComponents =
          useCentralSignificantHeight
            ? centralSignificantHeightComponents
            : useAnySignificantHeight
              ? significantHeightComponents
              : usedCentralHeight
                ? centralHeightComponents
                : acceptedComponents;

        const heightRefinement =
          useCentralSignificantHeight
            ? "ctc-centered-area-filtered"
            : useAnySignificantHeight
              ? "significant-components-fallback"
              : usedCentralHeight
                ? "ctc-centered-small-components-fallback"
                : "all-components-fallback";

        // Update Step 25 diagnostics to reflect the actual
        // components used for the final vertical measurement.
        for (const diagnostic of componentDiagnostics) {
          let included = true;

          if (useCentralSignificantHeight) {
            included =
              diagnostic.passedCenterTolerance &&
              diagnostic.pixelArea >= minimumVerticalComponentArea;
          } else if (useAnySignificantHeight) {
            included =
              diagnostic.pixelArea >= minimumVerticalComponentArea;
          } else if (usedCentralHeight) {
            included = diagnostic.passedCenterTolerance;
          }

          diagnostic.includedInRefinedHeight = included;

          if (included) {
            diagnostic.exclusionReason = null;
          } else if (
            (useCentralSignificantHeight || usedCentralHeight) &&
            !diagnostic.passedCenterTolerance
          ) {
            diagnostic.exclusionReason =
              "outside-ctc-center-tolerance";
          } else if (
            diagnostic.pixelArea < minimumVerticalComponentArea
          ) {
            diagnostic.exclusionReason =
              "below-vertical-component-area-threshold";
          } else {
            diagnostic.exclusionReason =
              "not-selected-for-refined-height";
          }
        }

        // STEP 45: Conservative descender component extension.
        // Existing CTC-based selection remains the baseline.

        let finalMinY = minY;
        let finalMaxY = maxY;

        let finalSelectedHeightComponents =
          selectedHeightComponents;

        let descenderExtensionComponentCount = 0;

        const isDescenderCharacter =
          /^[gpqyj]$/i.test(characterText);

        if (isDescenderCharacter) {

          // Connected-component bounding rectangles may overlap
          // even when their actual ink pixels are disjoint.
          // Do not reject candidates using rectangle intersection.
          // Character ownership is determined by the CTC region
          // and the candidate component centre.

          for (const diagnostic of componentDiagnostics) {

            if (diagnostic.includedInRefinedHeight) {
              continue;
            }

            if (
              diagnostic.pixelArea <
              minimumVerticalComponentArea
            ) {
              continue;
            }

            const bounds = diagnostic.boundsInCrop;

            if (!bounds) {
              continue;
            }

            diagnostic.descenderExtensionConsidered = true;

            const componentLeft = bounds.x;
            const componentRight =
              bounds.x + bounds.width;

            const componentTop = bounds.y;
            const componentBottom =
              bounds.y + bounds.height;

            const centerX = diagnostic.centerXInCrop;

            // 1. Component centre must belong to this character.
            if (
              centerX < estimatedLeft ||
              centerX >= estimatedRight
            ) {
              diagnostic.descenderExtensionRejectionReason =
                "center-outside-character-region";

              continue;
            }

            // 2. Component must not extend into the next character.
            if (
              componentRight > estimatedRight + 0.001
            ) {
              diagnostic.descenderExtensionRejectionReason =
                "extends-into-next-character-region";

              continue;
            }

            // 3. Candidate must extend the lower ink boundary.
            if (
              componentBottom <= finalMaxY + 1
            ) {
              diagnostic.descenderExtensionRejectionReason =
                "does-not-extend-descender-bottom";

              continue;
            }

            // 4. Do not use bounding-rectangle intersection
            // for component ownership. The centre-region check
            // above assigns the component to this character.
            // The right-edge check protects the next character.

            // 5. Accept this additional descender component.
            finalMinY = Math.min(
              finalMinY,
              componentTop
            );

            finalMaxY = Math.max(
              finalMaxY,
              componentBottom
            );

            finalSelectedHeightComponents++;
            descenderExtensionComponentCount++;

            diagnostic.includedInRefinedHeight = true;
            diagnostic.exclusionReason = null;
            diagnostic.descenderExtension = true;
            diagnostic.descenderExtensionRejectionReason = null;
          }
        }

        const descenderExtensionApplied =
          descenderExtensionComponentCount > 0;

        // STEP 54: Conditional right-boundary correction for o/O.
        // Never discard the only significant selected component.
        let roundLetterRightBoundaryPruned = false;

        if (/^[oO]$/.test(characterText)) {

          const selectedRoundComponents =
            componentDiagnostics.filter(
              (diagnostic) =>
                diagnostic.includedInRefinedHeight &&
                diagnostic.pixelArea >= minimumVerticalComponentArea &&
                diagnostic.boundsInCrop
            );

          // A separate significant component must remain completely
          // inside this character's estimated region.
          const hasInteriorSignificantComponent =
            selectedRoundComponents.some(
              (diagnostic) => {
                const bounds = diagnostic.boundsInCrop;

                return (
                  bounds.x >= estimatedLeft - 0.001 &&
                  bounds.x + bounds.width <= estimatedRight + 0.001
                );
              }
            );

          if (hasInteriorSignificantComponent) {

            const rightOverhangingComponents =
              selectedRoundComponents.filter(
                (diagnostic) => {
                  const bounds = diagnostic.boundsInCrop;

                  return (
                    bounds.x + bounds.width >
                    estimatedRight + 0.001
                  );
                }
              );

            if (rightOverhangingComponents.length > 0) {

              for (const diagnostic of rightOverhangingComponents) {
                diagnostic.includedInRefinedHeight = false;

                diagnostic.exclusionReason =
                  "right-boundary-overhang-with-interior-component";

                diagnostic.roundLetterRightBoundaryPruned = true;
              }

              // Recalculate vertical bounds using all components
              // that remain selected after this correction.
              const remainingSelectedComponents =
                componentDiagnostics.filter(
                  (diagnostic) =>
                    diagnostic.includedInRefinedHeight &&
                    diagnostic.boundsInCrop
                );

              if (remainingSelectedComponents.length > 0) {

                finalMinY = Math.min(
                  ...remainingSelectedComponents.map(
                    diagnostic => diagnostic.boundsInCrop.y
                  )
                );

                finalMaxY = Math.max(
                  ...remainingSelectedComponents.map(
                    diagnostic =>
                      diagnostic.boundsInCrop.y +
                      diagnostic.boundsInCrop.height
                  )
                );

                finalSelectedHeightComponents =
                  remainingSelectedComponents.length;

                roundLetterRightBoundaryPruned = true;
              }
            }
          }
        }

        const unrefinedHeight =
          allMaxY - allMinY;

        const refinedHeight =
          finalMaxY - finalMinY;

        if (
          acceptedComponents === 0 ||
          maxX <= minX ||
          maxY <= minY
        ) {
          measuredCharacters.push({
            index: i,
            text: characterText,
            meanScore: Number(character.meanScore ?? 0),
            status: "no-visible-ink",
            centerX: tokenCenters[i],
            estimatedRegion: {
              left: estimatedLeft,
              right: estimatedRight,
            },
            inkBounds: null,
            polygon: null,
            pixelCount: 0,
          });

          continue;
        }

        /*
         * Bounds in the final, possibly rotated,
         * PaddleOCR crop. Right/bottom are exclusive.
         */
        const finalCropBounds = {
          x: regionLeft + minX,
          y: finalMinY,
          width: maxX - minX,
          height: refinedHeight,
        };

        const finalCorners = [
          [
            finalCropBounds.x,
            finalCropBounds.y,
          ],
          [
            finalCropBounds.x + finalCropBounds.width,
            finalCropBounds.y,
          ],
          [
            finalCropBounds.x + finalCropBounds.width,
            finalCropBounds.y + finalCropBounds.height,
          ],
          [
            finalCropBounds.x,
            finalCropBounds.y + finalCropBounds.height,
          ],
        ];

        /*
         * Undo PaddleOCR's 90-degree CCW rotation when needed.
         *
         * For continuous pixel-edge coordinates:
         * originalX = cropWidth - rotatedY
         * originalY = rotatedX
         */
        const unrotatedCorners = rotated
          ? finalCorners.map(([x, y]) => [
              cropWidth - y,
              x,
            ])
          : finalCorners;

        const characterPoints = cv.matFromArray(
          4,
          1,
          cv.CV_32FC2,
          unrotatedCorners.flat()
        );

        const mappedPoints = new cv.Mat();

        try {
          cv.perspectiveTransform(
            characterPoints,
            mappedPoints,
            inverseTransform
          );

          const mapped = mappedPoints.data32F;

          if (!mapped || mapped.length < 8) {
            measuredCharacters.push({
              index: i,
              text: characterText,
              meanScore: Number(character.meanScore ?? 0),
              status: "page-mapping-failed",
              centerX: tokenCenters[i],
              estimatedRegion: {
                left: estimatedLeft,
                right: estimatedRight,
              },
              inkBounds: null,
              polygon: null,
              pixelCount,
              acceptedComponents,
            });

            continue;
          }

          const polygon = [];

          for (let p = 0; p < 4; p++) {
            polygon.push([
              clamp(
                Number(mapped[p * 2]) + sourceLeft,
                0,
                imageWidth
              ),
              clamp(
                Number(mapped[p * 2 + 1]) + sourceTop,
                0,
                imageHeight
              ),
            ]);
          }

          const xs = polygon.map((point) => point[0]);
          const ys = polygon.map((point) => point[1]);

          const minPageX = Math.max(
            0,
            Math.floor(Math.min(...xs))
          );

          const minPageY = Math.max(
            0,
            Math.floor(Math.min(...ys))
          );

          const maxPageX = Math.min(
            imageWidth,
            Math.ceil(Math.max(...xs))
          );

          const maxPageY = Math.min(
            imageHeight,
            Math.ceil(Math.max(...ys))
          );

          if (
            maxPageX <= minPageX ||
            maxPageY <= minPageY
          ) {
            measuredCharacters.push({
              index: i,
              text: characterText,
              meanScore: Number(character.meanScore ?? 0),
              status: "invalid-page-bounds",
              centerX: tokenCenters[i],
              estimatedRegion: {
                left: estimatedLeft,
                right: estimatedRight,
              },
              inkBounds: null,
              polygon: null,
              pixelCount,
              acceptedComponents,
            });

            continue;
          }

          measuredCharacters.push({
            index: i,
            text: characterText,
            meanScore: Number(character.meanScore ?? 0),

            status: pixelCount <= 2
              ? "measured-low-pixel-count"
              : "measured",

            centerX: tokenCenters[i],

            estimatedRegion: {
              left: estimatedLeft,
              right: estimatedRight,
            },

            cropBounds: finalCropBounds,

            inkBounds: {
              x: minPageX,
              y: minPageY,
              width: maxPageX - minPageX,
              height: maxPageY - minPageY,
            },

            polygon,

            // Horizontal bounds remain unchanged.
            // These fields describe how vertical bounds were refined.
            heightRefinement,
            heightComponentCount: finalSelectedHeightComponents,
            unrefinedCropHeight: unrefinedHeight,
            refinedCropHeight: refinedHeight,
            heightReductionPixels: Math.max(
              0,
              unrefinedHeight - refinedHeight
            ),

            // STEP 25: Exact vertical-selection summary.
            heightDiagnostics: {
              ctcCenterXInCrop:
                tokenCenters[i],

              ctcCenterXInRegion:
                characterCenterInRegion,

              centerTolerancePx:
                centralTolerance,

              minimumVerticalComponentArea,
              selectionStrategy: heightRefinement,

              roundLetterRightBoundaryPruned,

              descenderExtensionApplied,
              descenderExtensionComponentCount,

              acceptedComponentCount:
                acceptedComponents,

              includedComponentCount:
                finalSelectedHeightComponents,

              excludedComponentCount:
                acceptedComponents - finalSelectedHeightComponents,

              originalBoundsInCrop: {
                top: allMinY,
                bottomExclusive: allMaxY,
                height: unrefinedHeight,
              },

              refinedBoundsInCrop: {
                top: finalMinY,
                bottomExclusive: finalMaxY,
                height: refinedHeight,
              },
            },

            // All area-accepted components, including
            // components rejected by the centre filter.
            componentDiagnostics,

            pixelCount,
            acceptedComponents,
          });

        } finally {
          characterPoints.delete();
          mappedPoints.delete();
        }

      } finally {
        for (const mat of [
          characterROI,
          labels,
          stats,
          centroids,
        ]) {
          if (mat && typeof mat.delete === "function") {
            mat.delete();
          }
        }
      }
    }


/* -------------------------------------------------------
   ORIGINAL GLYPH APPEARANCE CAPTURE — DIAGNOSTIC ONLY

   Uses:
     - Original finalRGBA
     - Existing CTC cell horizontal boundaries
     - Existing measured character vertical cropBounds

   Does not modify:
     - selectedMask
     - Binary glyph dimensions
     - SVG paths
     - OCR measurements
     - Character ownership
------------------------------------------------------- */

let originalGlyphAppearanceSummary = {
  status: originalGlyphShapeExtraction
    ? "not-attached"
    : "not-requested",

  method: "ctc-cell-width-measured-vertical-bounds",

  contextPadding: 3,
  attachedGlyphCount: 0,
  skippedGlyphCount: 0,
  integrityFailures: 0,
};

if (
  originalGlyphShapeExtraction &&
  Array.isArray(originalGlyphShapeExtraction.glyphs)
) {
  try {
    originalGlyphAppearanceSummary =
      self.OriginalGlyphShapeExtractor
        .attachCharacterAppearanceCrops(
          {
            rgbaMat: finalRGBA,

            glyphs: originalGlyphShapeExtraction.glyphs,

            measuredCharacters,

            contextPadding: Number(
              options.originalGlyphAppearanceContextPadding ?? 3
            ),
          },
          cv
        );

  } catch (error) {
    originalGlyphAppearanceSummary = {
      status: "error",
      method: "ctc-cell-width-measured-vertical-bounds",

      message:
        error?.stack ||
        error?.message ||
        String(error),

      attachedGlyphCount: 0,
      skippedGlyphCount: 0,
      integrityFailures: 1,
    };

    console.warn(
      `[Paddle Glyph Appearance Capture] Line ${job.index} failed:`,
      error
    );
  }
}

// Keep the appearance-capture result with the existing
// original glyph extraction summary.
originalGlyphShapeSummary.appearanceCapture =
  originalGlyphAppearanceSummary;

console.groupCollapsed(
  `[Paddle Glyph Appearance Capture] Line ${job.index}: ${job.text}`
);

console.log(
  "Appearance capture summary:",
  originalGlyphAppearanceSummary
);

console.table(
  (originalGlyphShapeExtraction?.glyphs || []).map(glyph => ({
    index: glyph.index,
    character: glyph.text,

    binaryWidth: glyph.width,
    binaryHeight: glyph.height,

    appearanceStatus: glyph.appearanceStatus ?? "not-attached",

    appearanceWidth: glyph.appearanceWidth ?? null,
    appearanceHeight: glyph.appearanceHeight ?? null,

    appearanceCropBounds:
      glyph.appearanceCropBounds ?? null,

    appearanceByteLength:
      glyph.appearanceRgba?.length ?? 0,
  }))
);

console.groupEnd();


// Attach preview data by character index. This is diagnostic metadata only;
// it does not participate in visible-ink or height-bound calculations.
for (const character of measuredCharacters) {
  const shape = originalGlyphShapeByIndex.get(character.index);
  if (shape) {
    character.originalGlyphShape = shape;
  }
}

    const glyphs = measuredCharacters.filter(
      (character) =>
        character.status === "measured" ||
        character.status === "measured-low-pixel-count"
    );

    const spaces = measuredCharacters.filter(
      (character) => character.status === "space"
    );

    const noInk = measuredCharacters.filter(
      (character) => character.status === "no-visible-ink"
    );


/* -------------------------------------------------------
   GLYPH COMPONENT PIXEL-RUN DIAGNOSTICS
   Diagnostic only: does not change glyph extraction.
------------------------------------------------------- */

const componentLogRows = [];

const charactersWithComponents = measuredCharacters.filter(
  (character) =>
    Array.isArray(character.componentDiagnostics)
);

let totalComponents = 0;
let componentsWithPixelRuns = 0;
let componentsMissingPixelRuns = 0;
let totalRunPixels = 0;

for (const character of charactersWithComponents) {
  for (const component of character.componentDiagnostics) {
    const runs = Array.isArray(component.pixelRunsInCrop)
      ? component.pixelRunsInCrop
      : [];

    const runPixelCount = runs.reduce(
      (sum, run) => {
        const startX = Number(run?.[1]);
        const endX = Number(run?.[2]);

        if (
          !Number.isFinite(startX) ||
          !Number.isFinite(endX) ||
          endX <= startX
        ) {
          return sum;
        }

        return sum + endX - startX;
      },
      0
    );

    totalComponents++;

    if (runs.length > 0) {
      componentsWithPixelRuns++;
    } else {
      componentsMissingPixelRuns++;
    }

    totalRunPixels += runPixelCount;

    componentLogRows.push({
      characterIndex: character.index,
      character: character.text,

      componentLabel: component.label,
      componentArea: component.pixelArea,

      runCount: runs.length,
      runPixelCount,

      pixelCountMatches:
        runPixelCount === Number(component.pixelArea),

      centerDistancePx: component.centerDistancePx,
      centerTolerancePx: component.centerTolerancePx,

      passedCenterTolerance:
        component.passedCenterTolerance,

      includedInRefinedHeight:
        component.includedInRefinedHeight,

      leftOfRegion:
        component.pixelOwnership?.leftOfRegion,

      insideRegion:
        component.pixelOwnership?.insideRegion,

      rightOfRegion:
        component.pixelOwnership?.rightOfRegion,

      exclusionReason:
        component.exclusionReason ?? null,
    });
  }
}

console.groupCollapsed(
  `[Paddle Glyph Component Runs] Line ${job.index}: ${job.text}`
);

console.log("Component extraction summary:", {
  measurementStatus: "measured",

  measuredCharacterCount: measuredCharacters.filter(
    character =>
      character.status === "measured" ||
      character.status === "measured-low-pixel-count"
  ).length,

  charactersWithComponents:
    charactersWithComponents.length,

  totalComponents,

  componentsWithPixelRuns,
  componentsMissingPixelRuns,

  totalRunPixels,

  pixelRunCaptureStatus:
    componentsMissingPixelRuns === 0 &&
    totalComponents > 0
      ? "complete"
      : "review",
});

console.log("Component ownership and pixel-count table:");

console.table(componentLogRows);

// Exact pixel runs, grouped by character and component.
// Each run is [y, startXInclusive, endXExclusive].
for (const character of charactersWithComponents) {
  console.groupCollapsed(
    `Glyph ${character.index}: "${character.text}"`
  );

  console.table(
    character.componentDiagnostics.map(component => ({
      label: component.label,
      area: component.pixelArea,
      runCount: component.pixelRunsInCrop?.length ?? 0,
      centerDistancePx: component.centerDistancePx,
      passedCenterTolerance: component.passedCenterTolerance,
      exclusionReason: component.exclusionReason,
    }))
  );

  console.log(
    "Exact component pixel runs:",
    character.componentDiagnostics.map(component => ({
      label: component.label,
      pixelArea: component.pixelArea,
      pixelRunsInCrop: component.pixelRunsInCrop ?? null,
    }))
  );

  console.groupEnd();
}

console.groupEnd();


   return {
  status: "measured",
  method: "paddle-exact-crop-opencv-adaptive-components",

  // Preserve the complete original glyph extraction.
  originalGlyphShapeExtraction,

  // Preserve its compact diagnostic summary.
  originalGlyphShapeSummary,

  glyphEnhancementDiagnostics,

  crop: {
        width: finalWidth,
        height: finalHeight,
        rotated,
      },

      polarity: useDarkMask
        ? "dark-ink"
        : "light-ink",

      foregroundRatio,

      tokenCount: characters.length,
      characterCount: glyphs.length,
      spaceCount: spaces.length,
      noInkCount: noInk.length,

      characters: measuredCharacters,
    };

  } finally {
    for (const mat of [
      sourcePoints,
      destinationPoints,
      forwardTransform,
      inverseTransform,
      darkMask,
      lightMask,
      invertedGray,
      gray,
      finalRGBA,
      warpedRGBA,
      sourceRGBA,
    ]) {
      if (mat && typeof mat.delete === "function") {
        mat.delete();
      }
    }
  }
}


/* -------------------------------------------------------
   5. Telea background inpainting
------------------------------------------------------- */

/**
 * Reconstruct masked pixels using OpenCV Telea inpainting.
 *
 * Input:
 *   RGBA source pixels
 *   Binary single-channel mask
 *
 * Output:
 *   RGB reconstructed pixels
 */
function inpaintCropWithTelea({
  width,
  height,
  rgbaData,
  maskData,
  radius = 3,
}, cv) {
  const pixelCount = width * height;

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    pixelCount > 8_000_000
  ) {
    throw new Error("Invalid or excessively large inpainting dimensions.");
  }

  if (
    !rgbaData ||
    rgbaData.length !== pixelCount * 4 ||
    !maskData ||
    maskData.length !== pixelCount
  ) {
    throw new Error("Invalid inpainting image or mask data.");
  }

  if (
    typeof cv.inpaint !== "function" ||
    !Number.isFinite(cv.INPAINT_TELEA)
  ) {
    throw new Error("OpenCV Telea inpainting is unavailable.");
  }

  const inpaintRadius = Number(radius);

  if (
    !Number.isFinite(inpaintRadius) ||
    inpaintRadius < 1 ||
    inpaintRadius > 10
  ) {
    throw new RangeError(
      "Inpainting radius must be between 1 and 10 pixels."
    );
  }

  let sourceRGBA = null;
  let sourceRGB = null;
  let mask = null;
  let destinationRGB = null;

  try {
    // Original RGBA crop.
    sourceRGBA = new cv.Mat(
      height,
      width,
      cv.CV_8UC4
    );

    sourceRGBA.data.set(rgbaData);

    // Telea requires a one- or three-channel 8-bit source.
    sourceRGB = new cv.Mat();

    cv.cvtColor(
      sourceRGBA,
      sourceRGB,
      cv.COLOR_RGBA2RGB
    );

    // Create the binary, single-channel inpainting mask.
    mask = new cv.Mat(
      height,
      width,
      cv.CV_8UC1
    );

    let selectedPixels = 0;

    for (let i = 0; i < pixelCount; i++) {
      const selected = maskData[i] > 0;

      mask.data[i] = selected ? 255 : 0;

      if (selected) {
        selectedPixels++;
      }
    }

    if (selectedPixels === 0) {
      throw new Error("The inpainting mask contains no selected pixels.");
    }

    destinationRGB = new cv.Mat();

    // OpenCV Telea reconstruction.
    cv.inpaint(
      sourceRGB,
      mask,
      destinationRGB,
      inpaintRadius,
      cv.INPAINT_TELEA
    );

    if (
      destinationRGB.rows !== height ||
      destinationRGB.cols !== width ||
      destinationRGB.channels() !== 3
    ) {
      throw new Error(
        "OpenCV returned an unexpected inpainting image."
      );
    }

    // Copy before releasing the OpenCV WASM matrix.
    const rgb = new Uint8Array(
      destinationRGB.data
    );

    return {
      rgb,
      selectedPixels,
      radius: inpaintRadius,
      method: "opencv-inpaint-telea",
    };

  } finally {
    for (const mat of [
      destinationRGB,
      mask,
      sourceRGB,
      sourceRGBA,
    ]) {
      if (mat && typeof mat.delete === "function") {
        mat.delete();
      }
    }
  }
}


self.addEventListener("message", async (event) => {
  const data = event.data;

  // -----------------------------------------------------
  // NEW: TELEA INPAINTING OPERATION
  // -----------------------------------------------------

  if (data?.type === "inpaint") {
    const requestId = data.requestId;

    try {
      const initialized = await cvReadyPromise;

      if (!initialized || !cvRuntime) {
        throw new Error(
          cvLoadError || "OpenCV runtime is unavailable."
        );
      }

      const result = inpaintCropWithTelea(
        {
          width: data.width,
          height: data.height,
          rgbaData: data.rgbaData,
          maskData: data.maskData,
          radius: data.radius,
        },
        cvRuntime
      );

      self.postMessage(
        {
          type: "inpaint-complete",
          requestId,

          width: data.width,
          height: data.height,

          rgb: result.rgb,

          selectedPixels: result.selectedPixels,
          radius: result.radius,
          method: result.method,
        },
        [result.rgb.buffer]
      );

    } catch (error) {
      self.postMessage({
        type: "inpaint-error",
        requestId,

        message:
          error?.stack ||
          error?.message ||
          String(error),
      });
    }

    return;
  }

  // -----------------------------------------------------
  // EXISTING: OCR LINE MEASUREMENT OPERATION
  // -----------------------------------------------------

  if (data?.type !== "measure") {
    return;
  }

  const imageBitmap = data.imageBitmap;
  const jobs = Array.isArray(data.jobs)
    ? data.jobs
    : [];

  const options = data.options || {};

  try {
const initialized = await cvReadyPromise;

if (!initialized || !cvRuntime) {
  throw new Error(
    cvLoadError || "OpenCV runtime is unavailable."
  );
}

const cv = cvRuntime;

    if (!imageBitmap) {
      throw new Error(
        "The measurement worker did not receive an ImageBitmap."
      );
    }

    const results = [];
    const total = jobs.length;

    for (let i = 0; i < total; i++) {
      const job = jobs[i];

      
      let inkBounds = null;
      let errorMessage = null;
      let wordSegmentation = null;
      let characterMeasurements = null;
      let characterMeasurementError = null;

      // Keep the original whole-line ink measurement.
      try {
        inkBounds = await detectInkBoundsOpenCV(
          imageBitmap,
          job.bounds,
          options,
          cv
        );
      } catch (error) {
        errorMessage =
          error?.message || String(error);
      }

      // New: independently segment this OCR line into words.
      // A segmentation error must not discard the line measurement.
      try {
        wordSegmentation = segmentWordsFromLine(
          imageBitmap,
          job,
          options,
          cv
        );
      } catch (error) {
        wordSegmentation = {
          status: "segmentation-error",
          message: error?.message || String(error),
          words: [],
        };

        console.error(
          `Word segmentation failed for line ${job.index}:`,
          error
        );
      }

      // Independently measure character ink using PaddleOCR's exact crop.
      try {
        characterMeasurements = measureCharactersFromLine(
          imageBitmap,
          job,
          options,
          cv
        );
      } catch (error) {
        characterMeasurementError =
          error?.stack || error?.message || String(error);

        characterMeasurements = {
          status: "character-measurement-error",
          method: "paddle-exact-crop-opencv",
          characters: [],
        };

        console.error(
          "Character measurement failed for line " + job.index + ":",
          error
        );
      }

      results.push({
  index: job.index,
  inkBounds,
  wordSegmentation,
  characterMeasurements,

  // Pass original glyph extraction to the main thread.
  originalGlyphShapeExtraction:
    characterMeasurements?.originalGlyphShapeExtraction ?? null,

  characterMeasurementError,
  errorMessage,
});

      // Notify the main thread after every rectangle.
      self.postMessage({
        type: "progress",
        completed: i + 1,
        total,
        index: job.index,
      });
    }

    self.postMessage({
      type: "complete",
      results,
      total,
    });

  } catch (error) {
    self.postMessage({
      type: "error",
      message:
        error?.stack ||
        error?.message ||
        String(error),
    });

  } finally {
    // This is the worker's transferred bitmap.
    if (imageBitmap && typeof imageBitmap.close === "function") {
      imageBitmap.close();
    }
  }
});
