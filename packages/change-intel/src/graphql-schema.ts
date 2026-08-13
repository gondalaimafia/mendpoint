import { createHash } from "node:crypto";
import {
  Kind,
  astFromValue,
  buildASTSchema,
  buildClientSchema,
  findBreakingChanges,
  findDangerousChanges,
  getLocation,
  isDirective,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isSpecifiedScalarType,
  isUnionType,
  lexicographicSortSchema,
  parse,
  parseType,
  print,
  printSchema,
  validateSchema,
  type ASTNode,
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLNamedType,
  type GraphQLSchema,
  type InputValueDefinitionNode,
  type TypeNode,
} from "graphql";

export type GraphQLSchemaSourceFormat = "sdl" | "introspection";
export type GraphQLDefinitionKind =
  | "object"
  | "interface"
  | "input"
  | "enum"
  | "union"
  | "scalar"
  | "directive";
export type GraphQLChangeClassification = "breaking" | "dangerous" | "additive" | "non_breaking";

export interface GraphQLSourceLocation {
  source: GraphQLSchemaSourceFormat;
  line?: number;
  column?: number;
  path?: string;
}

export interface CanonicalGraphQLArgument {
  name: string;
  type: string;
  defaultValue?: string;
  description?: string;
  deprecationReason?: string;
  location: GraphQLSourceLocation;
}

export interface CanonicalGraphQLField {
  name: string;
  type: string;
  arguments?: CanonicalGraphQLArgument[];
  defaultValue?: string;
  description?: string;
  deprecationReason?: string;
  location: GraphQLSourceLocation;
}

export interface CanonicalGraphQLDefinition {
  kind: GraphQLDefinitionKind;
  name: string;
  fields?: CanonicalGraphQLField[];
  enumValues?: string[];
  enumValueDeprecations?: Record<string, string>;
  unionMembers?: string[];
  memberLocations?: Record<string, GraphQLSourceLocation>;
  interfaces?: string[];
  directiveLocations?: string[];
  repeatable?: boolean;
  description?: string;
  location: GraphQLSourceLocation;
}

export interface CanonicalGraphQLSchema {
  sourceFormat: GraphQLSchemaSourceFormat;
  canonicalSdl: string;
  definitions: CanonicalGraphQLDefinition[];
  digest: string;
}

export interface GraphQLSchemaLimits {
  maxInputBytes?: number;
  maxDefinitions?: number;
  maxFieldsPerDefinition?: number;
  maxTypeDepth?: number;
}

export type GraphQLSchemaErrorCode =
  | "INPUT_TOO_LARGE"
  | "TYPE_TOO_DEEP"
  | "TOO_MANY_DEFINITIONS"
  | "TOO_MANY_FIELDS"
  | "DUPLICATE_DEFINITION"
  | "MALFORMED_SCHEMA";

export class GraphQLSchemaError extends Error {
  constructor(public readonly code: GraphQLSchemaErrorCode, message: string) {
    super(message);
    this.name = "GraphQLSchemaError";
  }
}

export interface GraphQLSchemaChange {
  kind: string;
  coordinate: string;
  classification: GraphQLChangeClassification;
  oldLocation?: GraphQLSourceLocation;
  newLocation?: GraphQLSourceLocation;
  migrationHint: string;
}

export interface GraphQLSchemaDiff {
  classification: GraphQLChangeClassification;
  changes: GraphQLSchemaChange[];
  oldSchema: CanonicalGraphQLSchema;
  newSchema: CanonicalGraphQLSchema;
  oracle: { breaking: string[]; dangerous: string[] };
}

const DEFAULT_LIMITS: Required<GraphQLSchemaLimits> = {
  maxInputBytes: 2_000_000,
  maxDefinitions: 5_000,
  maxFieldsPerDefinition: 20_000,
  maxTypeDepth: 32,
};

type IntrospectionEnvelope = { data?: { __schema?: unknown }; __schema?: unknown };

interface LocationIndex {
  definitions: Map<string, GraphQLSourceLocation>;
  fields: Map<string, GraphQLSourceLocation>;
  arguments: Map<string, GraphQLSourceLocation>;
  members: Map<string, GraphQLSourceLocation>;
}

function emptyLocationIndex(): LocationIndex {
  return { definitions: new Map(), fields: new Map(), arguments: new Map(), members: new Map() };
}

function definitionKey(kind: GraphQLDefinitionKind, name: string): string {
  return kind === "directive" ? `directive:${name}` : `type:${name}`;
}

