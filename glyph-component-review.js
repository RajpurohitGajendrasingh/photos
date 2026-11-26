
/**
 * glyph-component-review.js
 *
 * Diagnostic-only component ownership review.
 *
 * IMPORTANT:
 * - Does not modify the original glyph mask.
 * - Does not delete or reassign pixels.
 * - Uses existing connected-component measurement evidence.
 * - Creates a separate colour-coded review panel.
 */

const REVIEW_STATUS = Object.freeze({
  LARGEST: {
    key: "largest-reference",
    label: "Largest reference component",
    color: "#1565c0",
    description:
      "Largest component in this glyph mask; this is a reference, not proof of ownership.",
  },

  SUPPORTED: {
    key: "measurement-supported",
    label: "Measurement-supported",
    color: "#2e7d32",
    description:
      "Existing refined-height measurement supports this component with strong overlap.",
  },

  PARTIAL: {
    key: "partial-measurement-support",
    label: "Partial measurement support — review",
    color: "#ef6c00",
    description:
      "Measurement evidence exists, but overlap is partial.",
  },

  EXCLUDED_AREA: {
    key: "excluded-below-area",
    label: "Excluded by minimum-area filter — review",
    color: "#8e24aa",
    description:
      "The measurement component was excluded by the existing minimum-area threshold.",
  },

  EXCLUDED_CENTER: {
    key: "excluded-center-tolerance",
    label: "Excluded by CTC-center filter — review",
    color: "#c62828",
    description:
      "The measurement component fell outside the existing CTC-center tolerance.",
  },

  EXCLUDED_OTHER: {
    key: "not-in-refined-height",
    label: "Not included in refined height — review",
    color: "#6d4c41",
    description:
      "Measurement evidence exists, but the component was not included in refined height.",
  },

  UNMAPPED: {
    key: "no-measurement-link",
    label: "No measurement link — review",
    color: "#616161",
    description:
      "No matching measurement-component evidence was found.",
  },
});

const STRONG_OVERLAP_RATIO = 0.8;
const DEFAULT_SCALE = 12;


/* ---------------------------------------------------------
   DATA NORMALIZATION
--------------------------------------------------------- */

function isTypedArray(value) {
  return (
    ArrayBuffer.isView(value) &&
    !(value instanceof DataView)
  );
}

function normalizeLabelMap(labelMap) {
  if (
    Array.isArray(labelMap) ||
    isTypedArray(labelMap)
  ) {
    return labelMap;
  }

  // Supports JSON-exported typed arrays.
  if (
    labelMap &&
    typeof labelMap === "object" &&
    Array.isArray(labelMap.data) &&
    typeof labelMap.__typedArray === "string"
  ) {
    return labelMap.data;
  }

  return null;
}


function normalizeRgba(rgba) {
  if (
    Array.isArray(rgba) ||
    isTypedArray(rgba)
  ) {
    return rgba;
  }

  if (
    rgba &&
    typeof rgba === "object" &&
    Array.isArray(rgba.data)
  ) {
    return rgba.data;
  }

  return null;
}

function getPercentile(sortedValues, percentile) {
  if (!sortedValues.length) return null;

  const index = Math.floor(
    (sortedValues.length - 1) * percentile
  );

  return sortedValues[index];
}

function calculateComponentGrayscaleStats(
  glyph,
  labelMap,
  components,
  width,
  height
) {
  const rgba = normalizeRgba(glyph?.rgba);

  const expectedLength =
    width * height * 4;

  const result = new Map();

  if (
    !rgba ||
    rgba.length !== expectedLength
  ) {
    console.warn(
      "[Glyph Component Review] RGBA unavailable or invalid."
    );

    return result;
  }

  const valuesById = new Map();

  for (const component of components) {
    valuesById.set(
      Number(component.id),
      []
    );
  }

  for (
    let i = 0;
    i < labelMap.length;
    i++
  ) {
    const id = Number(labelMap[i]);

    if (!id || !valuesById.has(id)) {
      continue;
    }

    const offset = i * 4;

    const red = Number(rgba[offset]);
    const green = Number(rgba[offset + 1]);
    const blue = Number(rgba[offset + 2]);
    const alpha = Number(rgba[offset + 3]);

    if (
      !Number.isFinite(red) ||
      !Number.isFinite(green) ||
      !Number.isFinite(blue) ||
      !Number.isFinite(alpha) ||
      alpha === 0
    ) {
      continue;
    }

    // Standard relative luminance approximation.
    const gray = Math.round(
      0.2126 * red +
      0.7152 * green +
      0.0722 * blue
    );

    valuesById.get(id).push(gray);
  }

  for (const [id, values] of valuesById) {
    if (!values.length) continue;

    const sorted = values.slice().sort(
      (a, b) => a - b
    );

    const sum = sorted.reduce(
      (total, value) => total + value,
      0
    );

    result.set(id, {
      sampleCount: sorted.length,

      min: sorted[0],

      p10: getPercentile(sorted, 0.10),

      median: getPercentile(sorted, 0.50),

      p90: getPercentile(sorted, 0.90),

      max: sorted[sorted.length - 1],

      mean: Number(
        (sum / sorted.length).toFixed(2)
      ),
    });
  }

  return result;
}


