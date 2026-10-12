import { Entity } from "./repository";
import { EntityService, ListArgs } from "./service";

/**
 * Per-request batching for relations: all `customer` fields (belongsTo) or
 * all `lines` lists (hasMany) resolved in the same tick become one query,
 * instead of one query per parent row.
 */

type Load<V> = (keys: string[]) => Promise<Map<string, V>>;

class Batcher<V> {
  private pending: { key: string; resolve: (v: V) => void; reject: (e: unknown) => void }[] = [];

  constructor(
    private readonly load: Load<V>,
    private readonly missing: () => V,
  ) {}

  get(key: string): Promise<V> {
    return new Promise((resolve, reject) => {
      if (this.pending.length === 0) {
        // After the current resolvers have queued their keys.
        void Promise.resolve().then(() => process.nextTick(() => void this.dispatch()));
      }
      this.pending.push({ key, resolve, reject });
    });
  }

  private async dispatch(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    try {
      const values = await this.load([...new Set(batch.map((b) => b.key))]);
      for (const b of batch) b.resolve(values.get(b.key) ?? this.missing());
    } catch (error) {
      for (const b of batch) b.reject(error);
    }
  }
}

export class Loaders {
  private readonly batchers = new Map<string, Batcher<unknown>>();

  constructor(private readonly services: ReadonlyMap<string, EntityService>) {}

  private batcher<V>(key: string, load: Load<V>, missing: () => V): Batcher<V> {
    let b = this.batchers.get(key);
    if (!b) {
      b = new Batcher<unknown>(load as Load<unknown>, missing);
      this.batchers.set(key, b);
    }
    return b as Batcher<V>;
  }

  private service(model: string): EntityService {
    const s = this.services.get(model);
    if (!s) throw new Error(`No service for ${model}`);
    return s;
  }

  /** belongsTo: the row with this ID, or null. */
  byId(model: string, id: string): Promise<Entity | null> {
    return this.batcher<Entity | null>(
      `id:${model}`,
      (ids) => this.service(model).getMany(ids),
      () => null,
    ).get(id);
  }

  /** hasMany: the rows of `model` whose `field` is `parentId`. */
  children(model: string, field: string, args: ListArgs, parentId: string): Promise<Entity[]> {
    return this.batcher<Entity[]>(
      `children:${model}:${field}:${JSON.stringify(args)}`,
      (ids) => this.service(model).listByParents(field, ids, args),
      () => [],
    ).get(parentId);
  }
}
