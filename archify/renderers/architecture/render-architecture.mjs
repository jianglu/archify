import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, renderDefinitions, renderSemanticSigil, textUnits } from '../shared/utils.mjs';
import { animateAttr, focusEdgeAttrs, focusNodeAttrs, focusNodeTitle, loadDiagramWithBrandMarks, writeDiagram, svgAccessibleText, svgRootAttrs } from '../shared/cli.mjs';
import { componentBox, boundaryBox, connectionPath } from '../shared/layout-report.mjs';
import { recordDiagnostic, throwDiagnosticProblems } from '../shared/diagnostics.mjs';
import { legendFootprint, relationshipLegendObstacles, resolveLegend, renderLegend as renderResolvedLegend } from '../shared/legend.mjs';
import { availableNodeTextWidth, fittedNodeFontSize, minimumNodeTextWidth } from '../shared/text-fit.mjs';
import { brandLabelFitWidth, brandMetadataFor, brandTopRailProblem, renderBrandMark } from '../shared/brand-marks.mjs';
import { minimumReadableSourceTextPx } from '../shared/desktop-readability.mjs';
import { translateMessage as i18nText } from '../shared/i18n.mjs';
import { gridLayout, resolveComponentPos, validateGridPlacement } from './grid.mjs';
import {
  asArray,
  isFinitePoint,
  rectsOverlap,
  segmentIntersectsRect,
  cleanEndpointSideProblems,
  cleanFlowProblems,
  cleanCrossingProblems,
  cleanAmbiguousCorridorProblems,
  cleanBorderRunProblems,
  cleanRouteRhythmProblems,
  cleanLabelRouteClearanceProblems,
  suggestLabelObstacleFix,
  suggestComponentSeparation,
  anchor,
  automaticPortSpread,
  automaticPortRhythmBridge,
  defaultFromSide,
  defaultToSide,
  chosenSide,
  routeHonorsEndpointSides,
  normalizeRoutePoints,
  routeMeetsRhythmFloors,
  routeSelfIntersects,
  simplifyRoutePoints,
  polylinePath,
  routePointsValue,
  roundedPath,
  labelPoint,
  componentFill,
  componentText,
  arrowClassMap,
  variantAccent,
} from '../shared/geometry.mjs';

