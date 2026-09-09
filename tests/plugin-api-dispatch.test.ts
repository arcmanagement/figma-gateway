import assert from "node:assert/strict";
import test from "node:test";
import { PluginApiDispatcher } from "../plugin/src/api-dispatch.js";

function pluginApi() {
  const node = { id: "1:2", name: "Before", x: 10 };
  const variable = {
    id: "VariableID:1:2",
    name: "Spacing",
    valuesByMode: {} as Record<string, unknown>,
    setValueForMode(mode: string, value: unknown) { this.valuesByMode[mode] = value; },
  };
  return {
    editorType: "figma",
    currentPage: { selection: [node] },
    getNodeByIdAsync: async (id: string) => id === node.id ? node : null,
    base64Decode: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
    group: (nodes: unknown[], parent: unknown, index?: number) => ({ nodes, parent, index }),
    variables: { getVariableByIdAsync: async () => variable },
  } as unknown as PluginAPI;
}

test("Plugin API dispatcher reads properties and preserves method owners", async () => {
  const api = pluginApi();
  const dispatcher = new PluginApiDispatcher(api);
  assert.equal(await dispatcher.dispatch({
    action: "get",
    path: "figma.editorType",
  }), "figma");
  const result = await dispatcher.dispatch({
    action: "call",
    path: "group",
    args: [[{ $node: "1:2" }], { $figma: "currentPage" }, 0],
  }) as Record<string, unknown>;
  assert.equal(typeof result.$handle, "string");
  assert.equal((result.nodes as Array<Record<string, unknown>>)[0]?.name, "Before");
});

test("Plugin API dispatcher updates writable properties and blocks prototype paths", async () => {
  const api = pluginApi();
  const dispatcher = new PluginApiDispatcher(api);
  assert.equal(await dispatcher.dispatch({
    action: "set",
    path: "currentPage.selection.0.name",
    value: "After",
  }), "After");
  assert.equal((api.currentPage.selection[0] as SceneNode).name, "After");
  const targetResult = await dispatcher.dispatch({
    action: "call",
    target: { $node: "1:2" },
    path: "valueOf",
  }) as Record<string, unknown>;
  assert.equal(targetResult.name, "After");
  await assert.rejects(dispatcher.dispatch({
    action: "get",
    path: "__proto__.polluted",
  }), /forbidden segment/);
});

test("Plugin API dispatcher reuses live objects and callbacks through opaque handles", async () => {
  const api = pluginApi();
  let generate: ((event: { node: unknown }) => unknown) | undefined;
  (api as unknown as Record<string, unknown>).codegen = {
    on: (event: string, callback: (event: { node: unknown }) => unknown) => {
      assert.equal(event, "generate");
      generate = callback;
    },
  };
  const dispatcher = new PluginApiDispatcher(api);
  const variable = await dispatcher.dispatch({
    action: "call",
    path: "variables.getVariableByIdAsync",
    args: ["VariableID:1:2"],
  }) as Record<string, unknown>;
  assert.equal(typeof variable.$handle, "string");
  await dispatcher.dispatch({
    action: "call",
    target: { $handle: variable.$handle },
    path: "setValueForMode",
    args: ["mode-1", 8],
  });
  const values = await dispatcher.dispatch({
    action: "get",
    target: { $handle: variable.$handle },
    path: "valuesByMode",
  }) as Record<string, unknown>;
  assert.equal(values["mode-1"], 8);

  const callback = await dispatcher.dispatch({
    action: "callback",
    code: "return { name: event.name || event.node?.name, count: args.length };",
  }) as Record<string, unknown>;
  assert.equal(typeof callback.$handle, "string");
  const resolved = await dispatcher.dispatch({
    action: "call",
    target: { $handle: callback.$handle },
    path: "call",
    args: [null, { name: "selectionchange" }],
  }) as Record<string, unknown>;
  assert.equal(resolved.name, "selectionchange");
  assert.equal(resolved.count, 1);

  await dispatcher.dispatch({
    action: "call",
    path: "codegen.on",
    args: ["generate", { $handle: callback.$handle }],
  });
  assert.deepEqual(generate?.({ node: { name: "Button" } }), { name: "Button", count: 1 });
});

test("Plugin API handles stay valid for the lifetime of a large session result", async () => {
  const api = pluginApi();
  (api as unknown as Record<string, unknown>).many = Array.from(
    { length: 2050 },
    (_, id) => ({ id }),
  );
  const dispatcher = new PluginApiDispatcher(api);
  const many = await dispatcher.dispatch({ action: "get", path: "many" }) as Array<Record<string, unknown>>;
  assert.equal(many.length, 2050);
  assert.equal(await dispatcher.dispatch({
    action: "get",
    target: { $handle: many[0]?.$handle },
    path: "id",
  }), 0);
});
