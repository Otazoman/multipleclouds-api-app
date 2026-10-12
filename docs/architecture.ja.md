# アーキテクチャ

[English](architecture.md)

## 概要

```
                 クライアント
        ┌───────────┼───────────┐
        ▼           ▼           ▼
   AWS (ALB)   Google (LB)  Azure (App Gateway)
        │           │           │
   ECS: API    Cloud Run: API  Container Apps: API     CLOUD_ID = aws / google / azure
        │  読み取り │  読み取り │  読み取り
        ▼           ▼           ▼
   RDS / Aurora  Cloud SQL   Flexible Server          PostgreSQL 18、スキーマ "app"
        └──── 論理レプリケーション（フルメッシュ、サイト間 VPN 経由） ────┘

   書き込み：すべての API → プライマリのデータベース（3つのうち1つ、VPN 経由）
```

- すべてのクラウドで同じコンテナイメージを動かします。`CLOUD_ID` で、
  そのインスタンスがどのクラウド（ノード）で動いているかを示します。
- 各 API は自クラウドのデータベースから**読み取り**、**書き込み**はどのクラウドに
  あってもプライマリのデータベースに送ります。
- データベース同士は PostgreSQL 標準の論理レプリケーションで変更を送り合うので、
  どのクラウドからでも全行を読めます。
- ネットワーク、VPN、プライベート DNS、データベース、コンテナサービス、CI/CD は
  インフラのリポジトリ（`cdktn_multicloud_backend`）で作成します。

## コンポーネント

| パス | 役割 |
| --- | --- |
| `src/index.ts` | 設定の読み込み、ノードごとのコネクションプールの作成、サーバーの起動、`SIGTERM` / `SIGINT` での正常終了 |
| `src/config.ts` | 環境変数の読み込みと検証。設定に誤りがあるコンテナは起動時に失敗する |
| `src/server.ts` | HTTP サーバー：`/`・`/healthz`（liveness）、`/readyz`（自クラウドの DB の readiness）、`/graphql` |
| `src/cluster.ts` | 書き込みの経路：プライマリの特定（`ClusterState`）、プライマリでのトランザクション実行、変更履歴への記録、冪等キーの処理、確認待ち（`PrimaryWriter`） |
| `models/*.yaml` | モデル定義。テーブルごとに1つ（[models.ja.md](models.ja.md)） |
| `src/models/` | 定義の読み込みと検証（`load.ts`）、DDL とスナップショットとの差分（`ddl.ts`） |
| `src/schema.ts` | モデルから生成する GraphQL スキーマとリゾルバー |
| `src/data/service.ts` | すべてのモデル共通の業務ルール：入力の検証と変換、楽観ロック、エラーコード |
| `src/data/repository.ts` | すべてのモデル共通のテーブルの SQL（値はパラメータのみ。識別子は検証済みの名前から） |
| `src/data/loaders.ts` | リレーションの読み取りをリクエスト単位でまとめる |
| `src/data/queries.ts` | 名前付きクエリ：自クラウドのデータベースで、タイムアウト付きの読み取り専用トランザクションで実行 |
| `src/generate.ts` | `npm run generate`：マイグレーションと `generated/schema.graphql` |
| `migrations/` | スキーマ変更。`scripts/migrate.sh` で全ノードに適用 |
| `scripts/` | DB 管理：マイグレーション、API ロール、レプリケーション、切り替え |

## データモデル

レプリケーションするテーブルはスキーマ `app` に置きます。各テーブルは次の列を持ちます：

| 列 | 用途 |
| --- | --- |
| `id uuid` | データベースが生成（`gen_random_uuid()`） |
| `owner_cloud text` | その行を作成した API のクラウド（記録用） |
| `version integer` | 更新のたびに加算。楽観ロックに使う |
| `created_at`, `updated_at` | タイムスタンプ |

`app.write_journal`（レプリケーションする）は、すべての書き込みトランザクションを記録します：
プライマリの世代番号とノード、mutation 名、引数、結果、冪等キー、時刻。後述の「変更履歴」を参照してください。

スキーマ `ops` はノードごとのデータで、レプリケーションしません：`ops.schema_migrations`
（適用済みのマイグレーション）と `ops.cluster_state`（このノードから見たプライマリ。後述）。