const componentTextFit = {
  sublabelPreferred: 9,
  sublabelMinimum: 6,
  tagPreferred: 7,
  tagMinimum: 6,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const layoutJsonMode = process.argv.includes('--layout-json');
const cliArgs = process.argv.filter((arg) => arg !== '--layout-json');
const { diagram: arch, template, outPath, sourceEvidence } = await loadDiagramWithBrandMarks({
  rendererDir: __dirname,
  diagramType: 'architecture',
  defaultExample: 'web-app.architecture.json',
  argv: cliArgs,
});

const grid = gridLayout(arch);

const layout = {
  defaultW: 120,
  defaultH: 60,
  margin: 40,
  // Boundary padding — the 30/50 rule that was a hand-arithmetic footgun
  // (CHANGELOG v2.2.1): 30px on top/left/right, plus 20px extra at the bottom.
  boundaryPad: 30,
  boundaryExtraBottom: 20,
  boundaryLabelBaseline: 18,
  boundaryLabelClearance: 4,
  boundaryLabelFontPreferred: 9,
  boundaryLabelFontMinimum: 6,
  boundaryLabelMaskHeight: 16,
  boundaryLabelRailGap: 2,
  boundaryLabelFrameInset: 4,
  legendH: 28,
};

const LEGEND_CATALOG = [
  'frontend',
  'backend',
  'database',
  'cloud',
  'security',
  'messagebus',
  'external',
].map((kind) => ({ kind, label: i18nText(arch.meta.locale, `legend.architecture.${kind}`) }));

// ---- Measure components from free coordinates --------------------------------
function measureComponent(c) {
  const [x, y] = resolveComponentPos(c, grid);
  const [w, h] = Array.isArray(c.size) ? c.size : [layout.defaultW, layout.defaultH];
  return { ...c, x, y, width: w, height: h, cx: x + w / 2, cy: y + h / 2 };
}

const components = new Map(asArray(arch.components).map((c) => [c.id, measureComponent(c)]));
const enforcesBoundaryTitleComposition = Boolean(arch.meta?.quality_profile);
const componentSteps = new Map();
for (const [index, conn] of asArray(arch.connections).entries()) {
  if (!componentSteps.has(conn.from)) componentSteps.set(conn.from, index);
  if (!componentSteps.has(conn.to)) componentSteps.set(conn.to, index + 1);
}
for (const [index, c] of asArray(arch.components).entries()) {
  if (!componentSteps.has(c.id)) componentSteps.set(c.id, index);
}

// ---- Boundaries computed from the `wraps` id list ---------------------------
function boundaryRect(boundary) {
  const members = asArray(boundary.wraps).map((id) => components.get(id)).filter(Boolean);
  if (!members.length) return null;
  const minX = Math.min(...members.map((m) => m.x));
  const minY = Math.min(...members.map((m) => m.y));
  const maxX = Math.max(...members.map((m) => m.x + m.width));
  const maxY = Math.max(...members.map((m) => m.y + m.height));
  const pad = boundary.pad ?? layout.boundaryPad;
  const topPad = Math.max(
    pad,
    layout.boundaryLabelBaseline + layout.boundaryLabelClearance,
  );
  return {
    ...boundary,
    x: minX - pad,
    y: minY - topPad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + topPad + layout.boundaryExtraBottom,
    memberTop: minY,
  };
}

function rectContains(outer, inner) {
  const epsilon = 1e-9;
  return outer.x <= inner.x + epsilon
    && outer.y <= inner.y + epsilon
    && outer.x + outer.width + epsilon >= inner.x + inner.width
    && outer.y + outer.height + epsilon >= inner.y + inner.height;
}

function boundaryLabelWidth(label, fontSize) {
  return Math.max(30, textUnits(label) * fontSize * 0.6 + 10);
}

const architectureLegendEntries = resolveLegend(
  arch.meta?.legend,
  LEGEND_CATALOG,
  new Set([...components.values()].map((component) => component.type)),
);

function autoViewBoxFor(candidateBoundaries) {
  const maxX = Math.max(
    0,
    ...[...components.values()].map((component) => component.x + component.width),
    ...candidateBoundaries.map((boundary) => boundary.x + boundary.width),
  );
  const maxY = Math.max(
    0,
    ...[...components.values()].map((component) => component.y + component.height),
    ...candidateBoundaries.map((boundary) => boundary.y + boundary.height),
  );
  let width = Math.ceil(maxX + layout.margin);
  let footprint = legendFootprint(architectureLegendEntries, {
    width: Math.max(1, width - layout.margin * 2),
  });
  if (footprint.minWidth > width - layout.margin * 2) {
    width = Math.ceil(footprint.minWidth + layout.margin * 2);
    footprint = legendFootprint(architectureLegendEntries, {
      width: width - layout.margin * 2,
    });
  }
  return [
    width,
    Math.ceil(maxY + layout.margin + layout.legendH + footprint.extraHeight),
  ];
}

function resolvedViewBoxWidth(candidateBoundaries) {
  if (Array.isArray(arch.meta?.viewBox) && Number.isFinite(arch.meta.viewBox[0])) {
    return arch.meta.viewBox[0];
  }
  return autoViewBoxFor(candidateBoundaries)[0];
}

function expandBoundaryForReadableTitle(boundary, minimumFontSize) {
  if (!enforcesBoundaryTitleComposition) return boundary;
  const requiredWidth = boundaryLabelWidth(boundary.label, minimumFontSize)
    + layout.boundaryLabelFrameInset * 2;
  const extra = Math.max(0, requiredWidth - boundary.width);
  if (!extra) return boundary;
  return {
    ...boundary,
    x: boundary.x - extra / 2,
    width: boundary.width + extra,
  };
}

function measureBoundaryTitle(boundary, minimumFontSize) {
  const availableWidth = Math.max(0, boundary.width - layout.boundaryLabelFrameInset * 2);
  const units = textUnits(boundary.label);
  const fitted = units > 0
    ? (availableWidth - 10) / (units * 0.6)
    : layout.boundaryLabelFontPreferred;
  const preferredFontSize = Math.max(layout.boundaryLabelFontPreferred, minimumFontSize);
  const fontSize = Math.max(
    minimumFontSize,
    Math.min(preferredFontSize, fitted),
  );
  const desiredWidth = boundaryLabelWidth(boundary.label, fontSize);
  const height = Math.max(layout.boundaryLabelMaskHeight, Math.ceil(fontSize + 7));
  return {
    x: boundary.x + layout.boundaryLabelFrameInset,
    y: boundary.memberTop
      - layout.boundaryLabelClearance
      - height,
    width: Math.min(availableWidth, desiredWidth),
    height,
    fontSize,
    minimumFontSize,
    baselineOffset: fontSize + 4,
    availableWidth,
    minimumWidth: boundaryLabelWidth(boundary.label, minimumFontSize),
  };
}

function horizontalOverlap(left, right) {
  return left.x < right.x + right.width && left.x + left.width > right.x;
}

function layoutBoundaryTitles(rawBoundaries, minimumFontSize) {
  const placedTitles = [];
  const measured = new Map();
  const ordered = rawBoundaries
    .map((boundary, index) => ({ boundary, index }))
    .sort((left, right) => {
      const areaDelta = left.boundary.width * left.boundary.height
        - right.boundary.width * right.boundary.height;
      return areaDelta || left.index - right.index;
    });

  for (const entry of ordered) {
    const { index } = entry;
    const boundary = expandBoundaryForReadableTitle(entry.boundary, minimumFontSize);
    const title = measureBoundaryTitle(boundary, minimumFontSize);
    let guard = 0;
    while (guard < rawBoundaries.length + components.size + 1) {
      guard += 1;
      const blockers = [
        ...placedTitles,
        ...components.values(),
      ].filter((candidate) => horizontalOverlap(title, candidate) && rectsOverlap(title, candidate));
      if (!blockers.length) break;
      title.y = Math.min(
        ...blockers.map((blocker) => blocker.y - layout.boundaryLabelRailGap - title.height),
      );
    }
    placedTitles.push(title);
    measured.set(index, { boundary, title });
  }

  return rawBoundaries.map((_boundary, index) => {
    const { boundary, title } = measured.get(index);
    const bottom = boundary.y + boundary.height;
    // Profile-less schema-v1 inputs keep their legacy boundary geometry. A
    // quality profile opts into the stricter title-composition contract and
    // may expand the frame to contain an adapted title rail.
    const y = enforcesBoundaryTitleComposition
      ? Math.min(boundary.y, title.y - layout.boundaryLabelFrameInset)
      : boundary.y;
    return {
      ...boundary,
      y,
      height: bottom - y,
      title,
    };
  });
}

const rawBoundaries = asArray(arch.boundaries).map(boundaryRect).filter(Boolean);

// Nested boundary frames pad independently, so when the inner group's member
// is the outer group's extreme on an axis, both frames derive the same edge
// and their borders draw as one line. Keep a visible clearance between a
// membership-nested frame and its tightest wrapping frame on the bottom and
// side edges, never cutting into members. The top edge stays where the pads
// put it: titled diagrams have no room above the label rail, and dropping an
// untitled top can land the border on an existing route. Equal-membership
// boundaries (visual nesting through authored `pad`) follow the same rule
// once one frame geometrically contains the other; edges already outside
// their wrapper stay for validation to diagnose.
const NESTED_FRAME_CLEARANCE = 12;

function applyNestedFrameClearance(frames) {
  for (const inner of frames) {
    const outer = frames
      .filter((candidate) => (
        candidate !== inner
        && asArray(inner.wraps).length > 0
        && asArray(inner.wraps).every((id) => asArray(candidate.wraps).includes(id))
        && rectContains(candidate, inner)
      ))
      .sort((left, right) => (
        (left.width * left.height) - (right.width * right.height)
        || frames.indexOf(left) - frames.indexOf(right)
      ))[0];
    if (!outer) continue;
    const members = asArray(inner.wraps).map((id) => components.get(id)).filter(Boolean);
    if (!members.length) continue;
    const memberBottom = Math.max(...members.map((m) => m.y + m.height));
    const memberLeft = Math.min(...members.map((m) => m.x));
    const memberRight = Math.max(...members.map((m) => m.x + m.width));
    let { x, y, width, height } = inner;
    const insetBottom = () => {
      const gap = (outer.y + outer.height) - (y + height);
      if (gap < 0 || gap >= NESTED_FRAME_CLEARANCE) return;
      const desired = outer.y + outer.height - NESTED_FRAME_CLEARANCE;
      if (desired < memberBottom + 2) return;
      height = desired - y;
    };
    const insetLeft = () => {
      const gap = x - outer.x;
      if (gap < 0 || gap >= NESTED_FRAME_CLEARANCE) return;
      const desired = outer.x + NESTED_FRAME_CLEARANCE;
      if (desired > memberLeft - 2) return;
      width -= desired - x;
      x = desired;
    };
    const insetRight = () => {
      const gap = (outer.x + outer.width) - (x + width);
      if (gap < 0 || gap >= NESTED_FRAME_CLEARANCE) return;
      const desired = outer.x + outer.width - NESTED_FRAME_CLEARANCE;
      if (desired < memberRight + 2) return;
      width = desired - x;
    };
    insetBottom();
    insetLeft();
    insetRight();
    inner.x = x;
    inner.y = y;
    inner.width = width;
    inner.height = height;
  }
  return frames;
}
applyNestedFrameClearance(rawBoundaries);
function resolveBoundaryTitles() {
  if (!enforcesBoundaryTitleComposition || rawBoundaries.length === 0) {
    return {
      boundaries: layoutBoundaryTitles(rawBoundaries, layout.boundaryLabelFontMinimum),
      readabilityProblem: null,
    };
  }

  const maximumIterations = 32;
  let candidateBoundaries = rawBoundaries;
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    const budgetViewBoxWidth = resolvedViewBoxWidth(candidateBoundaries);
    const minimumFontSize = Math.max(
      layout.boundaryLabelFontMinimum,
      minimumReadableSourceTextPx(budgetViewBoxWidth) + 1e-6,
    );
    const nextBoundaries = layoutBoundaryTitles(rawBoundaries, minimumFontSize);
    const finalViewBoxWidth = resolvedViewBoxWidth(nextBoundaries);
    const finalMinimumFontSize = Math.max(
      layout.boundaryLabelFontMinimum,
      minimumReadableSourceTextPx(finalViewBoxWidth),
    );
    if (minimumFontSize >= finalMinimumFontSize) {
      return { boundaries: nextBoundaries, readabilityProblem: null };
    }
    candidateBoundaries = nextBoundaries;
  }

  const finalViewBoxWidth = resolvedViewBoxWidth(candidateBoundaries);
  return {
    boundaries: candidateBoundaries,
    readabilityProblem: `[composition/desktop-readability] Boundary title layout did not converge after ${maximumIterations} iterations for the final ${finalViewBoxWidth}px viewBox — shorten boundary labels, provide a wider authored viewBox, or move wrapped components closer to the left edge.`,
  };
}

const resolvedBoundaryTitles = resolveBoundaryTitles();
const boundaries = resolvedBoundaryTitles.boundaries;
const compositionFrames = boundaries.map((boundary, index) => ({
  ...boundary,
  id: boundary.id || index,
  kind: boundary.kind || 'boundary',
  radius: boundary.kind === 'security-group' ? 8 : 12,
}));

function componentContext(component) {
  const scopes = boundaries
    .filter((boundary) => asArray(boundary.wraps).includes(component.id))
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))
    .map((boundary) => boundary.label);
  return scopes.length ? scopes.join(' › ') : i18nText(arch.meta.locale, 'node.context.architecture');
}

// ---- Auto viewBox: fit all geometry + the measured resolved legend ----------
const viewBox = arch.meta?.viewBox || autoViewBoxFor(boundaries);
const legendY = () => viewBox[1] - 16;