function getFiniteRatio(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


/* ---------------------------------------------------------
   COMPONENT CLASSIFICATION
--------------------------------------------------------- */

function classifyComponent(component) {
  const evidence = Array.isArray(
    component.measurementEvidence
  )
    ? component.measurementEvidence
    : [];

  const isLargest =
    component.flags?.isLargestComponent === true ||
    component.role === "largest-component";

  if (isLargest) {
    return REVIEW_STATUS.LARGEST;
  }

  const includedEvidence = evidence.filter(
    (item) =>
      item.measurementIncludedInRefinedHeight === true
  );

  const strongIncludedEvidence =
    includedEvidence.some((item) => {
      const diagnosticRatio =
        getFiniteRatio(
          item.overlapRatioOfDiagnostic
        );

      const glyphRatio =
        getFiniteRatio(
          item.overlapRatioOfGlyphComponent
        );

      return (
        diagnosticRatio !== null &&
        glyphRatio !== null &&
        diagnosticRatio >= STRONG_OVERLAP_RATIO &&
        glyphRatio >= STRONG_OVERLAP_RATIO
      );
    });

  if (strongIncludedEvidence) {
    return REVIEW_STATUS.SUPPORTED;
  }

  if (includedEvidence.length > 0) {
    return REVIEW_STATUS.PARTIAL;
  }

  const reasons = evidence
    .map(
      (item) => item.measurementExclusionReason
    )
    .filter(
      (reason) => typeof reason === "string"
    );

  if (
    reasons.includes(
      "below-vertical-component-area-threshold"
    )
  ) {
    return REVIEW_STATUS.EXCLUDED_AREA;
  }

  if (
    reasons.includes(
      "outside-ctc-center-tolerance"
    )
  ) {
    return REVIEW_STATUS.EXCLUDED_CENTER;
  }

  if (evidence.length > 0) {
    return REVIEW_STATUS.EXCLUDED_OTHER;
  }

  return REVIEW_STATUS.UNMAPPED;
}


/* ---------------------------------------------------------
   BUILD REVIEW MODEL
--------------------------------------------------------- */

/**
 * @param {object} analysis
 * Output from analyzeGlyphComponents().
 *
 * @param {object} glyph
 * Extracted glyph object.
 *
 * @returns {object}
 * Independent review data.
 */
export function analyzeGlyphComponentReview(
  analysis,
  glyph
) {
  if (
    !analysis ||
    analysis.status !== "complete"
  ) {
    throw new Error(
      "Connected-component analysis is not complete."
    );
  }

  const width = Number(
    glyph?.width ?? analysis.source?.width
  );

  const height = Number(
    glyph?.height ?? analysis.source?.height
  );

  const labelMap = normalizeLabelMap(
    analysis.labelMap
  );

  const components = Array.isArray(
    analysis.components
  )
    ? analysis.components
    : null;

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !labelMap ||
    labelMap.length !== width * height ||
    !components
  ) {
    throw new Error(
      "Invalid glyph dimensions or component label map."
    );
  }

  const componentById = new Map();

  for (const component of components) {
    const id = Number(component?.id);

    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      componentById.has(id)
    ) {
      throw new Error(
        "Invalid or duplicate connected-component ID."
      );
    }

    componentById.set(id, component);
  }

  // Independently count pixels in each component.
  // This verifies the supplied label map.
  const pixelCounts = new Map();

  for (let i = 0; i < labelMap.length; i++) {
    const id = Number(labelMap[i]);

    if (
      !Number.isInteger(id) ||
      id < 0
    ) {
      throw new Error(
        `Invalid component label at pixel ${i}.`
      );
    }

    if (id > 0) {
      if (!componentById.has(id)) {
        throw new Error(
          `Unknown component ID ${id} in label map.`
        );
      }

      pixelCounts.set(
        id,
        (pixelCounts.get(id) || 0) + 1
      );
    }
  }

  const reviewedComponents =
    components.map((component) => {

        const grayscaleById =
  calculateComponentGrayscaleStats(
    glyph,
    labelMap,
    components,
    width,
    height
  );

      const status =
        classifyComponent(component);

      const measuredPixelCount =
        pixelCounts.get(
          Number(component.id)
        ) || 0;

      const evidence = Array.isArray(
        component.measurementEvidence
      )
        ? component.measurementEvidence
        : [];

      return {
        id: component.id,

        pixelCount:
          component.pixelCount,

        measuredPixelCount,

        bounds:
          component.bounds,

        centroid:
          component.centroid,

        originalRole:
          component.role || "unclassified",

        distanceFromLargest:
          component.distanceFromLargest?.value ??
          null,

        touchesGlyphCropBoundary:
          component.touchesGlyphCropBoundary === true,

        reviewStatus:
          status.key,

        reviewLabel:
          status.label,

        reviewColor:
          status.color,

        reviewDescription:
          status.description,

      grayscale:
  grayscaleById.get(
    Number(component.id)
  ) || null,

measurementEvidenceCount:
  evidence.length,

measurementEvidence:
  evidence,
      };
    });

  const componentCountByStatus = {};
  const pixelCountByStatus = {};

  for (const component of reviewedComponents) {
    const key = component.reviewStatus;

    componentCountByStatus[key] =
      (componentCountByStatus[key] || 0) + 1;

    pixelCountByStatus[key] =
      (pixelCountByStatus[key] || 0) +
      component.measuredPixelCount;
  }

  const statusCodes = new Map(
    reviewedComponents.map(
      (component, index) => [
        Number(component.id),
        index + 1,
      ]
    )
  );

  // This is a new map.
  // The original analysis.labelMap is not modified.
  const reviewStatusMap =
    new Uint8Array(width * height);

  for (let i = 0; i < labelMap.length; i++) {
    const id = Number(labelMap[i]);

    reviewStatusMap[i] =
      id > 0
        ? statusCodes.get(id) || 0
        : 0;
  }

  return {
    status: "complete",

    method:
      "measurement-evidence-component-review-v1",

    coordinateSpace: "glyph-local",

    width,
    height,

    componentCount:
      reviewedComponents.length,

    foregroundPixelCount:
      reviewStatusMap.reduce(
        (count, code) =>
          count + (code > 0 ? 1 : 0),
        0
      ),

    componentCountByStatus,
    pixelCountByStatus,

    components:
      reviewedComponents,

    statusCodes:
      reviewedComponents.map(
        (component) => ({
          id: component.id,

          code:
            statusCodes.get(
              Number(component.id)
            ),

          status:
            component.reviewStatus,

          label:
            component.reviewLabel,

          color:
            component.reviewColor,
        })
      ),

    reviewStatusMap,

    safety: {
      originalMaskModified: false,
      pixelsRemoved: 0,
      pixelsAdded: 0,
      automaticOwnershipDecision: false,
    },

    note:
      "Diagnostic review only. No glyph pixels were removed, changed, or reassigned.",
  };
}


