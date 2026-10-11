import { Pool } from "pg";

export interface Item {
  id: string;
  name: string;
  description: string | null;
  ownerCloud: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemChanges {
  name?: string;
  description?: string | null;
}

/** Data access for `app.items`. Business rules live in `ItemService`. */
export interface ItemRepository {
  findById(id: string): Promise<Item | null>;
  list(limit: number, offset: number): Promise<Item[]>;
  insert(
    name: string,
    description: string | null,
    ownerCloud: string,
  ): Promise<Item>;
  /** Updates the row only if owner and version match; null otherwise. */
  update(
    id: string,
    ownerCloud: string,
    version: number,
    changes: ItemChanges,
  ): Promise<Item | null>;
  /** Deletes the row only if owner and version match; false otherwise. */
  delete(id: string, ownerCloud: string, version: number): Promise<boolean>;
}

interface ItemRow {
  id: string;
  name: string;
  description: string | null;
  owner_cloud: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  "id, name, description, owner_cloud, version, created_at, updated_at";

const toItem = (row: ItemRow): Item => ({
  id: row.id,
  name: row.name,
  description: row.description,
  ownerCloud: row.owner_cloud,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const createPgItemRepository = (pool: Pool): ItemRepository => ({
  async findById(id) {
    const result = await pool.query<ItemRow>(
      `SELECT ${COLUMNS} FROM app.items WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? toItem(result.rows[0]) : null;
  },

  async list(limit, offset) {
    const result = await pool.query<ItemRow>(
      `SELECT ${COLUMNS} FROM app.items ORDER BY created_at, id LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return result.rows.map(toItem);
  },

  async insert(name, description, ownerCloud) {
    const result = await pool.query<ItemRow>(
      `INSERT INTO app.items (name, description, owner_cloud)
       VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [name, description, ownerCloud],
    );
    return toItem(result.rows[0]);
  },

  async update(id, ownerCloud, version, changes) {
    // COALESCE keeps the current value for fields that are not given.
    // "description" uses a flag so that it can be cleared to NULL.
    const result = await pool.query<ItemRow>(
      `UPDATE app.items
          SET name = COALESCE($4, name),
              description = CASE WHEN $5 THEN $6 ELSE description END,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND owner_cloud = $2 AND version = $3
        RETURNING ${COLUMNS}`,
      [
        id,
        ownerCloud,
        version,
        changes.name ?? null,
        changes.description !== undefined,
        changes.description ?? null,
      ],
    );
    return result.rows[0] ? toItem(result.rows[0]) : null;
  },

  async delete(id, ownerCloud, version) {
    const result = await pool.query(
      "DELETE FROM app.items WHERE id = $1 AND owner_cloud = $2 AND version = $3",
      [id, ownerCloud, version],
    );
    return result.rowCount === 1;
  },
});