## 書き込み

### プライマリを1つにする理由

標準の論理レプリケーションには**競合を解決する仕組みがありません**。他ノードから届いた変更は、
ローカルの行をそのまま上書きします。2つのクラウドが同じ行を同時に更新すると、互いに相手の変更を
適用し、エラーもなくデータベースごとに異なる値が残ります。ロックは1つのデータベースの中でしか
効かないので、この問題を防げません。

そこで、すべての書き込みを1つのデータベース（**プライマリ**）に送ります。プライマリ上では、
行ロック、楽観ロック（`version`）、複数の SQL からなるトランザクションが、通常の PostgreSQL と
同じように効きます。他のデータベースはレプリケーションで変更を受け取ります。

### どのノードがプライマリか

各ノードは `ops.cluster_state` に、自分の名前、プライマリの名前、**世代番号（epoch）**
（切り替えのたびに加算）を持ちます。設定は `scripts/switchover.sh` で行います。各 API は
`PRIMARY_REFRESH_INTERVAL_MS` ごとに全ノードの状態を読み、見えている中で**世代番号が最も大きい**
プライマリを使います。世代番号は戻らないので、古い状態のまま復帰したノードが API を誤らせることはありません。

### 書き込みトランザクション

```
BEGIN; SELECT ops.assert_primary(<epoch>)                  -- 往復 1 回
  [; SELECT … FROM app.write_journal WHERE idempotency_key = …]
<mutation の SQL>                                           -- 1 文につき往復 1 回
INSERT INTO app.write_journal …; COMMIT;
  SELECT ops.wait_for_peers(<n>, <timeout>)                 -- 往復 1 回
```

1. `ops.assert_primary` は、そのノードがその世代のプライマリでなければ失敗します
   （`PRIMARY_UNAVAILABLE`。API はプライマリを確認し直します）。状態の行に共有ロックを取るので、
   切り替えは実行中の書き込みが終わるのを待ちます。
2. `COMMIT` の後、`ops.wait_for_peers` は、他の `WRITE_ACK_PEERS` 個以上のノードが、
   それまでに書かれた内容をすべて**ディスクに確定**するまで待ちます（各レプリケーションスロットの
   `confirmed_flush_lsn`）。サブスクリプションは `synchronous_commit = on` なので、
   クラウド間の往復 1 回＋数 ms で済みます。
3. その後で、API は成功を返します。`WRITE_ACK_TIMEOUT_MS` 以内に確認できなければ
   `COMMIT_UNCONFIRMED` を返します。この場合、書き込みはプライマリにはコミットされていますが、
   この時点でプライマリが落ちると失われる可能性があります。

このため、成功を返した書き込みは必ず2つ以上のクラウドに存在し、他から切り離されたプライマリは
何も確認できません。

別のクラウドの API から送る SQL は、1 文ごとにクラウド間の往復が発生します。mutation の SQL は少なく保ってください。

### 変更履歴（ジャーナル）と冪等キー

すべての書き込みトランザクションは、同じトランザクション内で `COMMIT` と同じ往復で
`app.write_journal` に1行を追加します。このテーブルはレプリケーションされるので、切り替え時もデータと一緒に移ります。

- **冪等キー。** `idempotencyKey` があると、最初の往復でそのキーも検索します。見つかった場合は何も実行せず、
  操作と引数が同じことを確認し（違えば `IDEMPOTENCY_KEY_REUSED`）、新しい書き込みと同じく確認を待ってから、
  保存しておいた結果を返します。同じキーの書き込みが同時に来た場合は、一意インデックスによって後の方が
  先の方の完了を待ち、その結果を返します。
- **復旧。** `scripts/journal-diff.sh` は、あるノードにあって別のノードにない書き込みを、引数と結果つきで
  一覧にします。例：旧プライマリを初期化する前に、その未確認の書き込みを確認する。
- **保持期間。** `scripts/journal-prune.sh` が、プライマリ上で古い行を削除します（既定 30 日）。
  これが冪等キーの有効期間にもなります。

### 切り替え