/* ---------------------------------------------------------
   DOM HELPERS
--------------------------------------------------------- */

function createElement(tag, styles = {}) {
  const element =
    document.createElement(tag);

  Object.assign(
    element.style,
    styles
  );

  return element;
}

function appendText(
  parent,
  tag,
  text,
  styles = {}
) {
  const element =
    createElement(tag, styles);

  element.textContent =
    String(text ?? "");

  parent.appendChild(element);

  return element;
}


/* ---------------------------------------------------------
   REVIEW CANVAS
--------------------------------------------------------- */

function createReviewCanvas(
  review,
  scale
) {
  const canvas =
    document.createElement("canvas");

  canvas.width =
    review.width * scale;

  canvas.height =
    review.height * scale;

  canvas.style.cssText =
    "display:block;" +
    "max-width:none;" +
    "image-rendering:pixelated;" +
    "border:1px solid #bbb;" +
    "background:#fff;";

  const ctx =
    canvas.getContext("2d");

  if (!ctx) {
    throw new Error(
      "Could not create component review canvas context."
    );
  }

  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = "#ffffff";

  ctx.fillRect(
    0,
    0,
    canvas.width,
    canvas.height
  );

  const colourByCode = new Map(
    review.statusCodes.map(
      (item) => [
        item.code,
        item.color,
      ]
    )
  );

  for (
    let y = 0;
    y < review.height;
    y++
  ) {
    for (
      let x = 0;
      x < review.width;
      x++
    ) {
      const code =
        review.reviewStatusMap[
          y * review.width + x
        ];

      if (!code) continue;

      ctx.fillStyle =
        colourByCode.get(code) ||
        "#616161";

      ctx.fillRect(
        x * scale,
        y * scale,
        scale,
        scale
      );
    }
  }

  // Fine grid for enlarged pixel inspection.
  ctx.beginPath();

  ctx.strokeStyle =
    "rgba(0, 0, 0, 0.14)";

  ctx.lineWidth = 0.5;

  for (
    let x = 0;
    x <= review.width;
    x++
  ) {
    ctx.moveTo(
      x * scale + 0.25,
      0
    );

    ctx.lineTo(
      x * scale + 0.25,
      canvas.height
    );
  }

  for (
    let y = 0;
    y <= review.height;
    y++
  ) {
    ctx.moveTo(
      0,
      y * scale + 0.25
    );

    ctx.lineTo(
      canvas.width,
      y * scale + 0.25
    );
  }

  ctx.stroke();

  return canvas;
}