function introspectionLocationIndex(input: IntrospectionEnvelope): LocationIndex {
  const index = emptyLocationIndex();
  const wrapped = "data" in input;
  const payload = (wrapped ? input.data : input) as { __schema?: { types?: unknown[]; directives?: unknown[] } } | undefined;
  const root = wrapped ? "$.data.__schema" : "$.__schema";
  for (const [typeIndex, rawType] of (payload?.__schema?.types ?? []).entries()) {
    if (!rawType || typeof rawType !== "object") continue;
    const type = rawType as { name?: unknown; fields?: unknown[]; inputFields?: unknown[]; enumValues?: unknown[]; possibleTypes?: unknown[] };
    if (typeof type.name !== "string") continue;
    index.definitions.set(`type:${type.name}`, { source: "introspection", path: `${root}.types[${typeIndex}]` });
    for (const [fieldIndex, rawField] of (type.fields ?? []).entries()) {
      if (!rawField || typeof rawField !== "object") continue;
      const field = rawField as { name?: unknown; args?: unknown[] };
      if (typeof field.name !== "string") continue;
      const fieldKey = `${type.name}.${field.name}`;
      index.fields.set(fieldKey, { source: "introspection", path: `${root}.types[${typeIndex}].fields[${fieldIndex}]` });
      for (const [argumentIndex, rawArgument] of (field.args ?? []).entries()) {
        if (!rawArgument || typeof rawArgument !== "object") continue;
        const name = (rawArgument as { name?: unknown }).name;
        if (typeof name === "string") index.arguments.set(`${fieldKey}(${name})`, { source: "introspection", path: `${root}.types[${typeIndex}].fields[${fieldIndex}].args[${argumentIndex}]` });
      }
    }
    for (const [fieldIndex, rawField] of (type.inputFields ?? []).entries()) {
      if (!rawField || typeof rawField !== "object") continue;
      const name = (rawField as { name?: unknown }).name;
      if (typeof name === "string") index.fields.set(`${type.name}.${name}`, { source: "introspection", path: `${root}.types[${typeIndex}].inputFields[${fieldIndex}]` });
    }
    for (const [valueIndex, rawValue] of (type.enumValues ?? []).entries()) {
      if (!rawValue || typeof rawValue !== "object") continue;
      const name = (rawValue as { name?: unknown }).name;
      if (typeof name === "string") index.members.set(`${type.name}.${name}`, { source: "introspection", path: `${root}.types[${typeIndex}].enumValues[${valueIndex}]` });
    }
    for (const [memberIndex, rawMember] of (type.possibleTypes ?? []).entries()) {
      if (!rawMember || typeof rawMember !== "object") continue;
      const name = (rawMember as { name?: unknown }).name;
      if (typeof name === "string") index.members.set(`${type.name}.${name}`, { source: "introspection", path: `${root}.types[${typeIndex}].possibleTypes[${memberIndex}]` });
    }
  }
  for (const [directiveIndex, rawDirective] of (payload?.__schema?.directives ?? []).entries()) {
    if (!rawDirective || typeof rawDirective !== "object") continue;
    const directive = rawDirective as { name?: unknown; args?: unknown[] };
    if (typeof directive.name !== "string") continue;
    index.definitions.set(`directive:${directive.name}`, { source: "introspection", path: `${root}.directives[${directiveIndex}]` });
    for (const [argumentIndex, rawArgument] of (directive.args ?? []).entries()) {
      if (!rawArgument || typeof rawArgument !== "object") continue;
      const name = (rawArgument as { name?: unknown }).name;
      if (typeof name === "string") index.fields.set(`@${directive.name}.${name}`, { source: "introspection", path: `${root}.directives[${directiveIndex}].args[${argumentIndex}]` });
    }
  }
  return index;
}

function inputBytes(value: unknown): number {
  try {
    return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
  } catch {
    throw new GraphQLSchemaError("MALFORMED_SCHEMA", "GraphQL schema input must be serializable.");
  }
}

function assertSdlPreflight(raw: string, limits: Required<GraphQLSchemaLimits>): void {
  let listDepth = 0;
  let inString = false;
  let inBlockString = false;
  let inComment = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    const triple = raw.slice(index, index + 3) === '"""';
    if (inComment) {
      if (char === "\n" || char === "\r") inComment = false;
      continue;
    }
    if (inBlockString) {
      if (triple) { inBlockString = false; index += 2; }
      continue;
    }
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === "#") { inComment = true; continue; }
    if (triple) { inBlockString = true; index += 2; continue; }
    if (char === '"') { inString = true; continue; }
    if (char === "[") {
      listDepth += 1;
      if (listDepth > limits.maxTypeDepth) throw new GraphQLSchemaError("TYPE_TOO_DEEP", `GraphQL SDL exceeds maximum nesting depth ${limits.maxTypeDepth}.`);
    } else if (char === "]") {
      listDepth = Math.max(0, listDepth - 1);
    }
  }
}

