import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  PLUGIN_API_CATALOG,
  PLUGIN_API_COMMAND_COUNT,
  PLUGIN_API_DECLARATION_COUNT,
  PLUGIN_API_INTERFACE_COUNT,
  PLUGIN_API_GLOBAL_COUNT,
  PLUGIN_API_INTERFACE_DECLARATION_COUNT,
  PLUGIN_API_TYPINGS_VERSION,
  resolvePluginApiInvocation,
} from "../src/shared/plugin-api-catalog.js";

test("generated CLI catalog covers every official Plugin API interface member and overload", async () => {
  const path = "node_modules/@figma/plugin-typings/plugin-api.d.ts";
  const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
  const interfaces = source.statements.filter(ts.isInterfaceDeclaration);
  let declarations = 0;
  const expected = new Map<string, number>();
  for (const owner of interfaces) {
    for (const member of owner.members) {
      if (!ts.isMethodSignature(member) && !ts.isPropertySignature(member) && !ts.isIndexSignatureDeclaration(member)) continue;
      declarations += 1;
      const name = member.name?.getText(source) || "$index";
      const callable = ts.isMethodSignature(member) ||
        (ts.isPropertySignature(member) && member.type !== undefined && ts.isFunctionTypeNode(member.type));
      const key = `${owner.name.text}\u0000${name}\u0000${callable ? "method" : ts.isIndexSignatureDeclaration(member) ? "index" : "property"}`;
      expected.set(key, (expected.get(key) || 0) + (callable || ts.isIndexSignatureDeclaration(member) ? 1 : 0));
    }
  }
  const actual = new Map(PLUGIN_API_CATALOG.map((entry) => [
    `${entry.interface}\u0000${entry.member}\u0000${entry.kind}`,
    entry.signatures.length,
  ]));
  assert.equal(interfaces.length, PLUGIN_API_INTERFACE_COUNT);
  assert.equal(declarations, PLUGIN_API_INTERFACE_DECLARATION_COUNT);
  assert.equal(PLUGIN_API_DECLARATION_COUNT, declarations + PLUGIN_API_GLOBAL_COUNT);
  expected.set("GlobalObjects\u0000__html__\u0000property", 0);
  expected.set("GlobalObjects\u0000__uiFiles__\u0000property", 0);
  assert.equal(actual.size, PLUGIN_API_COMMAND_COUNT);
  assert.deepEqual(actual, expected);
  assert.equal(new Set(PLUGIN_API_CATALOG.map((entry) => entry.id)).size, PLUGIN_API_COMMAND_COUNT);
  assert.equal(PLUGIN_API_GLOBAL_COUNT, 2);

  const packageJson = JSON.parse(await readFile("node_modules/@figma/plugin-typings/package.json", "utf8"));
  assert.equal(packageJson.version, PLUGIN_API_TYPINGS_VERSION);
});

test("catalog exposes root, namespace, handle, writable, readonly, and overload commands", () => {
  const createRectangle = resolvePluginApiInvocation({
    apiId: "figma.create-rectangle",
    params: {},
    confirm: true,
  });
  assert.deepEqual({ operation: createRectangle.operation, path: createRectangle.path, args: createRectangle.args }, {
    operation: "call", path: "createRectangle", args: [],
  });

  const createVariable = resolvePluginApiInvocation({
    apiId: "figma.variables.create-variable",
    params: { name: "Spacing", collectionId: "VariableCollectionId:1:2", resolvedType: "FLOAT" },
    confirm: true,
  });
  assert.equal(createVariable.path, "variables.createVariable");
  assert.deepEqual(createVariable.args, ["Spacing", "VariableCollectionId:1:2", "FLOAT"]);

  const setMode = resolvePluginApiInvocation({
    apiId: "variable.set-value-for-mode",
    target: { $handle: "h1" },
    params: { modeId: "mode-1", newValue: 8 },
    confirm: true,
  });
  assert.equal(setMode.path, "setValueForMode");
  assert.deepEqual(setMode.args, ["mode-1", 8]);

  assert.throws(() => resolvePluginApiInvocation({
    apiId: "figma.editor-type",
    value: "figjam",
    hasValue: true,
    confirm: true,
  }), /readonly/);
  assert.throws(() => resolvePluginApiInvocation({
    apiId: "variable.set-value-for-mode",
    params: { modeId: "mode-1", newValue: 8 },
    confirm: true,
  }), /--target/);
  assert.throws(() => resolvePluginApiInvocation({
    apiId: "figma.create-rectangle",
    target: { $node: "1:2" },
    params: {},
    confirm: true,
  }), /fixed receiver/);
});
