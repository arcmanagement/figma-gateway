import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.cwd();
const typingsPackage = JSON.parse(readFileSync(path.join(root, "node_modules/@figma/plugin-typings/package.json"), "utf8"));
const typingsPath = path.join(root, "node_modules/@figma/plugin-typings/plugin-api.d.ts");
const indexPath = path.join(root, "node_modules/@figma/plugin-typings/index.d.ts");
const outputPath = path.join(root, "src/generated/plugin-api-catalog.ts");
const source = ts.createSourceFile(
  typingsPath,
  readFileSync(typingsPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const indexSource = ts.createSourceFile(
  indexPath,
  readFileSync(indexPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function kebab(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function memberName(member) {
  if (!member.name) return "$index";
  if (ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)) return member.name.text;
  return member.name.getText(source);
}

function jsDoc(member) {
  const tags = ts.getJSDocTags(member);
  const deprecated = tags.some((tag) => tag.tagName.text === "deprecated");
  const see = tags.find((tag) => tag.tagName.text === "see");
  const comment = see?.comment;
  const text = typeof comment === "string"
    ? comment
    : Array.isArray(comment) ? comment.map((part) => part.text).join("") : undefined;
  const match = text?.match(/https:\/\/[^\s)]+/);
  return { deprecated, documentation: match?.[0] };
}

function parameter(value) {
  return {
    name: value.name.getText(source),
    type: value.type?.getText(source) || "unknown",
    optional: Boolean(value.questionToken || value.initializer),
    rest: Boolean(value.dotDotDotToken),
  };
}

function signature(parameters, returns) {
  return {
    parameters: parameters.map(parameter),
    returns: returns?.getText(source) || "void",
  };
}

const directReceivers = new Map([["PluginAPI", ""]]);
const pluginApi = source.statements.find(
  (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === "PluginAPI",
);
for (const member of pluginApi.members) {
  if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeReferenceNode(member.type)) continue;
  const typeName = member.type.typeName.getText(source);
  if (typeName.endsWith("API")) directReceivers.set(typeName, memberName(member));
}

const grouped = new Map();
let declarationCount = 0;
for (const statement of source.statements) {
  if (!ts.isInterfaceDeclaration(statement)) continue;
  const interfaceName = statement.name.text;
  const receiver = directReceivers.get(interfaceName);
  for (const member of statement.members) {
    if (!ts.isMethodSignature(member) && !ts.isPropertySignature(member) && !ts.isIndexSignatureDeclaration(member)) continue;
    declarationCount += 1;
    const name = memberName(member);
    const sourceKind = ts.isMethodSignature(member) ? "method" : ts.isPropertySignature(member) ? "property" : "index";
    const callableProperty = ts.isPropertySignature(member) && member.type && ts.isFunctionTypeNode(member.type);
    const kind = sourceKind === "method" || callableProperty ? "method" : sourceKind;
    const memberId = name === "$index" ? "$index" : kebab(name);
    const prefix = receiver === undefined
      ? kebab(interfaceName)
      : receiver ? `figma.${receiver.split(".").map(kebab).join(".")}` : "figma";
    const id = `${prefix}.${memberId}`;
    const key = `${interfaceName}\u0000${name}\u0000${kind}`;
    let entry = grouped.get(key);
    if (!entry) {
      const docs = jsDoc(member);
      entry = {
        id,
        interface: interfaceName,
        member: name,
        sourceKind,
        kind,
        readonly: Boolean(member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)),
        optional: Boolean(member.questionToken),
        deprecated: docs.deprecated,
        ...(docs.documentation ? { documentation: docs.documentation } : {}),
        ...(receiver === undefined ? {} : { receiver }),
        targetRequired: receiver === undefined,
        path: receiver ? `${receiver}.${name}` : name,
        signatures: [],
        ...(ts.isPropertySignature(member) && !callableProperty ? { type: member.type?.getText(source) || "unknown" } : {}),
      };
      grouped.set(key, entry);
    }
    if (ts.isMethodSignature(member)) {
      entry.signatures.push(signature(member.parameters, member.type));
    } else if (callableProperty) {
      entry.signatures.push(signature(member.type.parameters, member.type.type));
    } else if (ts.isIndexSignatureDeclaration(member)) {
      entry.signatures.push(signature(member.parameters, member.type));
      entry.type = member.type.getText(source);
    }
  }
}

const catalog = [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id));
const documentedGlobalNames = new Set(["__html__", "__uiFiles__"]);
function collectDocumentedGlobals(node) {
  const result = [];
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && documentedGlobalNames.has(node.name.text)) {
    result.push({
      id: `global.${kebab(node.name.text)}`,
      interface: "GlobalObjects",
      member: node.name.text,
      sourceKind: "property",
      kind: "property",
      readonly: true,
      optional: false,
      deprecated: false,
      receiver: "$global",
      targetRequired: false,
      path: node.name.text,
      signatures: [],
      type: node.type?.getText(indexSource) || "unknown",
    });
  }
  node.forEachChild((child) => {
    result.push(...collectDocumentedGlobals(child));
  });
  return result;
}
const globalEntries = collectDocumentedGlobals(indexSource);
if (globalEntries.length !== documentedGlobalNames.size) {
  throw new Error(`Expected ${documentedGlobalNames.size} documented Figma globals, found ${globalEntries.length}`);
}
catalog.push(...globalEntries);
catalog.sort((a, b) => a.id.localeCompare(b.id));
const duplicateIds = catalog
  .map((entry) => entry.id)
  .filter((id, index, values) => values.indexOf(id) !== index);
if (duplicateIds.length) throw new Error(`Duplicate Plugin API command IDs: ${[...new Set(duplicateIds)].join(", ")}`);

const interfaceCount = source.statements.filter(ts.isInterfaceDeclaration).length;
const rendered = `// Generated by scripts/generate-plugin-api-catalog.mjs. Do not edit.\n` +
  `import type { PluginApiCatalogEntry } from "../shared/plugin-api-catalog-types.js";\n\n` +
  `export const PLUGIN_API_TYPINGS_VERSION = ${JSON.stringify(typingsPackage.version)};\n` +
  `export const PLUGIN_API_INTERFACE_COUNT = ${interfaceCount};\n` +
  `export const PLUGIN_API_GLOBAL_COUNT = ${globalEntries.length};\n` +
  `export const PLUGIN_API_INTERFACE_DECLARATION_COUNT = ${declarationCount};\n` +
  `export const PLUGIN_API_DECLARATION_COUNT = ${declarationCount + globalEntries.length};\n` +
  `export const PLUGIN_API_COMMAND_COUNT = ${catalog.length};\n` +
  `export const PLUGIN_API_CATALOG: readonly PluginApiCatalogEntry[] = ${JSON.stringify(catalog, null, 2)};\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(outputPath, "utf8"); } catch {}
  if (current !== rendered) {
    console.error("Plugin API catalog is stale. Run npm run generate:plugin-api.");
    process.exit(1);
  }
  console.log(`Plugin API catalog is current: ${catalog.length} commands cover ${declarationCount + globalEntries.length} declarations.`);
} else {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered);
  console.log(`Generated ${catalog.length} Plugin API commands from ${declarationCount + globalEntries.length} declarations.`);
}
