# はじめに

[English](getting-started.md)

クラウドへの初回デプロイの手順です。開発環境とローカルテストは [README](../README.ja.md) を参照してください。

## 1. 前提条件

インフラのリポジトリ（`cdktn_multicloud_backend`）で、参加するすべてのクラウドに次のものが
作成されている必要があります：

- ネットワーク、クラウド間のサイト間 VPN、プライベート DNS
- 論理レプリケーションを有効にした PostgreSQL 18
  （`rds.logical_replication`、`cloudsql.logical_decoding`、Azure は `wal_level = logical`）
- コンテナサービス（ECS / Cloud Run / Container Apps）とロードバランサー
- このリポジトリをビルドする CI/CD パイプライン（`buildspec.yml`、`cloudbuild.yaml`、`azure-pipelines.yml`）
- データベースのパスワードを入れたシークレット（各クラウドのシークレットストア）
- **各クラウドのコンテナから、すべてのクラウドのデータベース**へのポート 5432 の通信
  （書き込みはどのクラウドにあってもプライマリへ送るため）。レプリケーション用の
  データベース同士の通信に加えて必要です

DB スクリプトを実行するホストも必要です：

- プライベートネットワーク経由ですべてのデータベースに接続できること（例：いずれかのクラウドの VM）
- bash と `psql` 15 以上
- このリポジトリの clone

## 2. ノード設定

そのホストで、スクリプト用のノード設定を作ります：

```bash
cp replication/nodes.env.sample replication/nodes.env
```

ノード（`aws`、`google`、`azure`）ごとに設定します：

| 設定 | 値 |
| --- | --- |
| `NODE_<N>_HOST` | このホストから接続できるデータベースのアドレス |
| `NODE_<N>_REPL_HOST` | 他のデータベースがこのデータベースに接続するときのアドレス（`HOST` と異なる場合のみ） |
| `NODE_<N>_ADMIN_USER` | インフラで作成したデータベースの管理者ユーザー |
| `NODE_<N>_REPL_USER`, `NODE_<N>_API_USER` | 特に理由がなければ `app_repl` / `app_api` のまま |

`replication/nodes.env` は git の管理対象外です。共有のマシンではパスワードをファイルに書かず、
スクリプトを実行する直前にシークレットストアから読み出してシェルで export します：

```bash
export NODE_AWS_ADMIN_PASSWORD=...   NODE_AWS_REPL_PASSWORD=...   NODE_AWS_API_PASSWORD=...
export NODE_GOOGLE_ADMIN_PASSWORD=... NODE_GOOGLE_REPL_PASSWORD=... NODE_GOOGLE_API_PASSWORD=...
export NODE_AZURE_ADMIN_PASSWORD=...  NODE_AZURE_REPL_PASSWORD=...  NODE_AZURE_API_PASSWORD=...
```

API 用とレプリケーション用のパスワードは自分で決めます。API のコンテナは `DB_PASSWORD` を
シークレットストアから読むので、各クラウドのシークレットストアに登録してください。

## 3. データベースのセットアップ

次の順に実行します。どのスクリプトも再実行して問題ありません。

```bash
scripts/migrate.sh             # 全ノードにテーブルを作成
scripts/api-role-setup.sh      # app_api を作成し、スキーマ "app" へのアクセスを付与
scripts/replication-setup.sh   # 全ノードの組み合わせでパブリケーションとサブスクリプションを作成
scripts/switchover.sh <node>   # 最初のプライマリ（例：利用者が最も多い地域に近いクラウド）
scripts/replication-status.sh  # 確認
```

状態確認の出力で、すべてのノードのプライマリと世代番号が同じ、すべてのサブスクリプションが有効、
すべてのスロットが active、エラー件数が `0` であることを確認します。サブスクリプションが接続できない場合は、VPN、ポート 5432 の
ファイアウォール / セキュリティグループ / NSG のルール、`REPL_HOST` の設定を確認してください。

## 4. API コンテナの設定

各クラウドのコンテナには次の環境変数が必要です（インフラのリポジトリで設定します。
[.env.sample](../.env.sample) も参照）：

| 変数 | 値 |
| --- | --- |
| `CLOUD_ID` | `aws`、`google`、`azure` のいずれか。`NODES` のノード名と一致させる |
| `DB_HOST`, `DB_PORT`, `DB_NAME` | そのクラウドのデータベース |
| `DB_USER`, `DB_PASSWORD` | `app_api` とそのパスワード（シークレットストアから） |
| `DB_SSLMODE` | `require`。または `verify-full` と `DB_SSL_CA_FILE` |
| `GRAPHIQL_ENABLED` | `false` |
| `PEER_NODES` | 他のノード。AWS なら `google,azure` |
| `DB_<NODE>_HOST`, `DB_<NODE>_PASSWORD` | `PEER_NODES` の各ノードについて、このクラウドから接続できるデータベースのアドレスと、その `app_api` のパスワード |
| `WRITE_ACK_PEERS` | `1`（既定） |

その他の `DB_<NODE>_*` は、省略するとこのクラウドの値と同じになります。異なるノードだけ
設定してください（例：`DB_<NODE>_SSLMODE`）。

## 5. デプロイ

環境ごとに、それぞれのブランチ（`dev`、`staging`、`prod`）からデプロイします（[operations.ja.md](operations.ja.md#リリース)）。環境のブランチにマージすると、各クラウドがイメージをビルドし（ビルドでテストを実行）、新しいリビジョンを展開します：

- AWS：CodeBuild → ECR → ECS Blue/Green（サービスが安定しなければビルドが失敗する）
- Google Cloud：Cloud Build → Artifact Registry → Cloud Run
- Azure：Azure Pipelines → ACR → Container Apps

## 6. 確認

各クラウドのエンドポイントで確認します：

```bash
curl https://<endpoint>/healthz   # {"status":"ok","cloud":"<cloud>","version":"<commit>"}
curl https://<endpoint>/readyz    # データベースが応答し、マイグレーションが適用済みなら 200
```

続けて、README のローカルテストと同じように、あるクラウドでアイテムを作成し、別のクラウドから
読み出します。API のログに `Primary: <node> (epoch N)` が出ていることも確認します。
プライマリ以外のクラウドの API から書き込むと、クラウド間の経路を確認できます。そこで
`PRIMARY_UNAVAILABLE` になる場合は、多くの場合、そのコンテナからプライマリのデータベースに
接続できていません（経路、ファイアウォール / セキュリティグループ / NSG、プライベート DNS）。`readyz` が `503` を返す場合は、多くの場合 API がデータベースに接続・ログインできていないか、
そのノードにマイグレーションが足りません（API のログに名前が出ます）。`DB_*` と、そのノードで
`scripts/migrate.sh` と `scripts/api-role-setup.sh` を実行したかを確認してください。

初回デプロイの後、スクリプト用ホストで `scripts/journal-prune.sh` を定期実行（例：毎日）するよう
設定してください。[operations.ja.md](operations.ja.md#変更履歴ジャーナル) を参照してください。

## 次に読むもの

- 日々の運用手順：[operations.ja.md](operations.ja.md)
- 設計：[architecture.ja.md](architecture.ja.md)