function assertJsonPreflight(value: unknown, limits: Required<GraphQLSchemaLimits>): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const current = stack.pop()!;
    if (!current.value || typeof current.value !== "object") continue;
    if (current.depth > 256) throw new GraphQLSchemaError("MALFORMED_SCHEMA", "GraphQL introspection input is excessively nested.");
    if (seen.has(current.value as object)) throw new GraphQLSchemaError("MALFORMED_SCHEMA", "GraphQL introspection input must be an acyclic JSON value.");
    seen.add(current.value as object);
    const object = current.value as Record<string, unknown>;
    if (object.kind === "LIST" || object.kind === "NON_NULL") {
      let wrapper: unknown = object;
      let typeDepth = 0;
      while (wrapper && typeof wrapper === "object" && ((wrapper as Record<string, unknown>).kind === "LIST" || (wrapper as Record<string, unknown>).kind === "NON_NULL")) {
        typeDepth += 1;
        if (typeDepth > limits.maxTypeDepth) throw new GraphQLSchemaError("TYPE_TOO_DEEP", `GraphQL introspection type exceeds maximum nesting depth ${limits.maxTypeDepth}.`);
        wrapper = (wrapper as Record<string, unknown>).ofType;
      }
    }
    for (const nested of Array.isArray(current.value) ? current.value : Object.values(object)) stack.push({ value: nested, depth: current.depth + 1 });
  }
}

function sourceLocation(format: GraphQLSchemaSourceFormat, node: ASTNode | null | undefined, path: string): GraphQLSourceLocation {
  if (format === "introspection") return { source: format, path };
  if (!node?.loc) return { source: format };
  const location = getLocation(node.loc.source, node.loc.start);
  return { source: format, line: location.line, column: location.column };
}

function typeDepth(type: { ofType?: unknown }): number {
  let depth = 1;
  let current: unknown = type;
  while (current && typeof current === "object" && "ofType" in current && (current as { ofType?: unknown }).ofType) {
    depth += 1;
    current = (current as { ofType?: unknown }).ofType;
  }
  return depth;
}

function renderedDefault(value: unknown, astNode: InputValueDefinitionNode | null | undefined, type: GraphQLArgument["type"] | GraphQLInputField["type"]): string | undefined {
  if (astNode?.defaultValue) return print(astNode.defaultValue as never);
  if (value === undefined) return undefined;
  const valueNode = astFromValue(value, type);
  return valueNode ? print(valueNode) : undefined;
}

function assertTypeDepth(type: { ofType?: unknown; toString(): string }, limits: Required<GraphQLSchemaLimits>): void {
  if (typeDepth(type) > limits.maxTypeDepth) {
    throw new GraphQLSchemaError("TYPE_TOO_DEEP", `GraphQL type ${String(type)} exceeds maximum nesting depth ${limits.maxTypeDepth}.`);
  }
}

function argumentModel(argument: GraphQLArgument, format: GraphQLSchemaSourceFormat, path: string, limits: Required<GraphQLSchemaLimits>, exactLocation?: GraphQLSourceLocation): CanonicalGraphQLArgument {
  assertTypeDepth(argument.type, limits);
  return {
    name: argument.name,
    type: String(argument.type),
    ...(renderedDefault(argument.defaultValue, argument.astNode, argument.type) !== undefined ? { defaultValue: renderedDefault(argument.defaultValue, argument.astNode, argument.type) } : {}),
    ...(argument.description ? { description: argument.description } : {}),
    ...(argument.deprecationReason ? { deprecationReason: argument.deprecationReason } : {}),
    location: exactLocation ?? sourceLocation(format, argument.astNode, path),
  };
}

function outputFieldModel(field: GraphQLField<unknown, unknown>, format: GraphQLSchemaSourceFormat, path: string, limits: Required<GraphQLSchemaLimits>, exactLocation?: GraphQLSourceLocation, argumentLocation?: (name: string) => GraphQLSourceLocation | undefined): CanonicalGraphQLField {
  assertTypeDepth(field.type, limits);
  return {
    name: field.name,
    type: String(field.type),
    arguments: field.args.map((argument, index) => argumentModel(argument, format, `${path}.args[${index}]`, limits, argumentLocation?.(argument.name))).sort(byName),
    ...(field.description ? { description: field.description } : {}),
    ...(field.deprecationReason ? { deprecationReason: field.deprecationReason } : {}),
    location: exactLocation ?? sourceLocation(format, field.astNode, path),
  };
}

function inputFieldModel(field: GraphQLInputField, format: GraphQLSchemaSourceFormat, path: string, limits: Required<GraphQLSchemaLimits>, exactLocation?: GraphQLSourceLocation): CanonicalGraphQLField {
  assertTypeDepth(field.type, limits);
  const defaultValue = renderedDefault(field.defaultValue, field.astNode, field.type);
  return {
    name: field.name,
    type: String(field.type),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...(field.description ? { description: field.description } : {}),
    ...(field.deprecationReason ? { deprecationReason: field.deprecationReason } : {}),
    location: exactLocation ?? sourceLocation(format, field.astNode, path),
  };
}

