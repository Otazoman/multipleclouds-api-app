import { createSchema } from "graphql-yoga";
import { Item } from "./items/repository";
import { ItemService } from "./items/service";

export interface GraphQLContext {
  items: ItemService;
  cloudId: string;
}

const typeDefs = /* GraphQL */ `
  type Item {
    id: ID!
    name: String!
    description: String
    "Cloud that created the item. Only that cloud's API can change it."
    ownerCloud: String!
    "Incremented on every update. Pass it back to updateItem / deleteItem."
    version: Int!
    createdAt: String!
    updatedAt: String!
  }

  input CreateItemInput {
    name: String!
    description: String
  }

  input UpdateItemInput {
    name: String
    "Set to null to clear."
    description: String
  }

  type Query {
    "Cloud that served this request."
    cloud: String!
    item(id: ID!): Item
    items(limit: Int = 50, offset: Int = 0): [Item!]!
  }

  type Mutation {
    createItem(input: CreateItemInput!): Item!
    updateItem(id: ID!, version: Int!, input: UpdateItemInput!): Item!
    deleteItem(id: ID!, version: Int!): Boolean!
  }
`;

interface UpdateItemInput {
  name?: string | null;
  description?: string | null;
}

export const schema = createSchema<GraphQLContext>({
  typeDefs,
  resolvers: {
    Item: {
      createdAt: (item: Item) => item.createdAt.toISOString(),
      updatedAt: (item: Item) => item.updatedAt.toISOString(),
    },
    Query: {
      cloud: (_parent, _args, ctx) => ctx.cloudId,
      item: (_parent, args: { id: string }, ctx) => ctx.items.get(args.id),
      items: (_parent, args: { limit: number; offset: number }, ctx) =>
        ctx.items.list(args.limit, args.offset),
    },
    Mutation: {
      createItem: (
        _parent,
        args: { input: { name: string; description?: string | null } },
        ctx,
      ) => ctx.items.create(args.input.name, args.input.description ?? null),
      updateItem: (
        _parent,
        args: { id: string; version: number; input: UpdateItemInput },
        ctx,
      ) =>
        ctx.items.update(args.id, args.version, {
          // A null name means "unchanged"; only description can be cleared.
          name: args.input.name ?? undefined,
          description: args.input.description,
        }),
      deleteItem: (_parent, args: { id: string; version: number }, ctx) =>
        ctx.items.delete(args.id, args.version),
    },
  },
});