// ---- Validation: mechanical correctness, never layout taste -----------------
function validateArchitecture() {
  const problems = [];
  if (resolvedBoundaryTitles.readabilityProblem) {
    problems.push(resolvedBoundaryTitles.readabilityProblem);
  }
  const requiresNestedBoundaryMembership = arch.meta?.engineering_profile === 'deployment-ownership';
  if (components.size !== asArray(arch.components).length) problems.push('Component ids must be unique.');
  if (grid) {
    validateGridPlacement(arch, grid, problems);
  } else {
    for (const c of asArray(arch.components)) {
      if (!Array.isArray(c.pos) || c.pos.length !== 2) {
        problems.push(`Component "${c.id}" must include pos [x, y] when layout.mode is omitted (free placement).`);
      }
    }
  }

  for (const c of components.values()) {
    if (!isFinitePoint(c.x, c.y, c.width, c.height)) {
      problems.push(`Component "${c.id}" has non-finite pos/size — pos and size must be [number, number].`);
      continue;
    }
    if (c.width <= 0 || c.height <= 0) {
      problems.push(`Component "${c.id}" has invalid size ${c.width}x${c.height} — width and height must be greater than 0.`);
      continue;
    }
    if (c.x < 0 || c.y < 0 || c.x + c.width > viewBox[0] || c.y + c.height > viewBox[1]) {
      problems.push(`Component "${c.id}" falls outside the viewBox ${viewBox[0]}x${viewBox[1]} — adjust pos/size or set a larger meta.viewBox.`);
    }
    const estLabelW = textUnits(c.label) * 6.6;
    if (estLabelW > c.width + 8) {
      problems.push(`Label "${c.label}" (~${Math.round(estLabelW)}px) is wider than component "${c.id}" (${c.width}px) — shorten the label or widen size.`);
    }
    const brandRailProblem = brandTopRailProblem(c, c.width, 8, 'Component');
    if (brandRailProblem) problems.push(brandRailProblem);
    // sublabel and tag render as single unwrapped <text> elements; shrink-to-fit
    // handles the ordinary case, this rejects what it cannot rescue.
    const availableTextW = availableNodeTextWidth(c.width);
    for (const [field, value, minimum] of [
      ['Sublabel', c.sublabel, componentTextFit.sublabelMinimum],
      ['Tag', c.tag, componentTextFit.tagMinimum],
    ]) {
      if (!value) continue;
      const minimumW = minimumNodeTextWidth(value, minimum);
      if (minimumW > availableTextW) {
        problems.push(`${field} "${value}" needs ~${Math.ceil(minimumW)}px at the ${minimum}px legible minimum, but component "${c.id}" provides ${availableTextW}px — shorten the ${field.toLowerCase()} or widen size.`);
      }
    }
  }

  // Component overlap — the highest-traffic hand-placement failure mode.
  const list = [...components.values()];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (rectsOverlap(list[i], list[j], 8)) {
        problems.push(`Components "${list[i].id}" and "${list[j].id}" are less than 8px apart — move one or shrink its size.\n${suggestComponentSeparation(list[i], list[j], 8)}`);
      }
    }
  }

  // Boundaries: every wrapped id must exist; the computed box must stay in view.
  for (const boundary of asArray(arch.boundaries)) {
    for (const id of asArray(boundary.wraps)) {
      if (!components.has(id)) problems.push(`Boundary "${boundary.label}" wraps unknown component "${id}".`);
    }
  }
  const viewBoxRect = { x: 0, y: 0, width: viewBox[0], height: viewBox[1] };
  for (const boundary of boundaries) {
    if (!enforcesBoundaryTitleComposition) continue;
    if (boundary.title.minimumWidth > boundary.title.availableWidth) {
      problems.push(
        `Boundary label "${boundary.label}" needs ~${Math.ceil(boundary.title.minimumWidth)}px to fit at the `
        + `${Number(boundary.title.minimumFontSize.toFixed(2))}px desktop-readable source minimum, but its frame provides ${Math.floor(boundary.title.availableWidth)}px — `
        + 'shorten the boundary label, increase pad, or widen the wrapped component layout.',
      );
    }
    if (!rectContains(boundary, boundary.title)) {
      problems.push(
        `Boundary label "${boundary.label}" extends outside its final frame — shorten the label or increase boundary pad.`,
      );
    }
    if (!rectContains(viewBoxRect, boundary.title)) {
      problems.push(
        `Boundary label "${boundary.label}" extends outside the viewBox — move wrapped components away from the canvas edge, shorten the label, or increase the viewBox.`,
      );
    }
    for (const component of components.values()) {
      if (!rectsOverlap(boundary.title, component)) continue;
      problems.push(
        `Boundary label "${boundary.label}" overlaps component "${component.id}" — move the component, increase boundary title space, or shorten the label.`,
      );
    }
  }
  for (let leftIndex = 0; leftIndex < boundaries.length; leftIndex += 1) {
    const left = boundaries[leftIndex];
    const leftMembers = new Set(asArray(left.wraps));
    for (let rightIndex = leftIndex + 1; rightIndex < boundaries.length; rightIndex += 1) {
      const right = boundaries[rightIndex];
      if (enforcesBoundaryTitleComposition && rectsOverlap(left.title, right.title)) {
        problems.push(
          `Boundary labels "${left.label}" and "${right.label}" overlap — shorten a label or increase boundary title space.`,
        );
      }
      // Ordinary architecture boundaries are sets, not an implied ownership
      // tree: orthogonal scopes such as runtime and compliance may share some
      // components while each contains others. The opt-in deployment profile
      // does promise hierarchical region/private-scope membership, so only it
      // receives the stricter membership-to-frame containment contract.
      if (!requiresNestedBoundaryMembership) continue;
      const rightMembers = new Set(asArray(right.wraps));
      const shared = [...leftMembers].filter((id) => rightMembers.has(id));
      const leftNested = [...leftMembers].every((id) => rightMembers.has(id));
      const rightNested = [...rightMembers].every((id) => leftMembers.has(id));
      if (shared.length && !leftNested && !rightNested) {
        const leftOnly = [...leftMembers].filter((id) => !rightMembers.has(id));
        const rightOnly = [...rightMembers].filter((id) => !leftMembers.has(id));
        problems.push(
          `Boundary "${left.label}" crosses boundary "${right.label}" because their memberships partially overlap `
          + `(shared: ${shared.map((id) => `"${id}"`).join(', ')}; `
          + `only in "${left.label}": ${leftOnly.map((id) => `"${id}"`).join(', ')}; `
          + `only in "${right.label}": ${rightOnly.map((id) => `"${id}"`).join(', ')}) — `
          + 'keep one boundary fully nested by removing outside members, or split the boundary.',
        );
        continue;
      }

      if (!rectsOverlap(left, right)) continue;
      const leftContainsRight = rectContains(left, right);
      const rightContainsLeft = rectContains(right, left);
      if (!leftContainsRight && !rightContainsLeft) {
        problems.push(
          `Boundary "${left.label}" and boundary "${right.label}" final frames partially overlap — `
          + 'adjust wraps, pad, or component positions so the frames are disjoint or one fully contains the other.',
        );
        continue;
      }

      if (!shared.length) {
        problems.push(
          `Boundary "${left.label}" and boundary "${right.label}" final frames overlap even though their memberships are disjoint — `
          + 'adjust pad or component positions so the frames are disjoint, or make wraps express the intended nesting.',
        );
        continue;
      }

      const containmentMatchesMembership = (leftNested && rightContainsLeft)
        || (rightNested && leftContainsRight);
      if (!containmentMatchesMembership) {
        problems.push(
          `Boundary "${left.label}" and boundary "${right.label}" final frame containment contradicts their wraps membership — `
          + 'reduce the inner boundary pad, move its components, or correct wraps so geometry and nesting agree.',
        );
      }
    }
  }
  for (const b of boundaries) {
    if (b.x < 0 || b.y < 0 || b.x + b.width > viewBox[0] || b.y + b.height > viewBox[1]) {
      problems.push(`Boundary "${b.label}" extends outside the viewBox — its members sit too close to the canvas edge; add margin or enlarge meta.viewBox.`);
    }
  }
  // Boundary frames may overlap only through intentional structure: one
  // frame fully nested inside another, or boundaries sharing a wrapped
  // component (the shared component explains the intersecting region).
  // Anything else is a silent visual defect.
  for (let left = 0; left < boundaries.length; left += 1) {
    for (let right = left + 1; right < boundaries.length; right += 1) {
      const a = boundaries[left];
      const b = boundaries[right];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlapX <= 0.0001 || overlapY <= 0.0001) continue;
      const contains = (outer, inner) => (
        outer.x <= inner.x + 0.0001
        && outer.y <= inner.y + 0.0001
        && outer.x + outer.width >= inner.x + inner.width - 0.0001
        && outer.y + outer.height >= inner.y + inner.height - 0.0001
      );
      if (contains(a, b) || contains(b, a)) continue;
      const sharesComponent = asArray(a.wraps).some((id) => asArray(b.wraps).includes(id));
      if (sharesComponent) continue;
      const moveHint = overlapY <= overlapX
        ? `down by ${Math.round(overlapY + 8)}px`
        : `right by ${Math.round(overlapX + 8)}px`;
      problems.push(
        `Boundary "${a.label}" and boundary "${b.label}" overlap by ${Math.round(overlapX)}×${Math.round(overlapY)}px without nesting or a shared wrapped component — `
        + `move one group's wrapped components ${moveHint} so the frames clear each other (grow meta.viewBox if needed), or wrap the shared component in both boundaries.`,
      );
    }
  }

  for (const conn of asArray(arch.connections)) {
    if (!components.has(conn.from)) problems.push(`Connection "${conn.label || conn.from}" references unknown source "${conn.from}".`);
    if (!components.has(conn.to)) problems.push(`Connection "${conn.label || conn.to}" references unknown target "${conn.to}".`);
    if (components.has(conn.from) && components.has(conn.to)) {
      const routed = pathFor(conn);
      const [start, end] = [routed.points[0], routed.points[routed.points.length - 1]];
      const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
      if (distance < 24) problems.push(`Connection "${conn.label || `${conn.from}->${conn.to}`}" is too short (${Math.round(distance)}px; minimum 24px) — place its components farther apart.`);
    }
  }

  problems.push(...cleanEndpointSideProblems({
    relations: arch.connections,
    endpointIds: new Set(components.keys()),
    pathFor,
    diagramType: 'architecture',
    relationCollection: 'connections',
    fromSideFor: (conn) => connectionEndpointSide(conn, 'source'),
    toSideFor: (conn) => connectionEndpointSide(conn, 'target'),
    routeHint: 'keep automatic routing so the renderer can use a side-aware bridge, or set truthful fromSide/toSide with perpendicular via segments',
  }));
  problems.push(...cleanFlowProblems({
    relations: arch.connections,
    obstacles: components.values(),
    pathFor,
    diagramType: 'architecture',
    relationCollection: 'connections',
    obstacleKind: 'component',
    routeHint: 'adjust fromSide/toSide, set route/via, or move the component'
  }));
  problems.push(...cleanCrossingProblems({
    relations: arch.connections,
    endpointIds: new Set(components.keys()),
    pathFor,
    diagramType: 'architecture',
    relationCollection: 'connections',
    profile: arch.meta?.quality_profile,
    routeHint: 'adjust route/via or fromSide/toSide so the connections use separate corridors'
  }));
  problems.push(...cleanAmbiguousCorridorProblems({
    relations: arch.connections,
    endpointIds: new Set(components.keys()),
    pathFor,
    diagramType: 'architecture',
    relationCollection: 'connections',
    profile: arch.meta?.quality_profile,
    routeHint: 'adjust route/via or fromSide/toSide so unrelated connections do not visually merge'
  }));
  problems.push(...cleanBorderRunProblems({
    relations: arch.connections,
    endpointIds: new Set(components.keys()),
    frames: compositionFrames,
    pathFor,
    diagramType: 'architecture',
    relationCollection: 'connections',
    profile: arch.meta?.quality_profile,
    routeHint: 'adjust route/via or fromSide/toSide so the connection crosses the boundary perpendicularly instead of following its border'
  }));
  problems.push(...cleanRouteRhythmProblems({
    relations: arch.connections,
    endpointIds: new Set(components.keys()),
    pathFor,
    diagramType: 'architecture',
    relationCollection: 'connections',
    profile: arch.meta?.quality_profile,
    routeHint: 'move route/via points into a wider corridor or move the component so every turn has room to read'
  }));

  // Connection labels must not land on top of components.
  const labelRects = [];
  for (const [connectionIndex, conn] of asArray(arch.connections).entries()) {
    if (!conn.label || !components.has(conn.from) || !components.has(conn.to)) continue;
    const [lx, ly] = labelPoint(conn, pathFor(conn).points);
    const w = Math.max(30, textUnits(conn.label) * 4.8 + 10);
    labelRects.push({ relation: conn, relationIndex: connectionIndex, label: conn.label, x: lx - w / 2, y: ly - 10, width: w, height: 14, lx, ly });
  }
  for (const rect of labelRects) {
    for (const c of components.values()) {
      if (rectsOverlap(rect, c, -2)) {
        problems.push(`Label "${rect.label}" overlaps component "${c.id}" — adjust labelDx/labelDy/labelSegment or set labelAt.\n${suggestLabelObstacleFix(rect, rect.lx, rect.ly, c)}`);
      }
    }
    if (enforcesBoundaryTitleComposition) {
      for (const boundary of boundaries) {
        if (!rectsOverlap(boundary.title, rect)) continue;
        problems.push(
          `Boundary label "${boundary.label}" overlaps connection label "${rect.label}" — move the boundary title rail by adjusting wrapped component positions, or move the connection label with labelAt/labelDx/labelDy/labelSegment.`,
        );
      }
    }
  }
  problems.push(...cleanLabelRouteClearanceProblems({
    relations: arch.connections,
    labels: labelRects,
    endpointIds: new Set(components.keys()),
    pathFor,
    diagramType: 'architecture',
    relationCollection: 'connections',
    profile: arch.meta?.quality_profile,
  }));

  // Alignment advisories are warnings, not layout failures: recorded for the
  // repair receipt, never thrown.
  for (const advisory of alignmentBendAdvisories()) recordDiagnostic(advisory);
  for (const advisory of canvasUnderfillAdvisories()) recordDiagnostic(advisory);

  if (problems.length) {
    throwDiagnosticProblems('Architecture layout validation failed', problems, {
      subject: { diagramType: 'architecture' },
    });
  }
}

