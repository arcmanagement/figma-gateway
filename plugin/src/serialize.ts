type PlainObject = Record<string, unknown>;

const NODE_PROPERTIES = [
  "id", "name", "type", "visible", "locked", "opacity", "blendMode", "isMask",
  "rotation", "x", "y", "width", "height", "absoluteBoundingBox", "absoluteRenderBounds",
  "clipsContent", "cornerRadius", "cornerSmoothing", "fills", "strokes", "strokeWeight",
  "strokeAlign", "strokeCap", "strokeJoin", "dashPattern", "effects", "constraints",
  "layoutMode", "layoutWrap", "primaryAxisAlignItems", "counterAxisAlignItems",
  "primaryAxisSizingMode", "counterAxisSizingMode", "paddingLeft", "paddingRight",
  "paddingTop", "paddingBottom", "itemSpacing", "counterAxisSpacing", "layoutAlign",
  "layoutGrow", "layoutPositioning", "minWidth", "maxWidth", "minHeight", "maxHeight",
  "characters", "fontName", "fontSize", "fontWeight", "textAlignHorizontal",
  "textAlignVertical", "textAutoResize", "textStyleId", "paragraphIndent", "paragraphSpacing",
  "lineHeight", "letterSpacing", "textCase", "textDecoration", "hyperlink", "reactions",
  "componentProperties", "variantProperties", "componentPropertyDefinitions", "mainComponent",
  "remote", "key", "description", "documentationLinks", "exportSettings", "annotations",
  "devStatus", "resolvedVariableModes", "explicitVariableModes", "boundVariables",
  "animationStyles", "animations", "manualKeyframeTracks", "timelines",
  "shapeType", "code", "codeLanguage", "isSkippedSlide",
  "connectorStart", "connectorEnd", "connectorStartStrokeCap", "connectorEndStrokeCap",
  "stuckNodes", "isAsset", "overlayPositionType", "overlayBackground", "overlayBackgroundInteraction",
] as const;

function read(value: unknown, key: string): unknown {
  try {
    return (value as PlainObject)[key];
  } catch {
    return undefined;
  }
}

export function toSerializable(value: unknown, seen = new Set<unknown>(), depth = 0): unknown {
  if (value === null || value === undefined || typeof value === "string" ||
      typeof value === "number" || typeof value === "boolean") return value ?? null;
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth > 40) return "[max-depth]";
  if (value instanceof Uint8Array) return { base64: figma.base64Encode(value), byteLength: value.byteLength };
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => toSerializable(item, seen, depth + 1));
    seen.delete(value);
    return result;
  }
  const result: PlainObject = {};
  for (const key of Object.keys(value as PlainObject)) {
    const item = toSerializable(read(value, key), seen, depth + 1);
    if (item !== undefined) result[key] = item;
  }
  seen.delete(value);
  return result;
}

function nodeBounds(node: SceneNode): PlainObject | null {
  const bounds = "absoluteBoundingBox" in node ? node.absoluteBoundingBox : null;
  if (!bounds) return null;
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

export function serializeNode(node: BaseNode, remainingDepth = Number.POSITIVE_INFINITY): PlainObject {
  const result: PlainObject = {};
  for (const key of NODE_PROPERTIES) {
    const item = toSerializable(read(node, key));
    if (item !== undefined && item !== null && item !== "[circular]") result[key] = item;
  }
  if (["STICKY", "SHAPE_WITH_TEXT", "CONNECTOR"].includes(node.type)) {
    const characters = toSerializable(read(read(node, "text"), "characters"));
    if (typeof characters === "string") result.characters = characters;
  }
  if (node.type === "TABLE") {
    const numRows = Number(read(node, "numRows"));
    const numColumns = Number(read(node, "numColumns"));
    const cellAt = read(node, "cellAt");
    if (Number.isInteger(numRows) && Number.isInteger(numColumns) && typeof cellAt === "function") {
      const cells: string[][] = [];
      for (let row = 0; row < numRows; row += 1) {
        const rowCells: string[] = [];
        for (let column = 0; column < numColumns; column += 1) {
          const cell = cellAt.call(node, row, column);
          rowCells.push(String(read(read(cell, "text"), "characters") || ""));
        }
        cells.push(rowCells);
      }
      result.table = { numRows, numColumns, cells };
    }
  }
  if ("absoluteBoundingBox" in node) result.bounds = nodeBounds(node as SceneNode);
  if ("connectorStart" in node || "connectorEnd" in node) {
    result.connector = {
      start: toSerializable(read(node, "connectorStart")),
      end: toSerializable(read(node, "connectorEnd")),
      startStrokeCap: toSerializable(read(node, "connectorStartStrokeCap")),
      endStrokeCap: toSerializable(read(node, "connectorEndStrokeCap")),
    };
  }
  if (remainingDepth > 0 && "children" in node) {
    result.children = (node as ChildrenMixin).children.map((child) =>
      serializeNode(child, remainingDepth - 1));
  }
  return result;
}
