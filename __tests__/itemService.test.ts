import { GraphQLError } from "graphql";
import { Item, ItemRepository } from "../src/items/repository";
import { ERROR_CODES, ItemService } from "../src/items/service";

const ID = "6f1c2b4e-8a9d-4c3b-9e7f-1a2b3c4d5e6f";

/** In-memory repository with the same conditional-write semantics as SQL. */
const memoryRepository = (rows: Item[] = []): ItemRepository => {
  const store = new Map(rows.map((row) => [row.id, { ...row }]));
  return {
    findById: async (id) => store.get(id) ?? null,
    list: async (limit, offset) => [...store.values()].slice(offset, offset + limit),
    insert: async (name, description, ownerCloud) => {
      const now = new Date();
      const item: Item = {
        id: ID,
        name,
        description,
        ownerCloud,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      store.set(item.id, item);
      return item;
    },
    update: async (id, ownerCloud, version, changes) => {
      const row = store.get(id);
      if (!row || row.ownerCloud !== ownerCloud || row.version !== version) {
        return null;
      }
      const updated: Item = {
        ...row,
        name: changes.name ?? row.name,
        description:
          changes.description !== undefined ? changes.description : row.description,
        version: row.version + 1,
      };
      store.set(id, updated);
      return updated;
    },
    delete: async (id, ownerCloud, version) => {
      const row = store.get(id);
      if (!row || row.ownerCloud !== ownerCloud || row.version !== version) {
        return false;
      }
      return store.delete(id);
    },
  };
};

const awsItem: Item = {
  id: ID,
  name: "first",
  description: null,
  ownerCloud: "aws",
  version: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const errorCode = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraphQLError) {
      return error.extensions.code;
    }
    throw error;
  }
  throw new Error("expected an error");
};

describe("ItemService", () => {
  test("create stamps the item with this cloud as owner", async () => {
    const service = new ItemService(memoryRepository(), "google");
    const item = await service.create("x", null);
    expect(item.ownerCloud).toBe("google");
    expect(item.version).toBe(1);
  });

  test("owner cloud can update with the current version", async () => {
    const service = new ItemService(memoryRepository([awsItem]), "aws");
    const item = await service.update(ID, 1, { name: "renamed" });
    expect(item).toMatchObject({ name: "renamed", version: 2 });
  });

  test("other clouds get NOT_OWNER", async () => {
    const service = new ItemService(memoryRepository([awsItem]), "azure");
    await expect(errorCode(service.update(ID, 1, { name: "x" }))).resolves.toBe(
      ERROR_CODES.notOwner,
    );
    await expect(errorCode(service.delete(ID, 1))).resolves.toBe(
      ERROR_CODES.notOwner,
    );
  });

  test("stale version gets VERSION_CONFLICT", async () => {
    const service = new ItemService(memoryRepository([awsItem]), "aws");
    await service.update(ID, 1, { name: "v2" });
    await expect(errorCode(service.update(ID, 1, { name: "x" }))).resolves.toBe(
      ERROR_CODES.versionConflict,
    );
  });

  test("missing item gets NOT_FOUND", async () => {
    const service = new ItemService(memoryRepository(), "aws");
    await expect(errorCode(service.delete(ID, 1))).resolves.toBe(
      ERROR_CODES.notFound,
    );
  });

  test("invalid input gets BAD_USER_INPUT", async () => {
    const service = new ItemService(memoryRepository(), "aws");
    expect(() => service.get("not-a-uuid")).toThrow(GraphQLError);
    expect(() => service.create("  ", null)).toThrow(GraphQLError);
    expect(() => service.list(0, 0)).toThrow(GraphQLError);
  });
});
