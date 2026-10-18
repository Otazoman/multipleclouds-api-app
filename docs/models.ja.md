# モデル定義

[English](models.md)

API の各テーブルは、`models/` の YAML ファイル1つで定義します。API は起動時にこれらのファイルから
GraphQL の型・クエリ・mutation を組み立てます。`npm run generate` は SQL のマイグレーションと、
GraphQL スキーマの出力を書き出します。

## 作業の流れ

1. `models/<name>.yaml` を追加・編集します。
2. 生成します：

   ```bash
   npm run generate
   ```

   - `migrations/NNNN_<change>.sql`：前回生成したマイグレーションからの変更分の SQL
     （`migrations/models.snapshot.json` と比較）
   - `generated/schema.graphql`：結果の GraphQL スキーマ（レビュー用）

3. 両方のファイルを確認し、ローカルでテストします（README の「ローカルテスト」）：

   ```bash
   docker compose run --rm tools scripts/migrate.sh
   docker compose run --rm tools scripts/replication-setup.sh   # 新しいテーブルがある場合
   docker compose up -d --build
   ```

4. YAML、マイグレーション、スナップショット、スキーマの出力をまとめてコミットします。
   マイグレーションか出力が足りないと `npm test` が失敗します。
5. クラウドでは `scripts/migrate.sh`、新しいテーブルがあれば `scripts/replication-setup.sh`、
   その後で API をデプロイします（[operations.ja.md](operations.ja.md#スキーマ変更マイグレーション)）。

`npm run generate -- --check` は何も変更せず、マイグレーションか出力が足りなければ失敗します（CI 用）。

## 例

```yaml
# models/order.yaml
name: Order                     # GraphQL の型。クエリは order / orders
description: A customer order.
fields:
  title:    { type: string, required: true, maxLength: 200 }
  status:   { type: enum, values: [draft, ordered, shipped], required: true, default: draft }
  amount:   { type: decimal, min: 0 }
  dueOn:    { type: date }
  memo:     { type: string, description: Free text. }
  meta:     { type: json }
indexes:
  - fields: [status, createdAt]
list:
  defaultLimit: 50
  maxLimit: 100
  filterable:
    status: [eq, in]
    amount: [gte, lte]
    memo: [ilike, isNull]
  sortable: [amount, dueOn, createdAt]
  defaultOrder:
    - { field: createdAt, direction: desc }
```

## モデル

| キー | 必須 | 説明 |
| --- | --- | --- |
| `name` | ○ | GraphQL の型名。PascalCase（`Order`） |
| `plural` | | 一覧クエリの名前。省略時は名前の英語の複数形を camelCase にしたもの（`orders`、`categories`） |
| `table` | | スキーマ `app` のテーブル名。省略時は `plural` の snake_case（`orders`、`order_lines`） |
| `description` | | GraphQL スキーマに表示する説明 |
| `fields` | ○ | モデルのフィールド（後述） |
| `indexes` | | 追加のインデックス（後述） |
| `relations` | | 他のモデルとのリレーション（後述） |
| `bulkWrite` | | 条件指定の更新・削除（後述） |
| `queries` | | 読み取り専用の名前付き SQL クエリ（後述） |
| `list` | | 一覧クエリの設定（後述） |

すべてのモデルに次のフィールドが自動で付きます。定義しないでください：

| フィールド | 列 | 型 | 説明 |
| --- | --- | --- | --- |
| `id` | `id` | `ID!` | データベースが生成する UUID |
| `ownerCloud` | `owner_cloud` | `String!` | その行を作成した API のクラウド |
| `version` | `version` | `Int!` | 更新のたびに加算。更新・削除のときに渡す |
| `createdAt`, `updatedAt` | `created_at`, `updated_at` | `String!` | ISO 8601 のタイムスタンプ |

## フィールド

フィールド名は camelCase で、列名はその snake_case です（`dueOn` → `due_on`）。

| キー | 説明 |
| --- | --- |
| `type` | 下の表の型のいずれか |
| `required` | `NOT NULL`。作成時に必須（`default` がある場合を除く） |
| `default` | 作成時に省略された場合の値 |
| `unique` | 一意制約 |
| `maxLength` | `string`：最大文字数 |
| `min`, `max` | `int`、`float`、`decimal`：範囲（両端を含む） |
| `values` | `enum`：許可する値（英数字と `_`） |
| `description` | GraphQL スキーマに表示する説明 |

| 型 | PostgreSQL | GraphQL | 備考 |
| --- | --- | --- | --- |
| `string` | `text` | `String` | 必須の文字列は空白のみを不可 |
| `int` | `integer` | `Int` | |
| `float` | `double precision` | `Float` | |
| `decimal` | `numeric` | `String` | 正確な数値を文字列で（例：`"12.34"`） |
| `boolean` | `boolean` | `Boolean` | |
| `datetime` | `timestamptz` | `String` | ISO 8601。`default: now` で現在時刻 |
| `date` | `date` | `String` | `YYYY-MM-DD` |
| `uuid` | `uuid` | `ID` | |
| `enum` | `text` + `CHECK` | enum `<Model><Field>` | 例：`OrderStatus` |
| `json` | `jsonb` | `JSON` | 任意の JSON。既定値・一意・並び替えは不可 |

`maxLength`、`min`、`max`、`values` は、API とデータベースの `CHECK` 制約の両方で確認します。

## インデックス

```yaml
indexes:
  - fields: [status, createdAt]          # orders_status_created_at_idx
  - fields: [title], unique: true        # orders_title_key
  - fields: [dueOn], name: orders_due    # 名前を指定
```

大きなテーブルでは、`filterable` の条件や `sortable` の並び順に使うフィールドにインデックスを
付けてください。名前は省略時 `<table>_<columns>_idx`（一意なら `_key`）で、63 文字以内である必要があります。

## 一覧の設定

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `defaultLimit` | 50 | `limit` を省略したときの件数 |
| `maxLimit` | 100 | 受け付ける `limit` の最大値 |
| `filterable` | なし | フィールド → `where` で使える演算子 |
| `sortable` | なし | `orderBy` で使えるフィールド |
| `defaultOrder` | `createdAt` の昇順 | `orderBy` を省略したときの並び順。最後に必ず `id` が加わる |

演算子：

| 演算子 | 意味 | 型 |
| --- | --- | --- |
| `eq`, `ne` | 等しい、等しくない | `json` 以外 |
| `in` | リストのいずれか | `string`、`int`、`float`、`decimal`、`date`、`uuid`、`enum` |
| `lt`, `lte`, `gt`, `gte` | 比較 | `string`、`int`、`float`、`decimal`、`datetime`、`date` |
| `like`, `ilike` | SQL のパターン（`%`、`_`）。`ilike` は大文字・小文字を区別しない | `string` |
| `isNull` | `true`：値なし、`false`：値あり | `required` でないフィールド |

使えるのは列挙したものだけです。これにより、クエリを意図した（インデックスのある）列に限定できます。

## リレーション

```yaml
# models/order.yaml
relations:
  customer: { belongsTo: Customer, required: true, onDelete: cascade }

# models/customer.yaml
relations:
  orders: { hasMany: Order, foreignKey: customer }
```

**belongsTo**（`customer: { belongsTo: Customer }`）で追加されるもの：

- フィールド `customerId`（列 `customer_id`、型 `uuid`）。他のフィールドと同様に作成・更新で指定でき、
  `filterable` にも使えます
- そのインデックス（すでにこのフィールドで始まるインデックスがあれば追加しません）
- `customers.id` への外部キー
- `Order` の GraphQL フィールド `customer: Customer`

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `belongsTo` | | 参照先のモデル |
| `required` | `false` | `customerId` を必須にする |
| `onDelete` | `restrict` | 顧客を削除したとき：`restrict`（注文があれば削除を拒否）、`cascade`（注文も削除）、`setNull`（`customerId` を空にする。`required` とは併用不可） |
| `description` | | `customerId` の説明 |

**hasMany**（`orders: { hasMany: Order, foreignKey: customer }`）は、`Customer` に GraphQL フィールド
`orders(where, orderBy, limit, offset): [Order!]!` を追加します。参照先の一覧設定が使われます。
`foreignKey` には、参照先にある `belongsTo` リレーションの名前を書きます。データベースは変わりません。

リレーションは自クラウドのデータベースから読みます。1つのリクエスト内のすべての `customer`
（または同じ引数のすべての `orders`）は、行ごとではなく1回のクエリでまとめて読み込みます。

一意制約や外部キーの違反（存在しない `customerId`、`restrict` で注文の残る顧客の削除など）は
`CONSTRAINT_VIOLATION` で失敗します。外部キーはプライマリでだけ確認されます。他のノードでは
レプリケーションが確認なしで行を適用するので、行が届く順序は問題になりません。

## 条件指定の更新・削除

```yaml
bulkWrite:
  update: true      # Mutation.updateOrders(where, input)
  delete: true      # Mutation.deleteOrders(where)
  maxRows: 1000     # 既定値
```

```graphql
mutation {
  updateOrders(where: {status: {eq: draft}}, input: {status: ordered}) { count }
}
```

- `where` にはモデルの `filterable` の設定を使います（条件指定の更新・削除には必須）。
  条件は1つ以上必要です。
- 該当する行が `maxRows` を超えると、何も書き込まずに `TOO_MANY_ROWS` で失敗します。
- 該当したすべての行の `version` が 1 増えます。プライマリ上の1つのトランザクションで実行され、
  変更履歴に記録され、他の書き込みと同じく `idempotencyKey` を使えます。

## 名前付きクエリ

生成されるクエリでは書けないもの（集計、結合）のために、読み取り専用の SQL を GraphQL のクエリとして公開します：

```yaml
queries:
  orderTotals:
    description: Total amount per status since a time.
    sql: |
      SELECT status, count(*) AS order_count, coalesce(sum(amount), 0) AS total
        FROM app.orders WHERE created_at >= :since GROUP BY status ORDER BY status
    params:
      since: { type: datetime, required: true }
    returns:
      status: { type: string }
      orderCount: { type: int }
      total: { type: decimal }
```

```graphql
{ orderTotals(since: "2026-01-01T00:00:00Z") { status orderCount total } }
```

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `sql` | | SQL 文1つ。`:name` がパラメータ（値はバインドされ、SQL に埋め込まれることはない） |
| `params` | なし | パラメータ：`type`（後述）、`required`、`description` |
| `returns` | | 結果の列：`type`、`required`、`description`。SQL の列名はキーかその snake_case にする（`orderCount` または `order_count`） |
| `list` | `true` | `false`：最初の1行または `null` を返す |
| `timeoutMs` | 5000 | 文のタイムアウト（最大 60000）。超えると `QUERY_TIMEOUT` |
| `description` | | GraphQL スキーマに表示する説明 |

型：`string`、`int`、`float`、`decimal`、`boolean`、`datetime`、`date`、`uuid`、`json`（フィールドと同じ）。
`int` は `count(*)` などの `bigint` の結果も受け付けます。

クエリは自クラウドのデータベースで、`READ ONLY` トランザクションの中で API のロールとして実行されます。
書き込みはできず、そのロールが読めるものだけが見えます。SQL 中のすべての `:name` を `params` に宣言し、
宣言したパラメータはすべて使う必要があります。`::type` のキャストは通常どおり書けます。文字列リテラル内の
`:word` はパラメータとみなされるので、そうした値はパラメータで渡してください。SQL は実行するまで検証されないため、
各クエリをローカルで試してください。

## 生成される API

`Order` の場合：

```graphql
type Query {
  order(id: ID!): Order
  orders(where: OrderWhere, orderBy: [OrderOrderBy!], limit: Int = 50, offset: Int = 0): [Order!]!
}
type Mutation {
  createOrder(input: CreateOrderInput!, idempotencyKey: String): Order!
  updateOrder(id: ID!, version: Int!, input: UpdateOrderInput!, idempotencyKey: String): Order!
  deleteOrder(id: ID!, version: Int!, idempotencyKey: String): Boolean!
}
```

```graphql
{
  orders(
    where: {status: {in: [ordered, shipped]}, amount: {gte: "100"}}
    orderBy: [{field: amount, direction: DESC}]
    limit: 20
  ) { id title status amount }
}
```

- `where`：指定した条件をすべて満たすもの（AND）。
- `updateOrder`：省略したフィールドは変更しません。`null` は必須でないフィールドの値を消します
  （必須フィールドの `null` は「変更なし」）。
- `relations`、`bulkWrite`、`queries` があれば、上で説明したフィールド・mutation・クエリ。
- 書き込みはプライマリで実行され、変更履歴に記録されます。`idempotencyKey` とエラーコードは
  [architecture.ja.md](architecture.ja.md#書き込み) と README を参照してください。

## 生成される変更

- 新しいモデル（テーブルとインデックス）
- 必須でない、または `default` のある新しいフィールド
- 必須でない新しい `belongsTo` リレーション（列、インデックス、外部キー）。`hasMany` はマイグレーション不要
- インデックスの追加・変更・削除
- `description`、`list`、`bulkWrite`、`queries`（マイグレーションなし。API だけが変わる）

## 生成されない変更

モデルやフィールドの削除、名前の変更、型や制約の変更は、データを失う可能性があり、
レプリケーションのもとでは全ノードで正しい順序で行う必要があります。`npm run generate` はこれらを拒否します。
代わりに次のようにします：

1. マイグレーションを手で書きます。`migrations/` の次の番号で、例：
   `migrations/0007_drop_orders_memo.sql`。稼働中の API と互換性を保ってください。
   例：列を削除する前に、その列を使わない API をデプロイする。
2. YAML をそれに合わせて更新します。
3. マイグレーションを生成せずに、新しい状態を受け入れます：

   ```bash
   npm run generate -- --baseline
   ```

手で作成した既存のテーブルも同じ扱いです（`migrations/0001_create_items.sql` と `models/item.yaml`）。

## レプリケーションに由来するルール

- すべてのテーブルにシステムフィールドがあり、`id` は UUID です。シーケンスは使わないでください
  （値が複製されません）。
- `npm run generate` がテーブルや列を TRUNCATE・削除することはありません。
- 新しいテーブルは、API が書き込む前にレプリケーションに追加する必要があります
  （`scripts/replication-setup.sh`）。