`scripts/switchover.sh` でプライマリを移します（[operations.ja.md](operations.ja.md#切り替え)）：

- **計画的な切り替え**（旧プライマリに接続できる）：旧プライマリに先に新しい世代を設定して
  書き込みを止め、切り替え先がすべてを確定するのを待ってから、他のノードに新しい世代を設定します。
  書き込みが失敗するのは 1 秒程度です（`PRIMARY_UNAVAILABLE`）。
- **強制切り替え**（旧プライマリが停止、または他のデータベースから切り離されている、`--force`）：
  旧プライマリにスクリプトから接続できる場合は、先にその書き込みを止めます。接続できる他の各ノードで、
  旧プライマリからのサブスクリプションを無効にし（未確認の書き込みが後から届いて新しいデータを
  上書きしないように）、新しい状態を設定します。切り替え先は、旧プライマリから最も多く受け取った
  ノードでなければなりません。旧プライマリは、初期化してから戻す必要があります。

他ノードから受け取った変更は転送されません（`origin = none`）。残ったノードが旧プライマリから
受け取った量に差がある場合、少ない方のノードはその書き込みが欠けるので、初期化が必要です
（スクリプトが警告します）。

## レプリケーション

`scripts/replication-setup.sh` が、`NODES` のすべてのノードの組み合わせに対して設定します：

- 各ノードは、スキーマ `app` の全テーブルをパブリケーション `mc_pub` として公開します。
- 各ノードは、他のすべてのノードをサブスクライブします：`mc_sub_<publisher>_to_<subscriber>`
- `origin = none`：他ノードから受け取った変更は転送しないので、変更がループしません。
- `copy_data = false`：サブスクリプション作成時に既存の行をコピーしません
  （`SEED_FROM` で新しいノードに初期データを入れる場合を除く）。
- `synchronous_commit = on`：受信側は適用したトランザクションをすぐにディスクに確定するので、
  プライマリの確認待ちが短くなります。

DDL はレプリケーションされません。各マイグレーションは `scripts/migrate.sh` で全ノードに適用し、
`ops.schema_migrations` に記録します。パブリケーションが公開するのは INSERT・UPDATE・DELETE だけで、
`TRUNCATE` はレプリケーションされません（全ノードから消す必要があるデータには `DELETE` を使います）。

サブスクリプションの接続文字列（レプリケーション用パスワードを含む）は、変更があれば
`scripts/replication-setup.sh` が更新します。

## データベースのロール

| ロール | 作成元 | 用途 |
| --- | --- | --- |
| 管理者 | クラウド（インフラのリポジトリ） | マイグレーション、レプリケーションの設定、切り替え |
| `app_api` | `scripts/api-role-setup.sh` | API の接続用。スキーマ `app` に `SELECT, INSERT, UPDATE, DELETE`。`ops` は関数の `EXECUTE` のみ |
| `app_repl` | `scripts/replication-setup.sh` | 他ノードのサブスクリプションが接続に使う |

`ops` の関数は `SECURITY DEFINER` です。API のロールは、`ops` のテーブルやレプリケーションの
統計情報へのアクセス権を必要としません。

## 設定

環境変数を `src/config.ts` で読みます。[.env.sample](../.env.sample) と README を参照してください。
各 API は全ノードの接続設定を必要とします（自ノードは `DB_*`、`PEER_NODES` の他ノードは `DB_<NODE>_*`）。
クラウドではコンテナ基盤が設定し、パスワードは各クラウドのシークレットストアから渡します。

## ビルドとデプロイ

各クラウドがそれぞれの CI/CD で同じ `Dockerfile` をビルドします：

| クラウド | ファイル | デプロイ先 |
| --- | --- | --- |
| AWS | `buildspec.yml`（CodeBuild） | ECS（Blue/Green） |
| Google Cloud | `cloudbuild.yaml`（Cloud Build） | Cloud Run |
| Azure | `azure-pipelines.yml`（Azure Pipelines） | Container Apps |

パイプライン、トリガー、変数はインフラのリポジトリで作成します。

## 予定している変更

- **フェーズ 3：MySQL。** DB に依存する部分（確認待ち、切り替え、SQL の方言）をアダプターに分離します。
  3 クラウドのマネージド MySQL での PoC の後に行います。
