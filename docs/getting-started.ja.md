# はじめに

[English](getting-started.md)

クラウドへの初回デプロイの手順です。開発環境とローカルテストは [README](../README.ja.md) を参照してください。

## 全体の流れ

| # | 作業 | 場所 | 詳細 |
| --- | --- | --- | --- |
| 1 | API のフラグ（`azureSecretReady`、`readinessProbe`、`journalPrune.enabled`）を無効にしてインフラを構築 | インフラのリポジトリ：`cdktn diff`、`cdktn deploy` | インフラの getting-started と operations（「deploy」「destroy の後にもう一度 deploy する」） |
| 2 | すべてのクラウドに API のパスワードのシークレットを入れる（同じ値） | 各クラウドの Cloud Shell か VM。Azure は VM から（Key Vault は VNet の中） | インフラの operations の「シークレット」 |
| 3 | Azure：`azureSecretReady: true` にして `cdktn deploy` | インフラのリポジトリ | インフラの operations の「シークレット」 |
| 4 | データベースのセットアップ | 各クラウドの VM（データベースはプライベート） | 下の 2〜3 章 |
| 5 | API のデプロイ：環境のブランチにマージ | GitHub（プルリクエスト）。各クラウドの CI/CD がビルドしてデプロイ | 5 章、[operations.ja.md](operations.ja.md#リリース) |
| 6 | 確認 | 自分の端末 | 6 章 |
| 7 | `readinessProbe` と `journalPrune.enabled` を `true` にして `cdktn deploy` | インフラのリポジトリ | インフラの設定の説明の「API コンテナ」 |

1〜3 がインフラの構築で、4 からがこのリポジトリの作業です。

## 1. 前提条件

API の動かし方は2通りです（インフラのリポジトリの `apiContainerConfig.topology` で設定します）：

- **クラスタ**（2〜3 クラウド）：クラウドで1つのデータを共有します。各 API は自クラウドのデータベースから
  読み、プライマリに書き込み、データベース同士がレプリケーションします。クラウド間の VPN とプライベート DNS が
  必要です。
- **クラウド単体**（`independent`、またはデータベースが1クラウドだけ）：各クラウドの API は自クラウドの
  データベースだけを使い、データもクラウドごとに別々です。VPN とプライベート DNS は不要です。1クラウドだけで
  試すときに使います。後からクラスタにすると、データが残るのは1つのクラウドだけです（他はリセットして
  そこからコピーします：[operations.ja.md](operations.ja.md#外したノードを戻す)）。

インフラのリポジトリ（`cdktn_multicloud_backend`）で、参加するすべてのクラウドに次のものが
作成されている必要があります：

- ネットワーク。クラスタの場合は、クラウド間のサイト間 VPN とプライベート DNS
- 論理レプリケーションを有効にした PostgreSQL 18
  （`rds.logical_replication`、`cloudsql.logical_decoding`、Azure は `wal_level = logical`）
- コンテナサービス（ECS / Cloud Run / Container Apps）とロードバランサー
- このリポジトリをビルドする CI/CD パイプライン（`buildspec.yml`、`cloudbuild.yaml`、`azure-pipelines.yml`）
- データベースのパスワードを入れたシークレット（各クラウドのシークレットストア）
- クラスタの場合は、**各クラウドのコンテナから、すべてのクラウドのデータベース**へのポート 5432 の通信
  （書き込みはどのクラウドにあってもプライマリへ送るため）。レプリケーション用の
  データベース同士の通信に加えて必要です

DB スクリプトを実行するホストも必要です：

- プライベートネットワーク経由ですべてのデータベースに接続できること（例：いずれかのクラウドの VM）
- bash と `psql` 15 以上
- このリポジトリの clone

## 2. ノード設定

**クラウド単体**（各クラウドが自分のデータベースだけで動く）の場合は、この章は不要です。各クラウドの VM で
`scripts/node-setup.sh <cloud>` を実行します（3 章）。

クラスタの場合は、ホストでスクリプト用のノード設定を作ります：

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
export NODE_AWS_ADMIN_PASSWORD=...   NODE_AWS_REPL_PASSWORD=...
export NODE_GOOGLE_ADMIN_PASSWORD=... NODE_GOOGLE_REPL_PASSWORD=...
export NODE_AZURE_ADMIN_PASSWORD=...  NODE_AZURE_REPL_PASSWORD=...
# API のパスワードは全ノード共通
export NODE_AWS_API_PASSWORD=... NODE_GOOGLE_API_PASSWORD=$NODE_AWS_API_PASSWORD NODE_AZURE_API_PASSWORD=$NODE_AWS_API_PASSWORD
```

クラスタでは、Azure の VM（Key Vault を読める唯一の場所）で、すべてのクラウドの CLI にサインインして
（インフラの operations の「シークレット」）、値をシークレットストアから読み出してスクリプトを実行します：

```bash
export NODE_AWS_API_PASSWORD="$(aws secretsmanager get-secret-value --region ap-northeast-1 \
  --secret-id multicloud-aws-secret-db-api-password --query SecretString --output text)"
export NODE_GOOGLE_API_PASSWORD="$NODE_AWS_API_PASSWORD" NODE_AZURE_API_PASSWORD="$NODE_AWS_API_PASSWORD"
export NODE_AWS_REPL_PASSWORD="$(aws secretsmanager get-secret-value --region ap-northeast-1 \
  --secret-id multicloud-aws-secret-db-repl-password --query SecretString --output text)"
export NODE_GOOGLE_REPL_PASSWORD="$(gcloud secrets versions access latest \
  --secret=multicloud-google-secret-db-repl-password)"
export NODE_AZURE_REPL_PASSWORD="$(az keyvault secret show --vault-name multicloud-kv-001 \
  --name db-repl-password --query value --output tsv)"
# DB の管理者パスワード（インフラの .env.<環境名>）：入力する（表示されない）
for n in AWS GOOGLE AZURE; do
  read -rsp "NODE_${n}_ADMIN_PASSWORD: " v && echo && export "NODE_${n}_ADMIN_PASSWORD=$v"
done
```

クラスタに入らないクラウドの行は除き、終わったらクラウドからサインアウトします。

API 用とレプリケーション用のパスワードは自分で決めます：

- **API（`app_api`）：全ノードで1つのパスワード。** すべての API がすべてのノードに接続する（書き込みは
  どのノードにもなり得るプライマリへ送る）ため、各クラウドのコンテナはいずれにしても全ノードのパスワードを
  持ちます。1つの値にするとシークレットストアの管理が簡単になります。**すべての**クラウドのシークレット
  `db-api-password` に登録します。コンテナは、自クラウドのものから `DB_PASSWORD` とすべての
  `DB_<NODE>_PASSWORD` を読みます。
- **レプリケーション（`app_repl`）：ノードごと**に、そのクラウドのシークレット `db-repl-password` に
  登録します。使うのはスクリプトだけです。

シークレットはインフラのリポジトリが空（ダミーの値）で作ります。値は、そのドキュメントのとおり各クラウドの
VM から CLI で設定します（Azure Key Vault には Azure の VNet からしか接続できません）。

## 3. データベースのセットアップ

次の順に実行します。どのスクリプトも再実行して問題ありません。

```bash
scripts/database-create.sh     # 全ノードにデータベース（DB_NAME）を作成
scripts/migrate.sh             # 全ノードにテーブルを作成
scripts/api-role-setup.sh      # app_api を作成し、スキーマ "app" へのアクセスを付与
scripts/replication-setup.sh   # 全ノードの組み合わせでパブリケーションとサブスクリプションを作成
scripts/switchover.sh <node>   # 最初のプライマリ（例：利用者が最も多い地域に近いクラウド）
scripts/replication-status.sh  # 確認
```

`database-create.sh` は各ノードのデータベースの照合順序を表示し、異なると失敗します。読み取りは各クラウドの
データベースから行うため、同じ行がどこでも同じ順に並ぶ必要があるからです。データベースは PostgreSQL の
組み込みロケール `C.UTF-8` で作ります（`replication/nodes.env` の `DB_CREATE_OPTIONS` で変更できます）。
このデータベースはインフラでは作りません。

### クラウド単体：`scripts/node-setup.sh`

クラウド単体は1ノードのクラスタです。そのクラウドの VM で、1つのコマンドが上のスクリプトをそのノードについて
実行します（`replication-setup.sh` は不要）。`replication/nodes.env` も不要です：

```bash
git clone https://github.com/Otazoman/multipleclouds-api-app.git   # clone 済みなら git pull
cd multipleclouds-api-app
git switch <リリースするブランチ>        # 例：dev
scripts/node-setup.sh aws               # Google・Azure の VM では google / azure
```

見つからない値だけを聞きます：

| 質問 | 答え方 |
| --- | --- |
| `Database address [...]` | 見つかった値のままなら Enter。なければデータベースの接続先 |
| `Database admin user [...]` | 同上。なければインフラの管理者ユーザー（`.env.<環境名>`） |
| `Database admin password` | 管理者のパスワード（表示されない） |
| `API password` | 読み取れなかったときだけ聞かれる：シークレット `db-api-password` の値（表示されない） |
| `Set up ... ? [y/N]` | 設定を確認して `y` |

先に VM でそのクラウドの CLI にサインインしておくと（インフラの operations の「シークレット」）、接続先、管理者ユーザー
（AWS、Azure）、API のパスワードをクラウドから読み取ります。最後に `Done: <cloud> runs alone ...` と表示されます。
再実行して問題ありません（新しいリリースのマイグレーションの適用など）。

処理の内容：

| 段階 | 内容 |
| --- | --- |
| 読み取り | AWS：Aurora のクラスタのエンドポイントとマスターユーザー、シークレット `multicloud-aws-secret-db-api-password`。Google Cloud：唯一の PostgreSQL の Cloud SQL インスタンスのプライベート IP、シークレット `multicloud-google-secret-db-api-password`。Azure：`rg_multicloud` の唯一の PostgreSQL フレキシブル サーバーの FQDN と管理者ログイン、`multicloud-kv-001` のシークレット `db-api-password`。読み取れない値は入力を求める。シークレットがダミーの値のままなら止まる |
| 設定 | パスワードを含まない一時的なノード設定（`NODES=<cloud>`、`appdb`、`app_api`、SSL は `require`）を作り、最後に削除する。パスワードはそのプロセスの環境変数にだけ置く |
| スクリプト | そのノードについて `database-create.sh`、`migrate.sh`、`api-role-setup.sh`、`switchover.sh <cloud>`、`replication-status.sh` |

名前の既定値はインフラの dev 環境のものです。異なる場合は環境変数で指定します：`AWS_REGION`、`AWS_DB_CLUSTER`、
`AWS_API_SECRET`、`GOOGLE_SQL_INSTANCE`、`GOOGLE_API_SECRET`、`AZURE_RESOURCE_GROUP`、`AZURE_DB_SERVER`、
`AZURE_KEY_VAULT`、`AZURE_API_SECRET`（例：`AZURE_KEY_VAULT=multicloud-kv-001-stg scripts/node-setup.sh azure`）。

### 状態の確認

状態確認の出力で、すべてのノードのプライマリと世代番号が同じ、すべてのサブスクリプションが有効、
すべてのスロットが active、エラー件数が `0` であることを確認します。サブスクリプションが接続できない場合は、VPN、ポート 5432 の
ファイアウォール / セキュリティグループ / NSG のルール、`REPL_HOST` の設定を確認してください。

## 4. API コンテナの設定

各クラウドのコンテナには次の環境変数が必要です。インフラのリポジトリが、CI/CD のデプロイ先のサービスに、
データベースが有効なクラウドの分を設定します（そのリポジトリの `config/apicontainer.ts`。
[.env.sample](../.env.sample) も参照）：

| 変数 | 値 |
| --- | --- |
| `CLOUD_ID` | `aws`、`google`、`azure` のいずれか。`NODES` のノード名と一致させる |
| `DB_HOST`, `DB_PORT`, `DB_NAME` | そのクラウドのデータベース |
| `DB_USER`, `DB_PASSWORD` | `app_api` とそのパスワード（シークレットストアから） |
| `DB_SSLMODE` | `require`。または `verify-full` と `DB_SSL_CA_FILE` |
| `GRAPHIQL_ENABLED` | `false` |
| `PEER_NODES` | 他のノード。AWS なら `google,azure` |
| `DB_<NODE>_HOST`, `DB_<NODE>_PASSWORD` | `PEER_NODES` の各ノードについて、このクラウドから接続できるデータベースのアドレス（プライベート DNS 名）と、`app_api` のパスワード（`DB_PASSWORD` と同じシークレット） |
| `WRITE_ACK_PEERS` | `1`（既定） |

その他の `DB_<NODE>_*` は、省略するとこのクラウドの値と同じになります。異なるノードだけ
設定してください（例：`DB_<NODE>_SSLMODE`）。

インフラのリポジトリの次の2つの設定は、初回のデプロイの順番に関係します：

- `azureSecretReady`：Azure の Container App は、参照する Key Vault のシークレットがないと起動できません。
  `false` でインフラを deploy し、Azure の VM からシークレットを設定してから、`true` で deploy します。
- `readinessProbe`：仮のイメージは `/` にしか応答しません。API をデプロイした後（手順 5）に `true` にして
  インフラを deploy すると、ロードバランサーとコンテナ基盤が `/readyz`（マイグレーションを含む readiness）と
  `/healthz`（liveness）を使います。

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
