export type PluginApiParameter = {
  name: string;
  type: string;
  optional: boolean;
  rest: boolean;
};

export type PluginApiSignature = {
  parameters: readonly PluginApiParameter[];
  returns: string;
};

export type PluginApiCatalogEntry = {
  id: string;
  interface: string;
  member: string;
  sourceKind: "method" | "property" | "index";
  kind: "method" | "property" | "index";
  readonly: boolean;
  optional: boolean;
  deprecated: boolean;
  documentation?: string;
  receiver?: string;
  targetRequired: boolean;
  path: string;
  signatures: readonly PluginApiSignature[];
  type?: string;
};