function buildLayoutReport() {
  const labels = [];
  for (const conn of asArray(arch.connections)) {
    if (!conn.label || !components.has(conn.from) || !components.has(conn.to)) continue;
    const [lx, ly] = labelPoint(conn, pathFor(conn).points);
    const w = Math.max(30, textUnits(conn.label) * 4.8 + 10);
    labels.push({
      text: conn.label,
      x: Math.round(lx - w / 2),
      y: Math.round(ly - 10),
      width: Math.round(w),
      height: 14,
      labelAt: [Math.round(lx), Math.round(ly)],
    });
  }
  return {
    ok: true,
    diagram_type: 'architecture',
    layout: grid ? { mode: 'grid', ...grid } : { mode: 'free' },
    viewBox,
    components: [...components.values()].map(componentBox),
    boundaries: boundaries.map(boundaryBox),
    connections: asArray(arch.connections)
      .filter((conn) => components.has(conn.from) && components.has(conn.to))
      .map((conn) => {
        const routed = pathFor(conn);
        const labelAt = conn.label ? labelPoint(conn, routed.points) : null;
        return connectionPath(conn, routed, labelAt);
      }),
    labels,
  };
}

// ---- Connection routing ------------------------------------------------------
function routeClearsComponents(conn, points, clearance = 2) {
  const endpointIds = new Set([conn.from, conn.to]);
  for (const component of components.values()) {
    if (endpointIds.has(component.id)) continue;
    for (let index = 0; index < points.length - 1; index += 1) {
      if (segmentIntersectsRect({ start: points[index], end: points[index + 1] }, component, clearance)) {
        return false;
      }
    }
  }
  return true;
}

function routeClearsEndpointComponents(points, from, to) {
  const lastSegment = points.length - 2;
  for (let index = 0; index <= lastSegment; index += 1) {
    const segment = { start: points[index], end: points[index + 1] };
    if (index > 0 && segmentIntersectsRect(segment, from)) return false;
    if (index < lastSegment && segmentIntersectsRect(segment, to)) return false;
  }
  return true;
}

const OUTWARD_SIDE_VECTOR = {
  left: [-1, 0],
  right: [1, 0],
  top: [0, -1],
  bottom: [0, 1],
};

function outwardStub(point, side, distance = 24) {
  const [dx, dy] = OUTWARD_SIDE_VECTOR[side] || [0, 0];
  return [point[0] + dx * distance, point[1] + dy * distance];
}

function collinearBacktrack(a, b, c) {
  const first = [b[0] - a[0], b[1] - a[1]];
  const second = [c[0] - b[0], c[1] - b[1]];
  const cross = first[0] * second[1] - first[1] * second[0];
  const dot = first[0] * second[0] + first[1] * second[1];
  return Math.abs(cross) <= 0.0001 && dot < -0.0001;
}

function sideAwareBridgeCandidates(start, end, fromSide, toSide) {
  const startStub = outwardStub(start, fromSide);
  const endStub = outwardStub(end, toSide);
  const rawCandidates = [];
  const minimumBridge = 16;
  const verticalSides = new Set(['top', 'bottom']);
  const horizontalSides = new Set(['left', 'right']);

  // Port spreading can leave parallel-side anchors only a few pixels apart.
  // Route through a bounded outside channel so we keep both endpoint normals
  // without introducing a tiny, noisy connector between the two stubs.
  if (verticalSides.has(fromSide) && verticalSides.has(toSide)
      && Math.abs(start[0] - end[0]) < minimumBridge) {
    for (const channelX of [
      Math.max(start[0], end[0]) + minimumBridge,
      Math.min(start[0], end[0]) - minimumBridge,
    ]) {
      rawCandidates.push([
        startStub,
        [channelX, startStub[1]],
        [channelX, endStub[1]],
        endStub,
      ]);
    }
  }
  if (horizontalSides.has(fromSide) && horizontalSides.has(toSide)
      && Math.abs(start[1] - end[1]) < minimumBridge) {
    for (const channelY of [
      Math.max(start[1], end[1]) + minimumBridge,
      Math.min(start[1], end[1]) - minimumBridge,
    ]) {
      rawCandidates.push([
        startStub,
        [startStub[0], channelY],
        [endStub[0], channelY],
        endStub,
      ]);
    }
  }

  rawCandidates.push(
    [startStub, [endStub[0], startStub[1]], endStub],
    [startStub, [startStub[0], endStub[1]], endStub],
  );
  return rawCandidates.map((candidate) => normalizeRoutePoints([start, ...candidate, end]))
    .filter((points) => points.length >= 2)
    .filter((points) => !collinearBacktrack(points[0], points[1], points[2] || points[1]))
    .filter((points) => !collinearBacktrack(points.at(-3) || points.at(-2), points.at(-2), points.at(-1)))
    .filter((points) => routeHonorsEndpointSides(points, fromSide, toSide))
    .map((points) => points.slice(1, -1));
}