function byName<T extends { name: string }>(left: T, right: T): number {
  return left.name.localeCompare(right.name);
}

function definitionKind(type: GraphQLNamedType): GraphQLDefinitionKind | undefined {
  if (isObjectType(type)) return "object";
  if (isInterfaceType(type)) return "interface";
  if (isInputObjectType(type)) return "input";
  if (isEnumType(type)) return "enum";
  if (isUnionType(type)) return "union";
  if (isScalarType(type)) return "scalar";
  return undefined;
}

function canonicalize(schema: GraphQLSchema, format: GraphQLSchemaSourceFormat, limits: Required<GraphQLSchemaLimits>, locations: LocationIndex): CanonicalGraphQLSchema {
  const definitions: CanonicalGraphQLDefinition[] = [];
  const types = Object.values(schema.getTypeMap()).filter((type) => !type.name.startsWith("__") && !(isScalarType(type) && isSpecifiedScalarType(type)));
  if (types.length + schema.getDirectives().filter((directive) => !directive.name.startsWith("__") && directive.astNode).length > limits.maxDefinitions) {
    throw new GraphQLSchemaError("TOO_MANY_DEFINITIONS", `GraphQL schema exceeds ${limits.maxDefinitions} definitions.`);
  }

  for (const [typeIndex, type] of types.entries()) {
    const kind = definitionKind(type);
    if (!kind) continue;
    const location = locations.definitions.get(`type:${type.name}`) ?? sourceLocation(format, type.astNode, `$.data.__schema.types[${typeIndex}]`);
    const definition: CanonicalGraphQLDefinition = { kind, name: type.name, location };
    if (type.description) definition.description = type.description;
    if (isObjectType(type) || isInterfaceType(type)) {
      const fields = Object.values(type.getFields());
      if (fields.length > limits.maxFieldsPerDefinition) throw new GraphQLSchemaError("TOO_MANY_FIELDS", `${type.name} exceeds ${limits.maxFieldsPerDefinition} fields.`);
      definition.fields = fields.map((field, fieldIndex) => outputFieldModel(
        field,
        format,
        `$.data.__schema.types[${typeIndex}].fields[${fieldIndex}]`,
        limits,
        locations.fields.get(`${type.name}.${field.name}`),
        (argumentName) => locations.arguments.get(`${type.name}.${field.name}(${argumentName})`),
      )).sort(byName);
      definition.interfaces = type.getInterfaces().map((item) => item.name).sort();
    } else if (isInputObjectType(type)) {
      const fields = Object.values(type.getFields());
      if (fields.length > limits.maxFieldsPerDefinition) throw new GraphQLSchemaError("TOO_MANY_FIELDS", `${type.name} exceeds ${limits.maxFieldsPerDefinition} fields.`);
      definition.fields = fields.map((field, fieldIndex) => inputFieldModel(field, format, `$.data.__schema.types[${typeIndex}].inputFields[${fieldIndex}]`, limits, locations.fields.get(`${type.name}.${field.name}`))).sort(byName);
    } else if (isEnumType(type)) {
      definition.enumValues = type.getValues().map((value) => value.name).sort();
      definition.enumValueDeprecations = Object.fromEntries(type.getValues().filter((value) => value.deprecationReason).map((value) => [value.name, value.deprecationReason!]));
      definition.memberLocations = Object.fromEntries(type.getValues().map((value) => [value.name, locations.members.get(`${type.name}.${value.name}`) ?? sourceLocation(format, value.astNode, `$.data.__schema.types[${typeIndex}].enumValues`)]));
    } else if (isUnionType(type)) {
      definition.unionMembers = type.getTypes().map((item) => item.name).sort();
      definition.memberLocations = Object.fromEntries(type.getTypes().map((item) => {
        const astMember = type.astNode?.types?.find((member) => member.name.value === item.name);
        return [item.name, locations.members.get(`${type.name}.${item.name}`) ?? sourceLocation(format, astMember, `$.data.__schema.types[${typeIndex}].possibleTypes`)];
      }));
    }
    definitions.push(definition);
  }

  const specifiedDirectiveNames = new Set(["skip", "include", "deprecated", "specifiedBy", "oneOf"]);
  for (const [directiveIndex, directive] of schema.getDirectives().entries()) {
    if (!isDirective(directive) || specifiedDirectiveNames.has(directive.name)) continue;
    definitions.push({
      kind: "directive",
      name: directive.name,
      fields: directive.args.map((argument, argIndex) => ({ ...argumentModel(argument, format, `$.data.__schema.directives[${directiveIndex}].args[${argIndex}]`, limits, locations.fields.get(`@${directive.name}.${argument.name}`)) })).sort(byName),
      directiveLocations: [...directive.locations].sort(),
      repeatable: directive.isRepeatable,
      ...(directive.description ? { description: directive.description } : {}),
      location: locations.definitions.get(`directive:${directive.name}`) ?? sourceLocation(format, directive.astNode, `$.data.__schema.directives[${directiveIndex}]`),
    });
  }

  const canonicalSdl = printSchema(lexicographicSortSchema(schema));
  return {
    sourceFormat: format,
    canonicalSdl,
    definitions: definitions.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)),
    digest: `sha256:${createHash("sha256").update(canonicalSdl).digest("hex")}`,
  };
}

