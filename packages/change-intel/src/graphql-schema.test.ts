import { describe, expect, it } from "vitest";
import { buildSchema, getIntrospectionQuery, graphqlSync } from "graphql";
import {
  GraphQLSchemaError,
  diffGraphQLSchemas,
  normalizeGraphQLSchema,
} from "./index.js";

const BASE_SCHEMA = `
scalar DateTime

type Query {
  user: User
}

interface Node {
  id: ID!
}

type User implements Node {
  id: ID!
  name(format: String = "short"): String
  role: Role!
}

input UserFilter {
  limit: Int = 10
  query: String
}

enum Role {
  ADMIN
  USER
}

union SearchResult = User | Team

type Team implements Node {
  id: ID!
}

directive @auth(role: Role = USER) repeatable on FIELD_DEFINITION | OBJECT
`;

describe("GraphQL schema ingestion", () => {
  it("normalizes SDL into a deterministic bounded schema model without mutating input", () => {
    const input = BASE_SCHEMA;
    const result = normalizeGraphQLSchema(input);

    expect(input).toBe(BASE_SCHEMA);
    expect(result.sourceFormat).toBe("sdl");
    expect(result.definitions.map((definition) => `${definition.kind}:${definition.name}`)).toEqual([
      "directive:auth",
      "enum:Role",
      "input:UserFilter",
      "interface:Node",
      "object:Query",
      "object:Team",
      "object:User",
      "scalar:DateTime",
      "union:SearchResult",
    ]);

    const user = result.definitions.find((definition) => definition.name === "User");
    expect(user).toMatchObject({
      kind: "object",
      interfaces: ["Node"],
      location: { source: "sdl", line: 12, column: 1 },
    });
    expect(user?.fields?.find((field) => field.name === "name")).toMatchObject({
      type: "String",
      arguments: [{ name: "format", type: "String", defaultValue: '"short"' }],
      location: { source: "sdl", line: 14, column: 3 },
    });
  });

  it("normalizes standard introspection JSON using the same canonical model", () => {
    const input = {
      data: {
        __schema: {
          queryType: { name: "Query" },
          mutationType: null,
          subscriptionType: null,
          types: [
            {
              kind: "OBJECT",
              name: "Query",
              interfaces: [],
              fields: [
                {
                  name: "user",
                  type: { kind: "OBJECT", name: "User", ofType: null },
                  args: [
                    {
                      name: "id",
                      type: {
                        kind: "NON_NULL",
                        name: null,
                        ofType: { kind: "SCALAR", name: "ID", ofType: null },
                      },
                      defaultValue: null,
                    },
                  ],
                  isDeprecated: false,
                  deprecationReason: null,
                },
              ],
            },
            { kind: "SCALAR", name: "ID" },
            { kind: "SCALAR", name: "String" },
            {
              kind: "OBJECT",
              name: "User",
              interfaces: [],
              fields: [{ name: "id", type: { kind: "SCALAR", name: "ID", ofType: null }, args: [], isDeprecated: false, deprecationReason: null }],
            },
          ],
          directives: [
            {
              name: "auth",
              isRepeatable: false,
              locations: ["FIELD_DEFINITION"],
              args: [],
            },
          ],
        },
      },
    };
    const snapshot = structuredClone(input);

    const result = normalizeGraphQLSchema(input);

    expect(input).toEqual(snapshot);
    expect(result.sourceFormat).toBe("introspection");
    expect(result.definitions.find((definition) => definition.name === "Query")?.fields).toEqual([
      expect.objectContaining({
        name: "user",
        type: "User",
        arguments: [expect.objectContaining({ name: "id", type: "ID!" })],
        location: {
          source: "introspection",
          path: "$.data.__schema.types[0].fields[0]",
        },
      }),
    ]);
    expect(result.definitions.find((definition) => definition.name === "auth")).toMatchObject({
      kind: "directive",
      directiveLocations: ["FIELD_DEFINITION"],
    });
  });

  it("diffs definitions, fields, arguments, enum values, union members, and directives", () => {
    const next = `
scalar URL

type Query {
  user: User
}

interface Node {
  id: ID!
  displayName: String
}

type User implements Node {
  id: ID!
  displayName: String
  name(format: String!, locale: String!): String @deprecated(reason: "Use displayName")
}

input UserFilter {
  limit: Int = 20
  query: String!
  active: Boolean
}

enum Role {
  ADMIN
  OWNER
}

union SearchResult = User | Organization

type Team implements Node {
  id: ID!
  displayName: String
}

type Organization {
  id: ID!
}

directive @authenticated on FIELD_DEFINITION
`;

    const diff = diffGraphQLSchemas(BASE_SCHEMA, next);

    expect(diff.classification).toBe("breaking");
    expect(diff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "definition_removed", coordinate: "DateTime", classification: "breaking" }),
        expect.objectContaining({ kind: "definition_added", coordinate: "URL", classification: "additive" }),
        expect.objectContaining({ kind: "field_removed", coordinate: "User.role", classification: "breaking" }),
        expect.objectContaining({ kind: "field_added", coordinate: "User.displayName", classification: "additive" }),
        expect.objectContaining({ kind: "argument_type_changed", coordinate: "User.name(format:)", classification: "breaking" }),
        expect.objectContaining({ kind: "required_argument_added", coordinate: "User.name(locale:)", classification: "breaking" }),
        expect.objectContaining({ kind: "input_field_type_changed", coordinate: "UserFilter.query", classification: "breaking" }),
        expect.objectContaining({ kind: "default_value_changed", coordinate: "UserFilter.limit", classification: "dangerous" }),
        expect.objectContaining({ kind: "enum_value_removed", coordinate: "Role.USER", classification: "breaking" }),
        expect.objectContaining({ kind: "enum_value_added", coordinate: "Role.OWNER", classification: "dangerous" }),
        expect.objectContaining({ kind: "union_member_removed", coordinate: "SearchResult.Team", classification: "breaking" }),
        expect.objectContaining({ kind: "union_member_added", coordinate: "SearchResult.Organization", classification: "dangerous" }),
        expect.objectContaining({ kind: "deprecation_added", coordinate: "User.name", classification: "dangerous" }),
        expect.objectContaining({ kind: "directive_removed", coordinate: "@auth", classification: "breaking" }),
        expect.objectContaining({ kind: "directive_added", coordinate: "@authenticated", classification: "additive" }),
      ]),
    );
    expect(diff.changes.every((change) => change.migrationHint.length > 0)).toBe(true);
    expect(diff.changes.find((change) => change.coordinate === "UserFilter.query")?.newLocation).toEqual({
      source: "sdl",
      line: 21,
      column: 3,
    });
  });

  it("classifies compatible nullability changes and pure additions", () => {
    const oldSchema = `type Query { user: User } type User { id: ID! }`;
    const newSchema = `type Query { user: User! } type User { id: ID!, name: String } scalar Date`;

    const diff = diffGraphQLSchemas(oldSchema, newSchema);

    expect(diff.classification).toBe("additive");
    expect(diff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "field_type_changed", coordinate: "Query.user", classification: "non_breaking" }),
        expect.objectContaining({ kind: "field_added", coordinate: "User.name", classification: "additive" }),
      ]),
    );
  });

  it("rejects duplicate, malformed, oversized, and excessively deep inputs", () => {
    expect(() => normalizeGraphQLSchema("type Query { id: ID } type Query { name: String }"))
      .toThrowError(expect.objectContaining<Partial<GraphQLSchemaError>>({ code: "DUPLICATE_DEFINITION" }));
    expect(() => normalizeGraphQLSchema("type Query { id ID }"))
      .toThrowError(expect.objectContaining<Partial<GraphQLSchemaError>>({ code: "MALFORMED_SCHEMA" }));
    expect(() => normalizeGraphQLSchema("type Query { value: String }", { maxInputBytes: 8 }))
      .toThrowError(expect.objectContaining<Partial<GraphQLSchemaError>>({ code: "INPUT_TOO_LARGE" }));
    expect(() => normalizeGraphQLSchema("type Query { value: [[[[String]]]] }", { maxTypeDepth: 3 }))
      .toThrowError(expect.objectContaining<Partial<GraphQLSchemaError>>({ code: "TYPE_TOO_DEEP" }));
  });

  it("reports interface membership changes instead of discarding compatibility findings", () => {
    const oldSchema = `interface Named { name: String } type User implements Named { name: String } type Query { user: User }`;
    const newSchema = `interface Named { name: String } type User { name: String } type Query { user: User }`;

    const diff = diffGraphQLSchemas(oldSchema, newSchema);

    expect(diff.classification).toBe("breaking");
    expect(diff.oracle.breaking.length).toBeGreaterThan(0);
    expect(diff.changes).toContainEqual(expect.objectContaining({
      kind: "interface_implementation_removed",
      coordinate: "User implements Named",
      classification: "breaking",
    }));

    const added = diffGraphQLSchemas(newSchema, oldSchema);
    expect(added.changes).toContainEqual(expect.objectContaining({
      kind: "interface_implementation_added",
      coordinate: "User implements Named",
      classification: "dangerous",
    }));
  });

  it("aligns optional input and argument additions with graphql-js dangerous findings", () => {
    const oldSchema = `input Filter { term: String } type Query { search(filter: Filter): String }`;
    const newSchema = `input Filter { term: String, limit: Int } type Query { search(filter: Filter, locale: String): String }`;

    const diff = diffGraphQLSchemas(oldSchema, newSchema);

    expect(diff.oracle.dangerous).toEqual(expect.arrayContaining(["OPTIONAL_INPUT_FIELD_ADDED", "OPTIONAL_ARG_ADDED"]));
    expect(diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "input_field_added", coordinate: "Filter.limit", classification: "dangerous" }),
      expect.objectContaining({ kind: "argument_added", coordinate: "Query.search(locale:)", classification: "dangerous" }),
    ]));
  });

  it("diffs directive locations, repeatability, and required arguments", () => {
    const oldSchema = `directive @auth repeatable on FIELD_DEFINITION | OBJECT type Query { value: String }`;
    const newSchema = `directive @auth(role: String!) on FIELD_DEFINITION type Query { value: String }`;

    const diff = diffGraphQLSchemas(oldSchema, newSchema);

    expect(diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "directive_repeatability_removed", coordinate: "@auth", classification: "breaking" }),
      expect.objectContaining({ kind: "directive_location_removed", coordinate: "@auth on OBJECT", classification: "breaking" }),
      expect.objectContaining({ kind: "required_directive_argument_added", coordinate: "@auth(role:)", classification: "breaking" }),
    ]));
  });

  it("keeps type and directive namespaces distinct", () => {
    const oldSchema = `scalar auth directive @auth on FIELD_DEFINITION type Query { value: auth }`;
    const newSchema = `scalar auth type Query { value: auth }`;

    expect(diffGraphQLSchemas(oldSchema, newSchema).changes).toContainEqual(expect.objectContaining({
      kind: "directive_removed",
      coordinate: "@auth",
    }));
  });

  it("normalizes default values identically across SDL and introspection", () => {
    const sdl = `enum Role { USER } input Filter { roles: [Role!] = [USER] } type Query { value(role: Role = USER, filter: Filter = { roles: [USER] }): String }`;
    const schema = buildSchema(sdl);
    const introspection = graphqlSync({ schema, source: getIntrospectionQuery({ inputValueDeprecation: true }) });

    const fromSdl = normalizeGraphQLSchema(sdl);
    if (!introspection.data) throw new Error("Expected introspection data");
    const fromIntrospection = normalizeGraphQLSchema({ data: introspection.data as { __schema: unknown } });

    expect(fromIntrospection.canonicalSdl).toBe(fromSdl.canonicalSdl);
    const withoutLocations = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, nested) => key === "location" || key === "memberLocations" ? undefined : nested));
    expect(withoutLocations(fromIntrospection.definitions)).toEqual(withoutLocations(fromSdl.definitions));
  });

  it("reports exact introspection paths independent of array ordering", () => {
    const introspection = graphqlSync({
      schema: buildSchema(`scalar Z type Query { value: Z }`),
      source: getIntrospectionQuery(),
    });
    if (!introspection.data) throw new Error("Expected introspection data");
    const types = (introspection.data.__schema as { types: Array<{ name: string }> }).types;
    types.reverse();
    const expectedIndex = types.findIndex((type) => type.name === "Query");

    const normalized = normalizeGraphQLSchema({ data: introspection.data as { __schema: unknown } });

    expect(normalized.definitions.find((definition) => definition.name === "Query")?.location.path)
      .toBe(`$.data.__schema.types[${expectedIndex}]`);
  });

  it("accepts multiple valid extensions while rejecting conflicting definitions", () => {
    const normalized = normalizeGraphQLSchema(`
      type Query { value: String }
      extend type Query { count: Int }
      extend type Query { active: Boolean }
    `);

    expect(normalized.definitions.find((definition) => definition.name === "Query")?.fields?.map((field) => field.name))
      .toEqual(["active", "count", "value"]);
    expect(() => normalizeGraphQLSchema(`type Query { value: String } type Query { count: Int }`))
      .toThrowError(expect.objectContaining<Partial<GraphQLSchemaError>>({ code: "DUPLICATE_DEFINITION" }));
  });

  it("handles nested input and output nullability variance and all deprecation transitions", () => {
    const oldSchema = `
      enum State { ACTIVE @deprecated(reason: "old") }
      type Query { values(filter: [[String!]!]!): [[String]], old: String @deprecated(reason: "v1") }
    `;
    const newSchema = `
      enum State { ACTIVE }
      type Query { values(filter: [[String]]): [[String!]], old: String @deprecated(reason: "v2") }
    `;

    const diff = diffGraphQLSchemas(oldSchema, newSchema);

    expect(diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "argument_type_changed", coordinate: "Query.values(filter:)", classification: "non_breaking" }),
      expect.objectContaining({ kind: "field_type_changed", coordinate: "Query.values", classification: "non_breaking" }),
      expect.objectContaining({ kind: "deprecation_reason_changed", coordinate: "Query.old", classification: "dangerous" }),
      expect.objectContaining({ kind: "enum_value_deprecation_removed", coordinate: "State.ACTIVE", classification: "non_breaking" }),
    ]));
  });

  it("provides a stable digest over canonical content", () => {
    const first = normalizeGraphQLSchema(`type Query { b: String, a: String }`);
    const second = normalizeGraphQLSchema(`type Query { a: String b: String }`);

    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.digest).toBe(first.digest);
  });

  it("rejects excessive SDL nesting before invoking graphql-js parsing", () => {
    const nestedType = `${"[".repeat(10_000)}String${"]".repeat(10_000)}`;

    expect(() => normalizeGraphQLSchema(`type Query { value: ${nestedType} }`, { maxTypeDepth: 8 }))
      .toThrowError(expect.objectContaining<Partial<GraphQLSchemaError>>({ code: "TYPE_TOO_DEEP" }));
  });
});
