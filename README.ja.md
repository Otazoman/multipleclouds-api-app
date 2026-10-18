# Multi-Cloud API App

[English](README.md)

AWS・Google Cloud・Azure に **アクティブ/アクティブ** でデプロイする GraphQL CRUD API です。
各クラウドで同じコンテナがそのクラウドの PostgreSQL を持ち、データベース同士は
双方向の論理レプリケーションで同期します。

- Node.js 24、TypeScript、[GraphQL Yoga](https://the-guild.dev/graphql/yoga-server)、[node-postgres](https://node-postgres.com/)
- 各 API は自クラウドのデータベースから読み、書き込みは**プライマリ**のデータベース
  （常に1ノード。`scripts/switchover.sh` で移す）に送ります
- 書き込みは、他のクラウドがディスクに確定してから成功を返します。そのため、
  切り替えで成功済みの書き込みが失われることはありません
- `version` による楽観ロック（不一致は `VERSION_CONFLICT`）
- テーブルと GraphQL API は YAML（`models/*.yaml`）で定義します（フィールド、検索条件、並び順、
  リレーション、条件指定の更新・削除、名前付き SQL クエリ）。`npm run generate` が SQL の
  マイグレーションを書き出します

## ドキュメント

- [モデル定義](docs/models.ja.md) — YAML の書式、生成される API、マイグレーション
- [はじめに](docs/getting-started.ja.md) — クラウドへの初回デプロイ
- [運用](docs/operations.ja.md) — マイグレーション、リリース（環境ごとのブランチ）、レプリケーションの監視、障害対応、ノードの追加・削除、パスワード
- [アーキテクチャ](docs/architecture.ja.md) — コンポーネント、データモデル、書き込みの経路、レプリケーション

## リポジトリの構成

| パス                                                    | 説明                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| `models/`                                               | モデル定義：テーブルごとに YAML ファイル1つ（[docs/models.ja.md](docs/models.ja.md)） |
| `src/`                                                  | API のソース：`models/`（定義、DDL）、`data/`（汎用のリポジトリとサービス）、`schema.ts`（GraphQL）、`cluster.ts`（書き込みの経路）、`generate.ts` |
| `generated/`                                            | `npm run generate` が書き出す `schema.graphql`（編集しない）         |
| `__tests__/`                                            | ユニットテスト（Jest。データベース不要）                             |
| `migrations/`                                           | SQL マイグレーション（手書き・生成）と `models.snapshot.json`。`scripts/migrate.sh` で全ノードに適用 |
| `scripts/`                                              | DB スクリプト：マイグレーション、API ロール、レプリケーション設定/確認 |
| `replication/`                                          | スクリプト用のノード設定（`nodes.local.env` は compose 用）          |
| `compose.yaml`                                          | ローカル環境：PostgreSQL 3 ノード＋ノードごとの API                  |
| `Dockerfile`                                            | API のコンテナイメージ                                               |
| `buildspec.yml`, `cloudbuild.yaml`, `azure-pipelines.yml` | AWS・Google Cloud・Azure の CI/CD                                  |
| `.env.sample`                                           | API が読む環境変数                                                   |
| `mise.toml`                                             | 開発用のツールのバージョン（Node.js）                                |
| `docs/`                                                 | ドキュメント（上記「ドキュメント」）                                 |

## 開発環境

必要なもの：

- [mise](https://mise.jdx.dev/)（Node.js を提供）
- Docker と Docker Compose v2

ホストに `psql` は不要です。DB スクリプトは compose の `tools` コンテナ内で実行します。

### 1. mise で Node.js を用意する

このリポジトリの `mise.toml` で、コンテナイメージ（`Dockerfile`）と同じ Node.js 24 を指定しています。

```bash
cd multicloud_api_apps
mise trust            # 初回のみ。mise から設定の信頼を求められた場合
mise install node     # mise.toml で指定された Node.js をインストール
node --version        # v24.x
```

### 2. 依存パッケージ

```bash
npm ci
```

### 3. 静的チェックとユニットテスト

```bash
npm run typecheck     # tsc --noEmit
npm test              # jest（__tests__/**/*.test.ts）
npm run build         # src/ を dist/ にコンパイル
npm run generate      # models/*.yaml からマイグレーションと generated/schema.graphql を生成
```

ユニットテストにデータベースは不要です。`models/*.yaml` を変更して `npm run generate` を
実行していない場合も、テストが失敗します。

## ローカルテスト（3 ノード）

`compose.yaml` は各クラウドの代わりとなる PostgreSQL 18 を 3 ノードと、
ノードごとに API を 1 つ起動します：

| サービス     | 役割                       | ホストからの URL                |
| ------------ | -------------------------- | ------------------------------- |
| `api-aws`    | `CLOUD_ID=aws` の API      | http://localhost:8081/graphql   |
| `api-google` | `CLOUD_ID=google` の API   | http://localhost:8082/graphql   |
| `api-azure`  | `CLOUD_ID=azure` の API    | http://localhost:8083/graphql   |
| `pg-aws`, `pg-google`, `pg-azure` | PostgreSQL ノード（ホストには公開しない） | — |

ローカルでは GraphiQL が有効なので、上記の URL をブラウザで開くと GraphQL IDE が使えます。
`compose.yaml` のパスワードは使い捨てのローカルコンテナ専用です。必要なら
`LOCAL_ADMIN_PASSWORD`、`LOCAL_API_PASSWORD`、`LOCAL_REPL_PASSWORD` で上書きできます。

### 1. コンテナを起動する

```bash
docker compose up -d --build
```

### 2. データベースをセットアップする

次の順に実行します（どのスクリプトも再実行して問題ありません）：

```bash
docker compose run --rm tools scripts/database-create.sh     # 全ノードにデータベース appdb を作成
docker compose run --rm tools scripts/migrate.sh             # 全ノードにテーブルと関数を作成
docker compose run --rm tools scripts/api-role-setup.sh      # API が接続するロールを作成
docker compose run --rm tools scripts/replication-setup.sh   # 双方向レプリケーションを設定
docker compose run --rm tools scripts/switchover.sh aws      # 最初のプライマリを設定
docker compose run --rm tools scripts/replication-status.sh  # 状態を確認
```

状態確認の出力で、すべてのノードが `primary_node = aws`、すべてのサブスクリプションが
`enabled = t`、すべてのスロットが `active = t`、エラー件数が `0` であることを確認します。

`migrate.sh` と `api-role-setup.sh` を実行するまでは `/readyz` が `503` を返しますが、これは想定どおりです。
`switchover.sh` を実行するまでは、書き込みが `PRIMARY_UNAVAILABLE` で失敗します。
API は 5 秒以内（`PRIMARY_REFRESH_INTERVAL_MS`）にプライマリを認識します。

### 3. API を確認する

ヘルスチェック：

```bash
curl localhost:8081/healthz    # liveness:  {"status":"ok","cloud":"aws","version":"unknown"}
curl localhost:8081/readyz     # readiness: データベースに接続でき、マイグレーションが適用済みか
```

`aws` でアイテムを作成：

```bash
curl -s localhost:8081/graphql -H 'content-type: application/json' \
  -d '{"query":"mutation { createItem(input: {name: \"hello\"}) { id ownerCloud version } }"}'
```

`azure` から読み出してレプリケーションを確認（`<id>` を置き換え）：

```bash
curl -s localhost:8083/graphql -H 'content-type: application/json' \
  -d '{"query":"{ cloud item(id: \"<id>\") { name ownerCloud version } }"}'
```

どのクラウドからでも（ここでは `google`）、読み出した version を指定して更新できます：

```bash
curl -s localhost:8082/graphql -H 'content-type: application/json' \
  -d '{"query":"mutation { updateItem(id: \"<id>\", version: 1, input: {name: \"updated\"}) { name version } }"}'
```

あわせて確認する動作：

- どの API に送った書き込みも成功する（プライマリ `aws` で実行される）
- 古い `version` を指定した更新・削除は `VERSION_CONFLICT` で失敗する

### 4. 切り替えを試す

計画的な切り替え（プライマリが稼働中）：

```bash
docker compose run --rm tools scripts/switchover.sh google
```

プライマリの障害。`--no-deps` を付けてください。付けないと `docker compose run` が
停止したデータベースを起動し直してしまいます。

```bash
docker compose stop pg-google                                        # 書き込み：PRIMARY_UNAVAILABLE
docker compose run --rm --no-deps tools scripts/switchover.sh --force azure
```

数秒で書き込みが再開します。停止したノードは、その後に初期化して戻す必要があります
（[operations.ja.md](docs/operations.ja.md#切り替え)）。ローカルで最も手早く元の状態に戻すには、
下の「ログと後片付け」を使います。

### 5. コードを変更したら

```bash
npm run typecheck && npm test
docker compose up -d --build   # API コンテナを再ビルドして再起動
```

`models/*.yaml` を変更したら、先に `npm run generate` を実行します（[docs/models.ja.md](docs/models.ja.md)）。
`migrations/` に新しいファイルができたら、`scripts/migrate.sh` を実行してから
`scripts/replication-setup.sh` を再実行します。論理レプリケーションは DDL を複製せず、
新しいテーブルをパブリケーションに追加する必要があるためです。その後、API を再ビルドします
（`docker compose up -d --build`）。API はモデルを起動時に読み込みます。

変更をリリースする（feature ブランチ → `dev` → `staging` → `prod` → `main`）手順は
[リリース](docs/operations.ja.md#リリース) を参照してください。

### 6. ログと後片付け

```bash
docker compose logs -f api-aws   # API のログ
docker compose down -v           # コンテナとデータベースのボリュームを停止・削除
```

PostgreSQL のデータは匿名ボリュームに保存されます。`-v` なしの `docker compose down`
でも次の `up` は空のデータベースで始まり、古いボリュームだけが残るため、`down -v` を
使ってください。最初からやり直すときは手順 1〜2 を再実行します。

## 環境変数

API は環境変数から設定を読みます（`src/config.ts`）。[.env.sample](.env.sample) を
参照してください。ローカル環境では `compose.yaml` が設定します。クラウドでは
コンテナ基盤が設定し、シークレットは各クラウドのシークレットストアから渡します。

| 変数               | 説明                                                |
| ------------------ | --------------------------------------------------- |
| `CLOUD_ID`         | このインスタンスが動くクラウド（`aws`、`google`、`azure`） |
| `PORT`             | 待ち受けポート（既定 `8080`）                       |
| `GRAPHIQL_ENABLED` | `true` で `/graphql` に GraphiQL を提供（ローカル専用） |
| `APP_VERSION`      | イメージのコミット。ヘルスチェックの応答に含める（`Dockerfile` が設定。既定 `unknown`） |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | 自クラウドのデータベース |
| `DB_SSLMODE`       | `disable`、`require`（既定）、`verify-full`         |
| `DB_SSL_CA_FILE`   | `verify-full` 用の CA バンドル                      |
| `DB_POOL_MAX`      | 自クラウドのデータベースのコネクションプールのサイズ（既定 `4`） |
| `DB_PEER_POOL_MAX` | `PEER_NODES` の各ノードのコネクションプールのサイズ。書き込みに使う（既定 `3`） |
| `PEER_NODES`       | 他のノード（カンマ区切り。例：`google,azure`）      |
| `DB_<NODE>_HOST`, `DB_<NODE>_PASSWORD` | `PEER_NODES` の各ノードのデータベース（必須） |
| `DB_<NODE>_PORT`, `_NAME`, `_USER`, `_SSLMODE`, `_SSL_CA_FILE` | 任意。省略時は自クラウドの `DB_*` と同じ（ポートは `5432`） |
| `WRITE_ACK_PEERS`  | 書き込みを確認する必要がある他ノードの数（既定 `1`。他ノードがなければ `0`） |
| `WRITE_ACK_TIMEOUT_MS` | 確認を待つ時間（既定 `3000`）                   |
| `PRIMARY_REFRESH_INTERVAL_MS` | プライマリを確認する間隔（既定 `5000`）  |
| `JOURNAL_RETENTION_DAYS` | ジャーナルの削除ジョブ（`node dist/prune.js`）のみ：書き込みと冪等キーを保持する日数（既定 `30`） |

## エラー

`BAD_USER_INPUT`、`NOT_FOUND`、`VERSION_CONFLICT` のほかに、書き込みは次のエラー
（`extensions.code`）で失敗することがあります：

| コード | 意味 | クライアントの対応 |
| --- | --- | --- |
| `PRIMARY_UNAVAILABLE` | プライマリが不明・接続できない・切り替わった直後。何も書き込まれていない | 少し待って再送 |
| `COMMIT_UNCONFIRMED` | プライマリに送ったが、コミットされたか・他クラウドに複製されたかが不明 | 同じ `idempotencyKey` で再送するか、再送の前に読み取りで確認 |
| `IDEMPOTENCY_KEY_REUSED` | その `idempotencyKey` は別の書き込みに使用済み | 書き込みごとに新しいキーを使う |
| `CONSTRAINT_VIOLATION` | 一意制約または外部キーが書き込みを拒否した | 入力を直す |
| `TOO_MANY_ROWS` | 条件指定の更新・削除の対象が `maxRows` を超えた。何も書き込まれていない | `where` を絞る |
| `QUERY_TIMEOUT` | 名前付きクエリが `timeoutMs` を超えた | パラメータを絞る |

### 冪等キー

すべての mutation は任意の引数 `idempotencyKey`（1〜200 文字。例：書き込みごとにクライアントが生成した
UUID）を受け付けます。同じキー・同じ引数で再送すると、書き込みをやり直さずに最初の結果を返します。
別のクラウドの API 経由でも、切り替えの後でも同じです。これにより、`COMMIT_UNCONFIRMED`・
`PRIMARY_UNAVAILABLE`・タイムアウトの後の再送が安全になります：

```graphql
mutation {
  createItem(input: {name: "hello"}, idempotencyKey: "7f9c…") { id }
}
```

キーは、変更履歴（ジャーナル）がその書き込みを保持している間だけ有効です
（`scripts/journal-prune.sh`、既定 30 日）。

## エンドポイント

| パス       | 説明                                         |
| ---------- | -------------------------------------------- |
| `/`, `/healthz` | liveness（データベースにアクセスしない）|
| `/readyz`  | readiness：自クラウドのデータベースが応答し、イメージに含まれるマイグレーションがすべて適用済み（そのノードで `scripts/migrate.sh` を実行するまで `503`）。プライマリは確認しない |
| `/graphql` | GraphQL API                                  |

ヘルスチェックはどれも `{"status", "cloud", "version"}` を返します。`version` はイメージのビルド元の
コミットで、すべてのクラウドで同じ版が動いているかの確認に使います。

## ライセンス

[MIT](LICENSE)