function loadSchema(input: string | IntrospectionEnvelope, limits: Required<GraphQLSchemaLimits>): { schema: GraphQLSchema; format: GraphQLSchemaSourceFormat; locations: LocationIndex } {
  try {
    if (typeof input === "string") {
      if (inputBytes(input) > limits.maxInputBytes) throw new GraphQLSchemaError("INPUT_TOO_LARGE", `GraphQL schema input exceeds ${limits.maxInputBytes} bytes.`);
      assertSdlPreflight(input, limits);
      const document = parse(input, { maxTokens: Math.max(1_000, limits.maxDefinitions * limits.maxFieldsPerDefinition) });
      const names = new Set<string>();
      for (const definition of document.definitions) {
        if (!("name" in definition) || !definition.name) continue;
        if (!definition.kind.endsWith("_DEFINITION")) continue;
        const key = definition.kind === Kind.DIRECTIVE_DEFINITION ? `directive:${definition.name.value}` : `type:${definition.name.value}`;
        if (names.has(key)) throw new GraphQLSchemaError("DUPLICATE_DEFINITION", `Duplicate GraphQL definition ${definition.name.value}.`);
        names.add(key);
      }
      return { schema: buildASTSchema(document, { assumeValidSDL: false }), format: "sdl", locations: emptyLocationIndex() };
    }
    if (!input || typeof input !== "object") throw new Error("Expected SDL text or introspection JSON.");
    assertJsonPreflight(input, limits);
    if (inputBytes(input) > limits.maxInputBytes) throw new GraphQLSchemaError("INPUT_TOO_LARGE", `GraphQL schema input exceeds ${limits.maxInputBytes} bytes.`);
    const payload = "data" in input ? input.data : input;
    if (!payload || typeof payload !== "object" || !("__schema" in payload)) throw new Error("Expected a standard introspection response containing __schema.");
    return { schema: buildClientSchema(payload as never), format: "introspection", locations: introspectionLocationIndex(input) };
  } catch (error) {
    if (error instanceof GraphQLSchemaError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const duplicateMatch = message.match(/There can be only one type named "([^"]+)"/);
    if (duplicateMatch) throw new GraphQLSchemaError("DUPLICATE_DEFINITION", message);
    throw new GraphQLSchemaError("MALFORMED_SCHEMA", message);
  }
}

export function normalizeGraphQLSchema(input: string | IntrospectionEnvelope, options: GraphQLSchemaLimits = {}): CanonicalGraphQLSchema {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const loaded = loadSchema(input, limits);
  const validationErrors = validateSchema(loaded.schema);
  if (validationErrors.length) throw new GraphQLSchemaError("MALFORMED_SCHEMA", validationErrors.map((error) => error.message).join(" "));
  return canonicalize(loaded.schema, loaded.format, limits, loaded.locations);
}

function mapByName<T extends { name: string }>(items: readonly T[] | undefined): Map<string, T> {
  return new Map((items ?? []).map((item) => [item.name, item]));
}

function mapDefinitions(items: readonly CanonicalGraphQLDefinition[]): Map<string, CanonicalGraphQLDefinition> {
  return new Map(items.map((item) => [definitionKey(item.kind, item.name), item]));
}

function addChange(changes: GraphQLSchemaChange[], kind: string, coordinate: string, classification: GraphQLChangeClassification, hint: string, oldLocation?: GraphQLSourceLocation, newLocation?: GraphQLSourceLocation): void {
  changes.push({ kind, coordinate, classification, migrationHint: hint, ...(oldLocation ? { oldLocation } : {}), ...(newLocation ? { newLocation } : {}) });
}

function isNonNull(type: string): boolean { return type.endsWith("!"); }
function safeOutputTypeChange(oldType: TypeNode, newType: TypeNode): boolean {
  if (oldType.kind === Kind.NON_NULL_TYPE) {
    return newType.kind === Kind.NON_NULL_TYPE && safeOutputTypeChange(oldType.type, newType.type);
  }
  if (newType.kind === Kind.NON_NULL_TYPE) return safeOutputTypeChange(oldType, newType.type);
  if (oldType.kind === Kind.LIST_TYPE) return newType.kind === Kind.LIST_TYPE && safeOutputTypeChange(oldType.type, newType.type);
  return newType.kind === Kind.NAMED_TYPE && oldType.name.value === newType.name.value;
}