const AUTOMATIC_PORT_CORNER_GUTTER = 16;
const AUTOMATIC_PORT_ALIGNMENT_DELTA = 16;

function portHasCornerClearance(rect, side, point) {
  if (side === 'left' || side === 'right') {
    const inset = Math.min(AUTOMATIC_PORT_CORNER_GUTTER, rect.height / 2);
    return point[1] >= rect.y + inset && point[1] <= rect.y + rect.height - inset;
  }
  if (side === 'top' || side === 'bottom') {
    const inset = Math.min(AUTOMATIC_PORT_CORNER_GUTTER, rect.width / 2);
    return point[0] >= rect.x + inset && point[0] <= rect.x + rect.width - inset;
  }
  return false;
}

function alignFacingPorts(conn, from, to, start, end, fromSide, toSide, ports) {
  const hasExplicitGeometry = (
    conn.via
    || (conn.route && conn.route !== 'auto')
    || conn.channelX !== undefined
    || conn.channelY !== undefined
    || conn.labelAt
  );
  const horizontallyFacing = (
    (fromSide === 'right' && toSide === 'left')
    || (fromSide === 'left' && toSide === 'right')
  );
  const verticallyFacing = (
    (fromSide === 'bottom' && toSide === 'top')
    || (fromSide === 'top' && toSide === 'bottom')
  );
  if (hasExplicitGeometry || (!horizontallyFacing && !verticallyFacing)) return { start, end };

  const fromSpread = Boolean(ports?.from);
  const toSpread = Boolean(ports?.to);
  if (fromSpread && toSpread) return { start, end };
  const hasExplicitSides = (
    (conn.fromSide && conn.fromSide !== 'auto')
    || (conn.toSide && conn.toSide !== 'auto')
  );
  if (!fromSpread && !toSpread && hasExplicitSides) return { start, end };

  const alignmentDelta = horizontallyFacing
    ? Math.abs(start[1] - end[1])
    : Math.abs(start[0] - end[0]);
  if (alignmentDelta >= AUTOMATIC_PORT_ALIGNMENT_DELTA) return { start, end };

  // Keep the shared endpoint's distinct spread slot and move only the
  // relationship's unshared endpoint onto that axis. With no spread endpoint,
  // retain the existing least-movement choice between the two facing sides.
  // If both endpoints are shared, preserve the outside bridge so no competing
  // port is silently collapsed.
  const alignEndToStart = horizontallyFacing
    ? { start, end: [end[0], start[1]] }
    : { start, end: [start[0], end[1]] };
  const alignStartToEnd = horizontallyFacing
    ? { start: [start[0], end[1]], end }
    : { start: [end[0], start[1]], end };
  const candidates = fromSpread
    ? [alignEndToStart]
    : toSpread
      ? [alignStartToEnd]
      : [alignEndToStart, alignStartToEnd];
  for (const candidate of candidates) {
    const points = [candidate.start, candidate.end];
    if (portHasCornerClearance(from, fromSide, candidate.start)
        && portHasCornerClearance(to, toSide, candidate.end)
        && routeHonorsEndpointSides(points, fromSide, toSide)
        && routeClearsEndpointComponents(points, from, to)
        && routeClearsComponents(conn, points)) {
      return candidate;
    }
  }
  return { start, end };
}

function routeVia(conn, from, to, start, end, fromSide, toSide) {
  if (conn.via) return conn.via;
  switch (conn.route || 'auto') {
    case 'straight':
      return [];
    case 'orthogonal-h': {
      const midX = (start[0] + end[0]) / 2;
      return [[midX, start[1]], [midX, end[1]]];
    }
    case 'orthogonal-v': {
      const midY = (start[1] + end[1]) / 2;
      return [[start[0], midY], [end[0], midY]];
    }
    case 'auto':
    default: {
      // Direct line unless the anchors are clearly orthogonal-friendly.
      const deltaX = Math.abs(start[0] - end[0]);
      const deltaY = Math.abs(start[1] - end[1]);
      if ((deltaX < 4 || deltaY < 4) && routeHonorsEndpointSides([start, end], fromSide, toSide)) return [];

      // Prefer the fewest bends that still honors endpoint directions, keeps
      // clear of components, and respects the 8px/16px route-rhythm floors the
      // showcase gates enforce. The stub bridge stays a fallback for spread
      // ports that no simpler candidate can serve, not the default shape.
      const clearsCandidate = (points) => (
        routeHonorsEndpointSides(points, fromSide, toSide)
        && routeClearsEndpointComponents(points, from, to)
        && routeClearsComponents(conn, points)
        && routeMeetsRhythmFloors(points)
        && !routeSelfIntersects(points)
      );

      // Single-bend routes enter along the target's own axis, which mixed
      // endpoint sides (e.g. right -> top) allow outright.
      for (const corner of [[end[0], start[1]], [start[0], end[1]]]) {
        if (clearsCandidate([start, corner, end])) return [corner];
      }

      // Automatic port spreading can leave otherwise aligned endpoints only a
      // few pixels apart. A midpoint route would split that tiny difference
      // into two unreadable endpoint stubs, so take a bounded outside channel
      // when both anchors sit on parallel component sides.
      const minimumStub = 8;
      const fromVerticalSide = start[1] === from.y || start[1] === from.y + from.height;
      const toVerticalSide = end[1] === to.y || end[1] === to.y + to.height;
      if (fromVerticalSide && toVerticalSide && deltaX < minimumStub * 2) {
        const outsideChannels = [
          Math.max(start[0], end[0]) + minimumStub * 2,
          Math.min(start[0], end[0]) - minimumStub * 2,
        ];
        for (const channelX of outsideChannels) {
          const candidate = [[channelX, start[1]], [channelX, end[1]]];
          if (clearsCandidate([start, ...candidate, end])) return candidate;
        }
      }

      const fromHorizontalSide = start[0] === from.x || start[0] === from.x + from.width;
      const toHorizontalSide = end[0] === to.x || end[0] === to.x + to.width;
      if (fromHorizontalSide && toHorizontalSide && deltaY < minimumStub * 2) {
        const outsideChannels = [
          Math.max(start[1], end[1]) + minimumStub * 2,
          Math.min(start[1], end[1]) - minimumStub * 2,
        ];
        for (const channelY of outsideChannels) {
          const candidate = [[start[0], channelY], [end[0], channelY]];
          if (clearsCandidate([start, ...candidate, end])) return candidate;
        }
      }

      const midX = (start[0] + end[0]) / 2;
      const horizontalFirst = [[midX, start[1]], [midX, end[1]]];
      const midY = (start[1] + end[1]) / 2;
      const verticalFirst = [[start[0], midY], [end[0], midY]];
      const candidates = [horizontalFirst, verticalFirst];
      const sideSafe = candidates.filter((candidate) => (
        routeHonorsEndpointSides([start, ...candidate, end], fromSide, toSide)
      ));
      const sideAware = sideAwareBridgeCandidates(start, end, fromSide, toSide);
      // Cramped doglegs are rejected by the rhythm floors above (including the
      // readable-jog exemption), so the plain side-safe candidates — which
      // carry fewer bends than the stub bridges — always get first refusal.
      const ordered = [
        ...sideSafe,
        ...sideAware,
        ...candidates.filter((candidate) => !sideSafe.includes(candidate)),
      ];
      for (const candidate of ordered) {
        const points = [start, ...candidate, end];
        if (routeClearsEndpointComponents(points, from, to)
            && routeClearsComponents(conn, points)
            && routeMeetsRhythmFloors(points)
            && !routeSelfIntersects(points)) return candidate;
      }

      const rhythmBridge = automaticPortRhythmBridge(start, end, fromSide, toSide, {
        accept: (points) => (
          routeClearsEndpointComponents(points, from, to)
          && routeClearsComponents(conn, points)
          && !routeSelfIntersects(points)
        ),
      });
      if (rhythmBridge) return rhythmBridge.slice(1, -1);

      // Both bounded doglegs are blocked. Keep the best endpoint-safe route
      // when one exists so the universal Clean Flow gate reports the actual
      // obstacle; otherwise preserve the historical deterministic fallback
      // and let the endpoint-direction gate explain the side mismatch. A
      // self-crossing fallback would render as a loop, so skip those too.
      const fallbacks = [...sideSafe, ...sideAware, horizontalFirst];
      return fallbacks.find((candidate) => !routeSelfIntersects([start, ...candidate, end]))
        || horizontalFirst;
    }
  }
}

