import { serializeNode, toSerializable } from "./serialize";
import { PluginApiDispatcher } from "./api-dispatch";

declare const __GATEWAY_SECRET__: string;
declare const __GATEWAY_INSTANCE__: string;

type IncomingRequest = {
  type: "request";
  id: string;
  operation: "get_node" | "export" | "execute" | "api";
  payload: Record<string, unknown>;
};

const sessionKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const pluginApi = new PluginApiDispatcher(figma);

figma.showUI(__html__, { width: 320, height: 120 });

function fileDescription() {
  return {
    instance: __GATEWAY_INSTANCE__,
    fileKey: sessionKey,
    actualFileKey: figma.fileKey || undefined,
    fileName: figma.root.name,
    editorType: figma.editorType,
    editorMode: figma.mode,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
  };
}

figma.ui.postMessage({ type: "initialize", secret: __GATEWAY_SECRET__, file: fileDescription() });

async function getNode(payload: Record<string, unknown>) {
  const nodeId = String(payload.nodeId || "");
  if (!nodeId) throw new Error("nodeId is required");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  const requestedDepth = payload.depth === undefined ? Number.POSITIVE_INFINITY : Number(payload.depth);
  return serializeNode(node, Number.isFinite(requestedDepth) ? Math.max(0, requestedDepth) : Number.POSITIVE_INFINITY);
}

type VideoExportSettings = ExportSettingsMP4 | ExportSettingsGIF | ExportSettingsWEBM;

function videoScale(payload: Record<string, unknown>): VideoExportScale {
  const scale = Number(payload.scale || 1);
  const allowed: VideoExportScale[] = [0.5, 0.75, 1, 1.5, 2, 3, 4];
  if (!allowed.includes(scale as VideoExportScale)) {
    throw new Error(`Video export scale must be one of: ${allowed.join(", ")}`);
  }
  return scale as VideoExportScale;
}

function exportSettings(payload: Record<string, unknown>): ExportSettings | VideoExportSettings {
  const format = String(payload.format || "PNG").toUpperCase();
  if (format === "MP4" || format === "WEBM") {
    const fps = Number(payload.fps || 30);
    if (![12, 24, 30, 60].includes(fps)) throw new Error(`${format} fps must be 12, 24, 30, or 60`);
    const quality = String(payload.quality || "HIGH").toUpperCase();
    if (!["LOW", "MEDIUM", "HIGH"].includes(quality)) {
      throw new Error(`${format} quality must be LOW, MEDIUM, or HIGH`);
    }
    return {
      format,
      fps: fps as 12 | 24 | 30 | 60,
      quality: quality as "LOW" | "MEDIUM" | "HIGH",
      constraint: { type: "SCALE", value: videoScale(payload) },
    };
  }
  if (format === "GIF") {
    const fps = Number(payload.fps || 15);
    if (![8, 12, 15, 24, 30].includes(fps)) throw new Error("GIF fps must be 8, 12, 15, 24, or 30");
    const loopCount = Number(payload.loopCount ?? 0);
    if (!Number.isInteger(loopCount) || loopCount < 0 || loopCount > 1000) {
      throw new Error("GIF loopCount must be an integer from 0 to 1000");
    }
    return {
      format: "GIF",
      fps: fps as 8 | 12 | 15 | 24 | 30,
      loopCount,
      constraint: { type: "SCALE", value: videoScale(payload) },
    };
  }
  if (format === "SVG") return { format: "SVG" };
  if (format === "PDF") return { format: "PDF" };
  if (format === "JPG") {
    return { format: "JPG", constraint: { type: "SCALE", value: Number(payload.scale || 1) } };
  }
  return { format: "PNG", constraint: { type: "SCALE", value: Number(payload.scale || 1) } };
}

async function exportNode(payload: Record<string, unknown>) {
  const nodeId = String(payload.nodeId || "");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || !("exportAsync" in node)) throw new Error(`Exportable node not found: ${nodeId}`);
  const settings = exportSettings(payload);
  const bytes = ["MP4", "GIF", "WEBM"].includes(settings.format)
    ? await (node as ExportMixin).exportAsync(settings as VideoExportSettings)
    : await (node as ExportMixin).exportAsync(settings as ExportSettings);
  return { base64: figma.base64Encode(bytes), byteLength: bytes.byteLength };
}

async function execute(payload: Record<string, unknown>) {
  const code = String(payload.code || "");
  if (!code.trim()) throw new Error("code is required");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
    new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
  const run = new AsyncFunction("figma", "args", "serialize", `"use strict";\n${code}`);
  const result = await run(figma, payload.args || {}, toSerializable);
  return toSerializable(result);
}

if (figma.editorType === "dev" && figma.mode === "codegen") {
  figma.codegen.on("generate", ({ node }) => [{
    title: "Figma Gateway",
    language: "JSON",
    code: JSON.stringify(serializeNode(node), null, 2),
  }]);
}

if (figma.mode === "textreview") {
  figma.on("textreview", () => []);
}

figma.ui.onmessage = async (message: IncomingRequest) => {
  if (!message || message.type !== "request") return;
  try {
    let result: unknown;
    if (message.operation === "get_node") result = await getNode(message.payload);
    else if (message.operation === "export") result = await exportNode(message.payload);
    else if (message.operation === "execute") result = await execute(message.payload);
    else if (message.operation === "api") {
      result = await pluginApi.dispatch(message.payload as {
        action: "get" | "call" | "set" | "callback";
        path?: string;
        args?: unknown[];
        value?: unknown;
        target?: unknown;
        code?: string;
      });
    }
    else throw new Error(`Unsupported operation: ${String(message.operation)}`);
    figma.ui.postMessage({ type: "response", id: message.id, ok: true, result });
  } catch (error) {
    figma.ui.postMessage({
      type: "response",
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

figma.on("currentpagechange", () => {
  figma.ui.postMessage({ type: "file-updated", file: fileDescription() });
});