function safeInputTypeChange(oldType: TypeNode, newType: TypeNode): boolean {
  if (newType.kind === Kind.NON_NULL_TYPE) {
    return oldType.kind === Kind.NON_NULL_TYPE && safeInputTypeChange(oldType.type, newType.type);
  }
  if (oldType.kind === Kind.NON_NULL_TYPE) return safeInputTypeChange(oldType.type, newType);
  if (newType.kind === Kind.LIST_TYPE) return oldType.kind === Kind.LIST_TYPE && safeInputTypeChange(oldType.type, newType.type);
  return oldType.kind === Kind.NAMED_TYPE && oldType.name.value === newType.name.value;
}

function classifyTypeChange(oldType: string, newType: string, input: boolean): GraphQLChangeClassification {
  const safe = input ? safeInputTypeChange(parseType(oldType), parseType(newType)) : safeOutputTypeChange(parseType(oldType), parseType(newType));
  return safe ? "non_breaking" : "breaking";
}

function diffDeprecation(changes: GraphQLSchemaChange[], coordinate: string, oldReason: string | undefined, newReason: string | undefined, oldLocation: GraphQLSourceLocation, newLocation: GraphQLSourceLocation, kindPrefix = "deprecation"): void {
  if (!oldReason && newReason) addChange(changes, `${kindPrefix}_added`, coordinate, "dangerous", `Migrate away from deprecated ${coordinate}: ${newReason}.`, oldLocation, newLocation);
  else if (oldReason && !newReason) addChange(changes, `${kindPrefix}_removed`, coordinate, "non_breaking", `The deprecation marker for ${coordinate} was removed; review the provider rationale.`, oldLocation, newLocation);
  else if (oldReason && newReason && oldReason !== newReason) addChange(changes, `${kindPrefix}_reason_changed`, coordinate, "dangerous", `Review the updated deprecation guidance for ${coordinate}: ${newReason}.`, oldLocation, newLocation);
}

function diffFields(changes: GraphQLSchemaChange[], oldDefinition: CanonicalGraphQLDefinition, newDefinition: CanonicalGraphQLDefinition): void {
  const oldFields = mapByName(oldDefinition.fields);
  const newFields = mapByName(newDefinition.fields);
  const input = oldDefinition.kind === "input";
  for (const [name, field] of oldFields) {
    const next = newFields.get(name);
    const coordinate = `${oldDefinition.name}.${name}`;
    if (!next) { addChange(changes, input ? "input_field_removed" : "field_removed", coordinate, "breaking", `Restore ${coordinate} or migrate every consumer before removal.`, field.location); continue; }
    if (field.type !== next.type) addChange(changes, input ? "input_field_type_changed" : "field_type_changed", coordinate, classifyTypeChange(field.type, next.type, input), `Update ${coordinate} consumers from ${field.type} to ${next.type}.`, field.location, next.location);
    if (field.defaultValue !== next.defaultValue) addChange(changes, "default_value_changed", coordinate, "dangerous", `Review callers that rely on the previous default for ${coordinate}.`, field.location, next.location);
    diffDeprecation(changes, coordinate, field.deprecationReason, next.deprecationReason, field.location, next.location);
    if (!input) diffArguments(changes, oldDefinition.name, field, next);
  }
  for (const [name, field] of newFields) {
    if (oldFields.has(name)) continue;
    const coordinate = `${newDefinition.name}.${name}`;
    const classification: GraphQLChangeClassification = input && isNonNull(field.type) && field.defaultValue === undefined ? "breaking" : input ? "dangerous" : "additive";
    addChange(changes, input ? (classification === "breaking" ? "required_input_field_added" : "input_field_added") : "field_added", coordinate, classification, classification === "breaking" ? `Supply the new required input ${coordinate}.` : `Adopt ${coordinate} when useful.`, undefined, field.location);
  }
}