const pathCache = new Map();
const automaticPorts = automaticPortSpread(arch.connections, components);
function connectionSides(conn) {
  const from = components.get(conn.from);
  const to = components.get(conn.to);
  return {
    fromSide: chosenSide(conn.fromSide, defaultFromSide(from, to)),
    toSide: chosenSide(conn.toSide, defaultToSide(from, to)),
  };
}

function connectionEndpointSide(conn, endpoint) {
  const field = endpoint === 'source' ? 'fromSide' : 'toSide';
  if (conn[field] && conn[field] !== 'auto') return conn[field];
  return connectionSides(conn)[field];
}

function pathFor(conn) {
  if (pathCache.has(conn)) return pathCache.get(conn);
  const from = components.get(conn.from);
  const to = components.get(conn.to);
  const ports = automaticPorts.get(conn);
  const { fromSide, toSide } = connectionSides(conn);
  const baseStart = ports?.from || anchor(from, fromSide);
  const baseEnd = ports?.to || anchor(to, toSide);
  const { start, end } = alignFacingPorts(
    conn,
    from,
    to,
    baseStart,
    baseEnd,
    fromSide,
    toSide,
    ports,
  );
  const isAutomaticRoute = !conn.via && (conn.route || 'auto') === 'auto';
  let points = [start, ...routeVia(conn, from, to, start, end, fromSide, toSide), end];
  if (isAutomaticRoute && points.length > 2) {
    // Authored geometry is authoritative; only automatic routes get the
    // unnecessary-bend simplification pass.
    points = simplifyRoutePoints(points, {
      accept: (candidate) => (
        routeHonorsEndpointSides(candidate, fromSide, toSide)
        && routeClearsEndpointComponents(candidate, from, to)
        && routeClearsComponents(conn, candidate)
        && routeMeetsRhythmFloors(candidate)
        && !routeSelfIntersects(candidate)
      ),
    });
  }
  const routed = { d: roundedPath(points, 8), points };
  pathCache.set(conn, routed);
  return routed;
}

// ---- Alignment advisories (warning-level, never blocking) ---------------------
// Authored positions stay authoritative; these record actionable single-node,
// single-axis moves that put a bent automatic connection's endpoints on one
// shared row or column, where the router draws one straight segment.

// Any real centerline drift qualifies: a sub-4px facing-port miss still bends
// (the straight-line shortcut cannot honor endpoint sides across a non-axis
// line), so the advisory floor is rounding noise, not "reads as straight".
const ALIGNMENT_MOVE_EPSILON = 1;

function alignmentFacingSides(from, to, axis) {
  if (axis === 'column') {
    return from.y <= to.y
      ? { fromSide: 'bottom', toSide: 'top' }
      : { fromSide: 'top', toSide: 'bottom' };
  }
  return from.x <= to.x
    ? { fromSide: 'right', toSide: 'left' }
    : { fromSide: 'left', toSide: 'right' };
}

function alignmentMoveIsClear(mover, pos) {
  const moved = { ...mover, x: pos[0], y: pos[1] };
  if (moved.x < 0 || moved.y < 0
    || moved.x + moved.width > viewBox[0]
    || moved.y + moved.height > viewBox[1]) return false;
  for (const component of components.values()) {
    if (component === mover) continue;
    if (rectsOverlap(moved, component, 8)) return false;
  }
  for (const boundary of boundaries) {
    if (asArray(boundary.wraps).includes(mover.id)) {
      if (moved.x < boundary.x || moved.y < boundary.y
        || moved.x + moved.width > boundary.x + boundary.width
        || moved.y + moved.height > boundary.y + boundary.height) return false;
    } else if (rectsOverlap(moved, boundary, 0)) {
      return false;
    }
  }
  return true;
}

// A spread pair can still straighten: when the two nodes' anchor axes
// coincide, the spread slots are co-ordered on both sides, so every edge of
// the pair becomes one parallel straight line. Require both spread groups to
// contain only edges between these two nodes, otherwise the move disturbs
// relationships to other nodes.
function spreadPairAxis(conn, from, to, connections) {
  const { fromSide, toSide } = connectionSides(conn);
  const verticalPair = (fromSide === 'bottom' && toSide === 'top')
    || (fromSide === 'top' && toSide === 'bottom');
  const horizontalPair = (fromSide === 'right' && toSide === 'left')
    || (fromSide === 'left' && toSide === 'right');
  if (!verticalPair && !horizontalPair) return null;
  const isPairEdge = (other) => (
    (other.from === from.id && other.to === to.id)
    || (other.from === to.id && other.to === from.id)
  );
  const isEligible = (other) => !other.via && (!other.route || other.route === 'auto');
  const groupIsPairOnly = (nodeId, side) => connections.every((other) => {
    if (!isEligible(other)) return true;
    const sides = connectionSides(other);
    const touches = (other.from === nodeId && sides.fromSide === side)
      || (other.to === nodeId && sides.toSide === side);
    return !touches || isPairEdge(other);
  });
  if (!groupIsPairOnly(from.id, fromSide) || !groupIsPairOnly(to.id, toSide)) return null;
  return { axis: verticalPair ? 'column' : 'row', fromSide, toSide };
}

function alignmentBendAdvisories() {
  const connections = asArray(arch.connections);
  const advisories = [];
  if (!connections.length) return advisories;
  const connectionCounts = new Map();
  for (const conn of connections) {
    for (const id of [conn.from, conn.to]) {
      connectionCounts.set(id, (connectionCounts.get(id) || 0) + 1);
    }
  }
  const emittedSpreadPairs = new Set();
  for (const [index, conn] of connections.entries()) {
    if (conn.via || (conn.route && conn.route !== 'auto')) continue;
    const from = components.get(conn.from);
    const to = components.get(conn.to);
    if (!from || !to) continue;
    const bends = Math.max(0, pathFor(conn).points.length - 2);
    if (bends < 1) continue;
    let spreadPair = null;
    if (automaticPorts.get(conn)) {
      spreadPair = spreadPairAxis(conn, from, to, connections);
      if (!spreadPair) continue;
      const pairKey = [from.id, to.id].sort().join('\u0000') + spreadPair.axis;
      if (emittedSpreadPairs.has(pairKey)) continue;
      emittedSpreadPairs.add(pairKey);
    }
    // Prefer moving the endpoint with fewer relationships, then the fixed
    // candidate order, so the suggestion is deterministic. A spread pair may
    // only move along the axis its sides face.
    const rawMoves = [
      { mover: to, axis: 'column', delta: from.cx - to.cx, pos: [from.cx - to.width / 2, to.y] },
      { mover: to, axis: 'row', delta: from.cy - to.cy, pos: [to.x, from.cy - to.height / 2] },
      { mover: from, axis: 'column', delta: to.cx - from.cx, pos: [to.cx - from.width / 2, from.y] },
      { mover: from, axis: 'row', delta: to.cy - from.cy, pos: [from.x, to.cy - from.height / 2] },
    ].filter((candidate) => !spreadPair || candidate.axis === spreadPair.axis);
    const move = rawMoves
      .map((candidate, order) => ({
        ...candidate,
        order,
        moverCount: connectionCounts.get(candidate.mover.id) || 1,
      }))
      .filter((candidate) => Math.abs(candidate.delta) >= ALIGNMENT_MOVE_EPSILON)
      .sort((left, right) => left.moverCount - right.moverCount || left.order - right.order)
      .find((candidate) => alignmentMoveIsClear(candidate.mover, candidate.pos));
    if (!move) continue;
    const other = move.mover === to ? from : to;
    const facing = alignmentFacingSides(from, to, move.axis);
    const currentFromSide = chosenSide(conn.fromSide, defaultFromSide(from, to));
    const currentToSide = chosenSide(conn.toSide, defaultToSide(from, to));
    const authoredSides = (
      (conn.fromSide && conn.fromSide !== 'auto')
      || (conn.toSide && conn.toSide !== 'auto')
    );
    const sidesMatch = currentFromSide === facing.fromSide && currentToSide === facing.toSide;
    const relativeWord = move.axis === 'column'
      ? (move.mover.y <= other.y ? 'directly above' : 'directly below')
      : (move.mover.x <= other.x ? 'directly left of' : 'directly right of');
    const suggestedPos = [Math.round(move.pos[0]), Math.round(move.pos[1])];
    // Inferred sides follow the aligned geometry automatically; authored
    // sides that point across the shared axis must be updated with the move.
    // A spread pair's slots co-order onto the shared axis, straightening every
    // edge between the two nodes at once.
    const sidesClause = authoredSides && !sidesMatch
      ? ` and set fromSide/toSide to "${facing.fromSide}"/"${facing.toSide}"`
      : '';
    const pairClause = spreadPair
      ? ` so both spread edges between "${from.id}" and "${to.id}" run as parallel straight segments`
      : '';
    const centerlineClause = move.axis === 'row'
      ? `, aligning both centerlines on y=${Math.round(other.cy)}`
      : `, aligning both centerlines on x=${Math.round(other.cx)}`;
    const relationId = conn.id ? ` id "${conn.id}"` : '';
    const message = `[layout/alignable-bend] architecture connections[${index}]${relationId} "${conn.from}" -> "${conn.to}" has ${bends} removable bend${bends === 1 ? '' : 's'} — move "${move.mover.id}" pos to [${suggestedPos[0]}, ${suggestedPos[1]}] ${relativeWord} "${other.id}"${sidesClause}${centerlineClause}${pairClause}, then re-validate.`;
    advisories.push({
      code: 'layout/alignable-bend',
      severity: 'warning',
      message,
      subject: {
        diagramType: 'architecture',
        collection: 'connections',
        index,
        from: conn.from,
        to: conn.to,
        ...(conn.id ? { id: conn.id } : {}),
      },
      evidence: {
        currentBends: bends,
        axis: move.axis,
        deltaPx: Math.round(Math.abs(move.delta)),
        suggestedPos,
        fromSide: currentFromSide,
        toSide: currentToSide,
        suggestedFromSide: facing.fromSide,
        suggestedToSide: facing.toSide,
        ...(spreadPair ? { spreadPair: true } : {}),
      },
      supportedFixes: [
        `move "${move.mover.id}" pos to [${suggestedPos[0]}, ${suggestedPos[1]}]${sidesClause} so connections[${index}] renders as one straight segment`,
      ],
    });
  }
  return advisories;
}