/* ---------------------------------------------------------
   LEGEND
--------------------------------------------------------- */

function createLegend(review) {
  const legend = createElement(
    "div",
    {
      display: "flex",
      flexWrap: "wrap",
      gap: "8px 14px",
      marginTop: "10px",
      fontSize: "12px",
      lineHeight: "1.5",
    }
  );

  const seen = new Set();

  for (const component of review.components) {
    if (
      seen.has(component.reviewStatus)
    ) {
      continue;
    }

    seen.add(component.reviewStatus);

    const item = createElement(
      "span",
      {
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
      }
    );

    const swatch = createElement(
      "span",
      {
        display: "inline-block",
        width: "11px",
        height: "11px",
        borderRadius: "2px",
        background: component.reviewColor,
        border: "1px solid rgba(0,0,0,.2)",
        flex: "0 0 auto",
      }
    );

    item.appendChild(swatch);

    appendText(
      item,
      "span",
      component.reviewLabel
    );

    legend.appendChild(item);
  }

  return legend;
}


/* ---------------------------------------------------------
   COMPONENT EVIDENCE TABLE
--------------------------------------------------------- */

function createComponentTable(review) {
  const wrapper = createElement(
    "div",
    {
      marginTop: "10px",
      overflowX: "auto",
    }
  );

  const table = createElement(
    "table",
    {
      width: "100%",
      borderCollapse: "collapse",
      fontSize: "12px",
      lineHeight: "1.5",
    }
  );

const headers = [
  "ID",
  "Pixels",
  "Bounds (x, y, w, h)",
  "Grayscale (p10 / median / p90)",
  "Review status",
  "Evidence",
];

  const thead =
    document.createElement("thead");

  const headerRow =
    document.createElement("tr");

  for (const heading of headers) {
    const th = appendText(
      headerRow,
      "th",
      heading,
      {
        textAlign: "left",
        padding: "6px",
        borderBottom: "1px solid #ccc",
        whiteSpace: "nowrap",
        background: "#f7f7f7",
      }
    );

    th.scope = "col";
  }

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody =
    document.createElement("tbody");

  for (const component of review.components) {
    const tr =
      document.createElement("tr");

    const bounds =
      component.bounds || {};

    const boundsText = [
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
    ].join(", ");


    
   const measurementEvidence =
  Array.isArray(component.measurementEvidence)
    ? component.measurementEvidence
    : [];

const evidenceText =
  measurementEvidence.length
        ? component.measurementEvidence
            .map((item) => {
              const ratio =
                getFiniteRatio(
                  item.overlapRatioOfDiagnostic
                );

              const ratioText =
                ratio === null
                  ? "unknown"
                  : `${(
                      ratio * 100
                    ).toFixed(1)}%`;

              const included =
                item.measurementIncludedInRefinedHeight
                  ? "included"
                  : (
                      "not included" +
                      (
                        item.measurementExclusionReason
                          ? (
                              " (" +
                              item.measurementExclusionReason +
                              ")"
                            )
                          : ""
                      )
                    );

              return (
                `label ${item.measurementComponentLabel}: ` +
                `${ratioText} diagnostic overlap; ` +
                included
              );
            })
            .join("; ")
        : "No linked measurement component";

    appendText(
      tr,
      "td",
      component.id,
      {
        padding: "6px",
        borderBottom: "1px solid #eee",
        whiteSpace: "nowrap",
      }
    );

    appendText(
      tr,
      "td",
      component.measuredPixelCount,
      {
        padding: "6px",
        borderBottom: "1px solid #eee",
        whiteSpace: "nowrap",
      }
    );

    appendText(
      tr,
      "td",
      boundsText,
      {
        padding: "6px",
        borderBottom: "1px solid #eee",
        whiteSpace: "nowrap",
        fontFamily: "monospace",
      }
    );

const gray = component.grayscale;

const grayText = gray
  ? (
      `p10: ${gray.p10} | ` +
      `median: ${gray.median} | ` +
      `p90: ${gray.p90} | ` +
      `samples: ${gray.sampleCount}`
    )
  : "Unavailable";

appendText(
  tr,
  "td",
  grayText,
  {
    padding: "6px",
    borderBottom: "1px solid #eee",
    minWidth: "190px",
    whiteSpace: "nowrap",
    fontFamily: "monospace",
  }
);


    const statusCell = createElement(
      "td",
      {
        padding: "6px",
        borderBottom: "1px solid #eee",
        minWidth: "190px",
      }
    );

    const dot = createElement(
      "span",
      {
        display: "inline-block",
        width: "9px",
        height: "9px",
        marginRight: "6px",
        borderRadius: "2px",
        background: component.reviewColor,
        verticalAlign: "middle",
      }
    );

    statusCell.appendChild(dot);

    const statusText = appendText(
      statusCell,
      "span",
      component.reviewLabel
    );

    statusText.title =
      component.reviewDescription;

    tr.appendChild(statusCell);

    const evidenceCell = appendText(
      tr,
      "td",
      evidenceText,
      {
        padding: "6px",
        borderBottom: "1px solid #eee",
        minWidth: "250px",
        overflowWrap: "anywhere",
      }
    );

    evidenceCell.title = evidenceText;

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);

  return wrapper;
}