function diffArguments(changes: GraphQLSchemaChange[], typeName: string, oldField: CanonicalGraphQLField, newField: CanonicalGraphQLField): void {
  const oldArguments = mapByName(oldField.arguments);
  const newArguments = mapByName(newField.arguments);
  for (const [name, argument] of oldArguments) {
    const next = newArguments.get(name);
    const coordinate = `${typeName}.${oldField.name}(${name}:)`;
    if (!next) { addChange(changes, "argument_removed", coordinate, "breaking", `Remove ${name} from calls to ${typeName}.${oldField.name}.`, argument.location); continue; }
    if (argument.type !== next.type) addChange(changes, "argument_type_changed", coordinate, classifyTypeChange(argument.type, next.type, true), `Update ${coordinate} from ${argument.type} to ${next.type}.`, argument.location, next.location);
    if (argument.defaultValue !== next.defaultValue) addChange(changes, "default_value_changed", coordinate, "dangerous", `Review callers that rely on the previous default for ${coordinate}.`, argument.location, next.location);
    diffDeprecation(changes, coordinate, argument.deprecationReason, next.deprecationReason, argument.location, next.location, "argument_deprecation");
  }
  for (const [name, argument] of newArguments) {
    if (oldArguments.has(name)) continue;
    const coordinate = `${typeName}.${oldField.name}(${name}:)`;
    const required = isNonNull(argument.type) && argument.defaultValue === undefined;
    addChange(changes, required ? "required_argument_added" : "argument_added", coordinate, required ? "breaking" : "dangerous", required ? `Supply ${name} in every call to ${typeName}.${oldField.name}.` : `Adopt optional argument ${coordinate} when useful.`, undefined, argument.location);
  }
}

function diffSets(changes: GraphQLSchemaChange[], oldDefinition: CanonicalGraphQLDefinition, newDefinition: CanonicalGraphQLDefinition, property: "enumValues" | "unionMembers"): void {
  const oldValues = new Set(oldDefinition[property] ?? []);
  const newValues = new Set(newDefinition[property] ?? []);
  const prefix = property === "enumValues" ? "enum_value" : "union_member";
  for (const value of oldValues) if (!newValues.has(value)) addChange(changes, `${prefix}_removed`, `${oldDefinition.name}.${value}`, "breaking", `Migrate consumers of ${oldDefinition.name}.${value} before removal.`, oldDefinition.memberLocations?.[value] ?? oldDefinition.location);
  for (const value of newValues) if (!oldValues.has(value)) addChange(changes, `${prefix}_added`, `${newDefinition.name}.${value}`, "dangerous", `Update exhaustive consumers to handle ${newDefinition.name}.${value}.`, undefined, newDefinition.memberLocations?.[value] ?? newDefinition.location);
  if (property === "enumValues") {
    for (const value of oldValues) {
      if (!newValues.has(value)) continue;
      diffDeprecation(
        changes,
        `${oldDefinition.name}.${value}`,
        oldDefinition.enumValueDeprecations?.[value],
        newDefinition.enumValueDeprecations?.[value],
        oldDefinition.memberLocations?.[value] ?? oldDefinition.location,
        newDefinition.memberLocations?.[value] ?? newDefinition.location,
        "enum_value_deprecation",
      );
    }
  }
}

function diffInterfaces(changes: GraphQLSchemaChange[], oldDefinition: CanonicalGraphQLDefinition, newDefinition: CanonicalGraphQLDefinition): void {
  const oldInterfaces = new Set(oldDefinition.interfaces ?? []);
  const newInterfaces = new Set(newDefinition.interfaces ?? []);
  for (const name of oldInterfaces) if (!newInterfaces.has(name)) addChange(changes, "interface_implementation_removed", `${oldDefinition.name} implements ${name}`, "breaking", `Restore ${name} on ${oldDefinition.name} or migrate interface consumers.`, oldDefinition.location, newDefinition.location);
  for (const name of newInterfaces) if (!oldInterfaces.has(name)) addChange(changes, "interface_implementation_added", `${newDefinition.name} implements ${name}`, "dangerous", `Consumers may now use ${newDefinition.name} through ${name}.`, oldDefinition.location, newDefinition.location);
}

function diffDirective(changes: GraphQLSchemaChange[], oldDefinition: CanonicalGraphQLDefinition, newDefinition: CanonicalGraphQLDefinition): void {
  if (oldDefinition.repeatable && !newDefinition.repeatable) addChange(changes, "directive_repeatability_removed", `@${oldDefinition.name}`, "breaking", `Remove repeated uses of @${oldDefinition.name}.`, oldDefinition.location, newDefinition.location);
  else if (!oldDefinition.repeatable && newDefinition.repeatable) addChange(changes, "directive_repeatability_added", `@${oldDefinition.name}`, "additive", `@${oldDefinition.name} may now be repeated.`, oldDefinition.location, newDefinition.location);
  const oldLocations = new Set(oldDefinition.directiveLocations ?? []);
  const newLocations = new Set(newDefinition.directiveLocations ?? []);
  for (const location of oldLocations) if (!newLocations.has(location)) addChange(changes, "directive_location_removed", `@${oldDefinition.name} on ${location}`, "breaking", `Remove @${oldDefinition.name} from ${location} sites.`, oldDefinition.location, newDefinition.location);
  for (const location of newLocations) if (!oldLocations.has(location)) addChange(changes, "directive_location_added", `@${oldDefinition.name} on ${location}`, "additive", `@${oldDefinition.name} may now be used on ${location}.`, oldDefinition.location, newDefinition.location);
  const oldArguments = mapByName(oldDefinition.fields);
  const newArguments = mapByName(newDefinition.fields);
  for (const [name, argument] of oldArguments) {
    const next = newArguments.get(name);
    const coordinate = `@${oldDefinition.name}(${name}:)`;
    if (!next) { addChange(changes, "directive_argument_removed", coordinate, "breaking", `Remove ${name} from uses of @${oldDefinition.name}.`, argument.location); continue; }
    if (argument.type !== next.type) addChange(changes, "directive_argument_type_changed", coordinate, classifyTypeChange(argument.type, next.type, true), `Update ${coordinate} from ${argument.type} to ${next.type}.`, argument.location, next.location);
    if (argument.defaultValue !== next.defaultValue) addChange(changes, "directive_argument_default_changed", coordinate, "dangerous", `Review uses of ${coordinate} that rely on its default.`, argument.location, next.location);
  }
  for (const [name, argument] of newArguments) {
    if (oldArguments.has(name)) continue;
    const coordinate = `@${newDefinition.name}(${name}:)`;
    const required = isNonNull(argument.type) && argument.defaultValue === undefined;
    addChange(changes, required ? "required_directive_argument_added" : "directive_argument_added", coordinate, required ? "breaking" : "additive", required ? `Supply ${name} in every use of @${newDefinition.name}.` : `Adopt optional ${coordinate} when useful.`, undefined, argument.location);
  }
}