// Canvas-underfill advisories: every viewBox check is a floor (content must
// fit), so an authored canvas much larger than its drawn content passed
// silently — a top band of 276px on a 620px canvas read as 45% dead space in
// every export. Mirror the floors with a ceiling: measure the union of
// everything drawn inside the SVG (components, boundary frames incl. title
// rails, connection routes and label boxes) and warn when one side wastes a
// large band or the content covers an undersized share of the canvas. The
// suggested fix mirrors autoViewBoxFor: translate all authored coordinates by
// one uniform offset (rigid, so every pairwise geometry and rhythm floor is
// preserved) and shrink meta.viewBox to the auto-fit formula.
const CANVAS_WASTE_ABSOLUTE_PX = 80;
const CANVAS_WASTE_FRACTION = 0.25;
const CANVAS_TARGET_ORIGIN_PX = 20;
// The auto canvas legitimately spends layout.margin (40px) plus the legend
// band (~28px) below the content, so a compact horizontal strip can sit near
// 69% measured against the raw canvas — 0.7 flagged exactly such a tight,
// healthy layout right after its coordinates were shifted into place.
const CANVAS_UTILIZATION_FLOOR = 0.6;
// Keep the suggestion schema-legal (architecture.schema.json viewBox minimums).
const CANVAS_MIN_VIEWBOX_WIDTH = 320;
const CANVAS_MIN_VIEWBOX_HEIGHT = 240;