/* ---------------------------------------------------------
   PUBLIC PREVIEW PANEL
--------------------------------------------------------- */

/**
 * Creates an independent component ownership review panel.
 *
 * @param {object} analysis
 * Output from analyzeGlyphComponents().
 *
 * @param {object} glyph
 * Original extracted glyph.
 *
 * @param {object} options
 * Optional { scale } setting.
 *
 * @returns {HTMLElement}
 */
export function createGlyphComponentReviewPanel(
  analysis,
  glyph,
  {
    scale = DEFAULT_SCALE,
  } = {}
) {
  const panel = createElement(
    "section",
    {
      marginTop: "14px",
      padding: "12px",
      background: "#fff",
      border: "1px solid #ccc",
      borderRadius: "5px",
      minWidth: "0",
    }
  );

  appendText(
    panel,
    "strong",
    "5. Component ownership review",
    {
      display: "block",
      marginBottom: "8px",
      fontSize: "13px",
    }
  );

  let review;

  try {
    review =
      analyzeGlyphComponentReview(
        analysis,
        glyph
      );
  } catch (error) {
    appendText(
      panel,
      "p",
      `Review panel unavailable: ${error.message}`,
      {
        margin: "0",
        color: "#b00020",
        fontSize: "12px",
        whiteSpace: "pre-wrap",
      }
    );

    return panel;
  }

  const safeScale =
    Number.isInteger(scale) &&
    scale >= 2 &&
    scale <= 40
      ? scale
      : DEFAULT_SCALE;

  appendText(
    panel,
    "p",
    (
      `Components: ${review.componentCount} | ` +
      `Foreground pixels: ${review.foregroundPixelCount} | ` +
      `Glyph size: ${review.width} × ${review.height} px`
    ),
    {
      margin: "0 0 8px",
      fontSize: "12px",
      color: "#444",
    }
  );

  const canvasViewport = createElement(
    "div",
    {
      minHeight: "100px",
      overflow: "auto",
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "flex-start",
      padding: "8px",
      background: "#fafafa",
      border: "1px solid #eee",
    }
  );

  try {
    canvasViewport.appendChild(
      createReviewCanvas(
        review,
        safeScale
      )
    );
  } catch (error) {
    appendText(
      canvasViewport,
      "p",
      `Canvas unavailable: ${error.message}`,
      {
        margin: "0",
        color: "#b00020",
        fontSize: "12px",
      }
    );
  }

  panel.appendChild(canvasViewport);

  panel.appendChild(
    createLegend(review)
  );

  panel.appendChild(
    createComponentTable(review)
  );

  appendText(
    panel,
    "p",
    review.note,
    {
      margin: "10px 0 0",
      padding: "8px",
      border: "1px solid #ddd",
      background: "#fafafa",
      color: "#555",
      fontSize: "12px",
      lineHeight: "1.5",
    }
  );

  return panel;
}

export { REVIEW_STATUS };