export function diffGraphQLSchemas(oldInput: string | IntrospectionEnvelope, newInput: string | IntrospectionEnvelope, options: GraphQLSchemaLimits = {}): GraphQLSchemaDiff {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const oldLoaded = loadSchema(oldInput, limits);
  const newLoaded = loadSchema(newInput, limits);
  for (const schema of [oldLoaded.schema, newLoaded.schema]) {
    const errors = validateSchema(schema);
    if (errors.length) throw new GraphQLSchemaError("MALFORMED_SCHEMA", errors.map((error) => error.message).join(" "));
  }
  // Run graphql-js's specification-aware compatibility oracles. Structured categories below
  // are derived from schema elements so callers never depend on unstable human prose.
  const oracle = {
    breaking: [...new Set(findBreakingChanges(oldLoaded.schema, newLoaded.schema).map((change) => String(change.type)))].sort(),
    dangerous: [...new Set(findDangerousChanges(oldLoaded.schema, newLoaded.schema).map((change) => String(change.type)))].sort(),
  };
  const oldSchema = canonicalize(oldLoaded.schema, oldLoaded.format, limits, oldLoaded.locations);
  const newSchema = canonicalize(newLoaded.schema, newLoaded.format, limits, newLoaded.locations);
  const oldDefinitions = mapDefinitions(oldSchema.definitions);
  const newDefinitions = mapDefinitions(newSchema.definitions);
  const changes: GraphQLSchemaChange[] = [];
  for (const [key, definition] of oldDefinitions) {
    const next = newDefinitions.get(key);
    const coordinate = definition.kind === "directive" ? `@${definition.name}` : definition.name;
    if (!next) { addChange(changes, definition.kind === "directive" ? "directive_removed" : "definition_removed", coordinate, "breaking", `Restore ${coordinate} or migrate every consumer before removal.`, definition.location); continue; }
    if (definition.kind !== next.kind) { addChange(changes, "definition_kind_changed", coordinate, "breaking", `Migrate ${coordinate} from ${definition.kind} to ${next.kind}.`, definition.location, next.location); continue; }
    if (["object", "interface", "input"].includes(definition.kind)) diffFields(changes, definition, next);
    if (definition.kind === "object" || definition.kind === "interface") diffInterfaces(changes, definition, next);
    if (definition.kind === "directive") diffDirective(changes, definition, next);
    if (definition.kind === "enum") diffSets(changes, definition, next, "enumValues");
    if (definition.kind === "union") diffSets(changes, definition, next, "unionMembers");
  }
  for (const [key, definition] of newDefinitions) {
    if (oldDefinitions.has(key)) continue;
    const directive = definition.kind === "directive";
    addChange(changes, directive ? "directive_added" : "definition_added", directive ? `@${definition.name}` : definition.name, "additive", `Adopt ${directive ? `@${definition.name}` : definition.name} when useful.`, undefined, definition.location);
  }
  changes.sort((left, right) => left.coordinate.localeCompare(right.coordinate) || left.kind.localeCompare(right.kind));
  const classification: GraphQLChangeClassification = changes.some((change) => change.classification === "breaking") || oracle.breaking.length > 0 ? "breaking" : changes.some((change) => change.classification === "dangerous") || oracle.dangerous.length > 0 ? "dangerous" : changes.some((change) => change.classification === "additive") ? "additive" : "non_breaking";
  return { classification, changes, oldSchema, newSchema, oracle };
}