function canvasContentBounds() {
  const rects = [];
  for (const component of components.values()) {
    rects.push({ x: component.x, y: component.y, width: component.width, height: component.height });
  }
  for (const boundary of boundaries) {
    rects.push({ x: boundary.x, y: boundary.y, width: boundary.width, height: boundary.height });
    if (boundary.title && Number.isFinite(boundary.title.x) && Number.isFinite(boundary.title.y)) {
      rects.push({
        x: boundary.title.x,
        y: boundary.title.y,
        width: boundary.title.width,
        height: boundary.title.height,
      });
    }
  }
  for (const conn of asArray(arch.connections)) {
    if (!components.has(conn.from) || !components.has(conn.to)) continue;
    const routed = pathFor(conn);
    for (const [px, py] of routed.points) {
      rects.push({ x: px, y: py, width: 0, height: 0 });
    }
    if (conn.label) {
      const [lx, ly] = labelPoint(conn, routed.points);
      const width = Math.max(30, textUnits(conn.label) * 4.8 + 10);
      rects.push({ x: lx - width / 2, y: ly - 10, width, height: 14 });
    }
  }
  if (!rects.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rect of rects) {
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return null;
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function canvasUnderfillAdvisories() {
  const advisories = [];
  // The auto canvas hugs content by construction, so only an authored
  // meta.viewBox can underfill.
  if (!Array.isArray(arch.meta?.viewBox)) return advisories;
  const [viewW, viewH] = viewBox;
  if (!Number.isFinite(viewW) || !Number.isFinite(viewH) || viewW <= 0 || viewH <= 0) return advisories;
  const bounds = canvasContentBounds();
  if (!bounds) return advisories;
  const waste = {
    top: bounds.minY,
    right: viewW - bounds.maxX,
    bottom: viewH - bounds.maxY,
    left: bounds.minX,
  };
  const topThreshold = Math.max(CANVAS_WASTE_ABSOLUTE_PX, viewH * CANVAS_WASTE_FRACTION);
  const sideThreshold = Math.max(CANVAS_WASTE_ABSOLUTE_PX, viewW * CANVAS_WASTE_FRACTION);
  const utilization = (bounds.width * bounds.height) / (viewW * viewH);

  // Recommended fix: one rigid translation (dx, dy) that brings the content
  // origin to a symmetric small margin — pairwise geometry and every rhythm
  // floor survive a translation — then the auto-viewBox hug on the shifted
  // bounds. Authored pos / labelAt / via coordinates all move by (dx, dy).
  const dx = Math.round(CANVAS_TARGET_ORIGIN_PX - bounds.minX);
  const dy = Math.round(CANVAS_TARGET_ORIGIN_PX - bounds.minY);
  let width = Math.ceil(bounds.maxX + dx + layout.margin);
  let footprint = legendFootprint(architectureLegendEntries, {
    width: Math.max(1, width - layout.margin * 2),
  });
  if (footprint.minWidth > width - layout.margin * 2) {
    width = Math.ceil(footprint.minWidth + layout.margin * 2);
    footprint = legendFootprint(architectureLegendEntries, {
      width: width - layout.margin * 2,
    });
  }
  const suggested = [
    Math.max(CANVAS_MIN_VIEWBOX_WIDTH, width),
    Math.max(CANVAS_MIN_VIEWBOX_HEIGHT,
      Math.ceil(bounds.maxY + dy + layout.margin + layout.legendH + footprint.extraHeight)),
  ];
  // When the schema-minimum canvas is already as small as the hug formula
  // wants, no shrink is possible: leftover bands come from the canvas floor
  // itself, and warning about them would never clear.
  const canShrinkWidth = suggested[0] < viewW;
  const canShrinkHeight = suggested[1] < viewH;
  if (!canShrinkWidth && !canShrinkHeight) return advisories;
  const firedSides = Object.entries(waste)
    .filter(([side, value]) => {
      const shiftable = side === 'top' || side === 'bottom' ? canShrinkHeight : canShrinkWidth;
      const threshold = side === 'top' || side === 'bottom' ? topThreshold : sideThreshold;
      return shiftable && value >= threshold;
    })
    .map(([side, value]) => ({ side, value: Math.round(value) }));
  const utilizationAlone = !firedSides.length
    && (canShrinkWidth || canShrinkHeight)
    && utilization < CANVAS_UTILIZATION_FLOOR;
  if (!firedSides.length && !utilizationAlone) return advisories;

  const bandText = firedSides
    .map(({ side, value }) => `${side} band ${value}px`)
    .join(', ');
  const utilizationClause = firedSides.length
    ? ''
    : `; spreading the same content over this canvas wastes more than ${100 - Math.round(CANVAS_UTILIZATION_FLOOR * 100)}% of the drawing area`;
  const authoredShiftClause = dx || dy
    ? `shift every authored coordinate (components pos, connections labelAt/via) by [${dx}, ${dy}] and `
    : '';
  const message = `[layout/canvas-underfilled] architecture canvas ${viewW}x${viewH} holds drawn content bounds [${Math.round(bounds.minX)}, ${Math.round(bounds.minY)} -> ${Math.round(bounds.maxX)}, ${Math.round(bounds.maxY)}] at ${Math.round(utilization * 100)}% utilization${bandText ? ` (${bandText} empty)` : ''}${utilizationClause} — ${authoredShiftClause}set meta.viewBox to [${suggested[0]}, ${suggested[1]}], then re-validate.`;
  advisories.push({
    code: 'layout/canvas-underfilled',
    severity: 'warning',
    message,
    subject: {
      diagramType: 'architecture',
      collection: 'meta',
      field: 'viewBox',
    },
    evidence: {
      viewBox: [viewW, viewH],
      contentBounds: {
        x: Math.round(bounds.minX),
        y: Math.round(bounds.minY),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      },
      utilizationPct: Math.round(utilization * 100),
      wastePx: Object.fromEntries(Object.entries(waste).map(([side, value]) => [side, Math.round(value)])),
      suggestedViewBox: suggested,
      ...(dx || dy ? { suggestedShift: [dx, dy] } : {}),
    },
    supportedFixes: [
      `${authoredShiftClause}set meta.viewBox to [${suggested[0]}, ${suggested[1]}] so content fills the canvas`,
    ],
  });
  return advisories;
}

// ---- Rendering ---------------------------------------------------------------
function renderBoundaryFrame(b, index) {
  const cls = b.kind === 'security-group' ? 'c-security-group' : 'c-region';
  const rx = b.kind === 'security-group' ? 8 : 12;
  return `        <rect data-graph-role="structural-frame" data-composition-frame-kind="${esc(b.kind || 'boundary')}" data-composition-frame-id="${index}" data-composition-frame-label="${esc(b.label)}" x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="${rx}" class="${cls}" stroke-width="1"/>`;
}

function renderBoundaryLabel(b, index) {
  const labelCls = b.kind === 'security-group' ? 't-security' : 't-cloud';
  return `        <g data-graph-role="structural-frame-label" data-composition-frame-id="${index}" data-composition-frame-kind="${esc(b.kind || 'boundary')}" data-composition-frame-label="${esc(b.label)}">
          <rect data-graph-role="structural-frame-label-mask" x="${b.title.x}" y="${b.title.y}" width="${b.title.width}" height="${b.title.height}" rx="3" class="c-mask"/>
          <text data-boundary-label="" x="${b.title.x + 4}" y="${b.title.y + b.title.baselineOffset}" class="${labelCls}" font-size="${b.title.fontSize}" font-weight="600">${esc(b.label)}</text>
        </g>`;
}

function renderConnectionPath(conn, index) {
  const [cls, marker] = arrowClassMap[conn.variant || 'default'] || arrowClassMap.default;
  const routed = pathFor(conn);
  const strokeWidth = conn.width || (conn.variant === 'emphasis' ? 1.8 : 1.5);
  return `        <path ${focusEdgeAttrs(conn.from, conn.to, conn.label, index, conn.id)} data-composition-points="${routePointsValue(routed.points)}" d="${routed.d}" class="${cls}"${animateAttr(arch.meta, 'edge', index)} stroke-width="${strokeWidth}" marker-end="url(#${marker})"/>`;
}

function renderConnectionLabel(conn, index) {
  if (!conn.label) return '';
  const [lx, ly] = labelPoint(conn, pathFor(conn).points);
  const w = Math.max(30, textUnits(conn.label) * 4.8 + 10);
  return `        <g data-detail="context" ${focusEdgeAttrs(conn.from, conn.to, conn.label, index, conn.id)}>
          <rect x="${lx - w / 2}" y="${ly - 10}" width="${w}" height="14" rx="3" class="c-mask"/>
          <text x="${lx}" y="${ly}" class="${variantAccent(conn.variant)}" font-size="8" text-anchor="middle">${esc(conn.label)}</text>
        </g>`;
}

function renderComponent(c) {
  const fill = componentFill[c.type] || 'c-external';
  const accent = componentText[c.type] || 't-muted';
  const cx = c.cx;
  const hasSub = c.sublabel != null && c.sublabel !== '';
  const labelY = hasSub ? c.y + c.height / 2 - 2 : c.y + c.height / 2 + 4;
  const sub = hasSub
    ? `\n        <text data-detail="context" x="${cx}" y="${c.y + c.height / 2 + 14}" class="t-muted" font-size="${fittedNodeFontSize(c.sublabel, c.width, componentTextFit.sublabelPreferred, componentTextFit.sublabelMinimum)}" text-anchor="middle">${esc(c.sublabel)}</text>`
    : '';
  const tag = c.tag
    ? `\n        <text data-detail="fine" x="${cx}" y="${c.y + c.height - 8}" class="${accent}" font-size="${fittedNodeFontSize(c.tag, c.width, componentTextFit.tagPreferred, componentTextFit.tagMinimum)}" text-anchor="middle">${esc(c.tag)}</text>`
    : '';
  const brand = renderBrandMark(c, { x: c.x + c.width - 22, y: c.y + 6 });
  const labelFontSize = fittedNodeFontSize(c.label, brandLabelFitWidth(c, c.width), 11, 8);
  const passport = { kind: c.type, sublabel: c.sublabel, tag: c.tag, context: componentContext(c), ...brandMetadataFor(c) };
  return `        <g ${focusNodeAttrs(c.id, c.label, passport, arch.meta.locale)}>
          ${focusNodeTitle(c.label, passport)}
          <rect x="${c.x}" y="${c.y}" width="${c.width}" height="${c.height}" rx="6" class="c-mask"/>
          <rect x="${c.x}" y="${c.y}" width="${c.width}" height="${c.height}" rx="6" class="${fill}"${animateAttr(arch.meta, 'node', componentSteps.get(c.id))} stroke-width="1.5"/>
          ${renderSemanticSigil(c.type, { x: c.x + 6, y: c.y + 6 })}${brand ? `\n          ${brand}` : ''}
          <text data-node-label=""${hasSub ? ' data-detail-anchor=""' : ''} x="${cx}" y="${labelY}" class="t-primary" font-size="${labelFontSize}" font-weight="600" text-anchor="middle">${esc(c.label)}</text>${sub}${tag}
        </g>`;
}

function renderLegend() {
  const entries = architectureLegendEntries;
  const relationshipObstacles = relationshipLegendObstacles(arch.connections, {
    pointsFor: (connection) => pathFor(connection).points,
    labelRectFor: (connection) => {
      if (!connection.label) return null;
      const [x, y] = labelPoint(connection, pathFor(connection).points);
      const width = Math.max(30, textUnits(connection.label) * 4.8 + 10);
      return { x: x - width / 2, y: y - 10, width, height: 14 };
    },
  });
  const contentBottom = Math.max(
    0,
    ...[...components.values()].map((component) => component.y + component.height),
    ...boundaries.map((boundary) => boundary.y + boundary.height),
  );
  return renderResolvedLegend({
    entries,
    locale: arch.meta.locale,
    layout: {
      x: layout.margin,
      baselineY: legendY(),
      width: viewBox[0] - layout.margin * 2,
      minTitleY: contentBottom + 8,
      obstacles: relationshipObstacles,
      unfit: arch.meta?.legend === undefined ? 'hide' : 'error',
      diagramType: 'architecture',
    },
    renderSwatch: (entry) => `<rect x="${entry.x}" y="${entry.baseline - 9}" width="16" height="10" rx="2.5" class="${componentFill[entry.kind] || 'c-external'}" stroke-width="1"/>`,
  });
}

function renderSvg() {
  return `      <svg viewBox="0 0 ${viewBox[0]} ${viewBox[1]}" ${svgRootAttrs(arch.meta)}>
${svgAccessibleText(arch.meta, 'architecture')}
${renderDefinitions()}

        <!-- Background Grid -->
        <rect width="100%" height="100%" fill="url(#grid)" />

        <!-- Boundaries (behind everything) -->
${boundaries.map(renderBoundaryFrame).join('\n\n')}

        <!-- Connection paths (before components for correct z-order) -->
${asArray(arch.connections).map(renderConnectionPath).join('\n')}

        <!-- Components -->
${[...components.values()].map(renderComponent).join('\n\n')}

        <!-- Connection labels -->
${asArray(arch.connections).map(renderConnectionLabel).join('\n')}

        <!-- Boundary labels (foreground masks keep routes out of titles) -->
${boundaries.map(renderBoundaryLabel).join('\n\n')}

        <!-- Legend -->
${renderLegend()}
      </svg>`;
}

validateArchitecture();
if (layoutJsonMode) {
  console.log(JSON.stringify(buildLayoutReport(), null, 2));
  process.exit(0);
}
writeDiagram({
  outPath,
  template,
  diagramType: 'architecture',
  meta: arch.meta,
  svg: renderSvg(),
  cards: arch.cards,
  sourceEvidence,
});
