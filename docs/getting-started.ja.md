# はじめに

[English](getting-started.md)

クラウドへの初回デプロイの手順です。開発環境とローカルテストは [README](../README.ja.md) を参照してください。

## 全体の流れ

| # | 作業 | 場所 | 詳細 |
| --- | --- | --- | --- |
| 1 | 構築の段階 1 でインフラを構築（`npm run build-stage` で確認） | インフラのリポジトリ：`cdktn diff`、`cdktn deploy` | インフラの getting-started と operations（「deploy」「destroy の後にもう一度 deploy する」） |
| 2 | すべてのクラウドにパスワードを入れる（同じ値）：`scripts/secrets-set.sh <cloud>` | 各クラウドの Cloud Shell か VM。Azure は VM から（Key Vault は VNet の中） | 下の 2 章 |
| 3 | `npm run build-stage -- 2` の後、`cdktn deploy`（Azure の Container App が Key Vault のシークレットを参照する） | インフラのリポジトリ | インフラの operations の「環境を構築する」 |
| 4 | データベースのセットアップ | クラウド単体：各クラウドの VM。クラスタ：どれか1台の VM（データベースはプライベート） | 下の 2〜3 章 |
| 5 | API のデプロイ：環境のブランチにマージ。インフラを構築した直後（マージするものがない）は、各クラウドのパイプラインを 1 回実行 | GitHub（プルリクエスト）、または各クラウドのコンソール / CLI。各クラウドの CI/CD がビルドしてデプロイ | 5 章、[operations.ja.md](operations.ja.md#リリース) |
| 6 | 確認 | 自分の端末 | 6 章 |
| 7 | `npm run build-stage -- 3` の後、`cdktn deploy`（`/readyz` のヘルスチェック、変更履歴の削除ジョブ） | インフラのリポジトリ | インフラの operations の「環境を構築する」（手順 8） |

1〜3 がインフラの構築で、4 からがこのリポジトリの作業です。
`cdktn deploy` は 1・3・7 の 3 回実行します（理由はインフラの operations の「環境を構築する」）。その後のリリースはマージだけです。

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

## 2. パスワードとノード設定

### パスワード

パスワードを 2 つ決めて控えます（パスワードマネージャーなど）：

- **API（`app_api`）：全ノードで1つのパスワード。** すべての API がすべてのノードに接続する（書き込みは
  どのノードにもなり得るプライマリへ送る）ため、各クラウドのコンテナはいずれにしても全ノードのパスワードを
  持ちます。1つの値にするとシークレットストアの管理が簡単になります。コンテナは、自クラウドのシークレット
  `db-api-password` から `DB_PASSWORD` とすべての `DB_<NODE>_PASSWORD` を読みます。
- **レプリケーション（`app_repl`）：これも全ノードで1つのパスワード**（クラスタのときだけ）。使うのは
  スクリプトだけです。1つの値にすると、どれか1台の VM で、そのクラウドのシークレットストアだけから
  すべてのパスワードを読んでスクリプトを実行できます。

```bash
openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32; echo   # 2 回実行：API 用、レプリケーション用
```

**すべての**クラウドのシークレットストアに、クラウドごとに1つのコマンドで入れます。そのクラウドの CLI に
サインインしておきます（インフラの operations の「シークレット」）。AWS と Google Cloud は Cloud Shell か VM、
Azure は VM から（Key Vault には Azure の VNet からしか接続できません）：

```bash
git clone https://github.com/Otazoman/multipleclouds-api-app.git   # clone 済みなら git pull
cd multipleclouds-api-app
scripts/secrets-set.sh aws        # 他のクラウドでは google / azure
```

| 質問 | 答え方 |
| --- | --- |
| `API password` | API のパスワード（貼り付け。表示されない） |
| `Replication password` | レプリケーションのパスワード。Enter で変更しない（クラウド単体では使わない） |

サインインを確認し、そのクラウドの `db-api-password` と `db-repl-password` を設定し、読み戻して確認して、
最後に `Done` と表示します。値は画面にも、シェルの履歴にも、プロセスの一覧にも出ません。再実行して問題ありません
（パスワードを変えるときなど。そのときはロールの設定も再実行します：[operations.ja.md](operations.ja.md#パスワード)）。
シークレットの名前の既定値はインフラの dev 環境のものです。異なる場合は環境変数で指定します（`AWS_API_SECRET`、
`AWS_REPL_SECRET`、`GOOGLE_API_SECRET`、`GOOGLE_REPL_SECRET`、`AZURE_KEY_VAULT`、`AZURE_API_SECRET`、
`AZURE_REPL_SECRET`、`AWS_REGION`）。

### ノード設定（手作業のとき）

**クラウド単体**は各クラウドの VM で `scripts/node-setup.sh <cloud>`、**クラスタ**はどれか1台の VM で
`scripts/cluster-setup.sh` を実行します（3 章）。どちらもノード設定のファイルは不要です。

3 章のスクリプトを手作業で実行する場合（名前が異なる、別のインフラなど）は、ノード設定を作り、パスワードは
シェルで export します（ファイルには書きません。ファイルは git の管理対象外です）：

```bash
cp replication/nodes.env.sample replication/nodes.env
export NODE_<N>_ADMIN_PASSWORD=... NODE_<N>_API_PASSWORD=... NODE_<N>_REPL_PASSWORD=...   # ノードごと
```

| 設定 | 値 |
| --- | --- |
| `NODE_<N>_HOST` | このホストから接続できるデータベースのアドレス |
| `NODE_<N>_REPL_HOST` | 他のデータベースがこのデータベースに接続するときのアドレス（`HOST` と異なる場合のみ） |
| `NODE_<N>_ADMIN_USER` | インフラで作成したデータベースの管理者ユーザー |
| `NODE_<N>_REPL_USER`, `NODE_<N>_API_USER` | 特に理由がなければ `app_repl` / `app_api` のまま |

## 3. データベースのセットアップ

### クラスタ：`scripts/cluster-setup.sh`

すべてのクラウドにパスワードを入れた後（2 章）、クラスタのどれか**1台**の VM で、そのクラウドの CLI だけに
サインインして実行します：

```bash
git clone https://github.com/Otazoman/multipleclouds-api-app.git   # clone 済みなら git pull
cd multipleclouds-api-app
git switch <リリースするブランチ>        # 例：dev
scripts/cluster-setup.sh aws            # この VM のクラウド：aws / google / azure
```

| 質問 | 答え方 |
| --- | --- |
| `Database admin password of <node> (<user>)` | そのノードの管理者パスワード（インフラの `.env.<環境名>`。表示されない）。Enter で前のノードと同じ値 |
| `Set up the cluster ... ? [y/N]` | 設定を確認して `y` |

処理の内容：

| 段階 | 内容 |
| --- | --- |
| 接続 | すべてのデータベースにプライベート DNS の名前（`aurora-postgres.aws.inner`、`cloudsql-postgres.google.inner`、`postgres-prod.azure.inner`）で接続。管理者ユーザーは `root`、`root`、`azuredbadmin`。データベース同士も同じ名前で接続する（Cloud SQL はインフラのピアリングされた DNS ドメイン経由）。接続できないデータベースがあれば、その名前を表示してすぐ止まる |
| パスワード | API とレプリケーションのパスワードはこのクラウドのシークレットストアから読む。管理者のパスワードは入力。ファイルには書かない |
| スクリプト | `database-create.sh`、`migrate.sh`、`api-role-setup.sh`、`replication-setup.sh`、`switchover.sh <最初のプライマリ>`、`replication-status.sh` |
| プライマリ | 初回はこの VM のクラウド（`--primary <node>` で変更可）。2 回目以降は現在のプライマリのまま。`--primary` で別のノードを指定すると計画的な切り替えになる |

最後に表示される状態で、すべてのノードのプライマリと世代番号が同じ、すべてのサブスクリプションが有効、すべての
スロットが active、エラー件数が `0` であることを確認します。再実行して問題ありません（リリースのマイグレーションなど）。
名前の既定値はインフラの dev 環境のものです。異なる場合は環境変数で指定します（`NODES`、`NODE_<NODE>_HOST`、
`NODE_<NODE>_ADMIN_USER`、`NODE_<NODE>_REPL_HOST`、シークレットの名前は `secrets-set.sh` と同じ）。

**プライベート DNS が無いとき。** インフラがプライベート DNS 無しでクラスタを動かしている場合（費用を抑えるとき。インフラの
operations の「プライベート DNS の無いクラスタ」）は、プライベート DNS の名前を引けません。インフラの deploy が表示した 1 行
（出力 `cluster-setup-hosts`）をコマンドの前に付けると、データベース同士もその接続先で接続します：

```bash
NODE_AWS_HOST=<Aurora のエンドポイント> NODE_GOOGLE_HOST=<Cloud SQL の IP> NODE_AZURE_HOST=<Azure の IP> scripts/cluster-setup.sh aws
```

Azure のデータベースの IP が変わったときは、新しい 1 行を付けて再実行します。

**管理者ユーザーについて。** 既定値はインフラの dev 環境の値です（インフラの `.env.<環境名>` の
`AWSDB_ROOT_USER`、`GOOGLEDB_ROOT_USER`、`AZUREDB_ROOT_USER`：`root`、`root`、`azuredbadmin`。Azure では `root`
を使えません）。別の名前でデータベースを作った場合は、実行するときに指定します（確認の前に表示される設定に含まれます）：

```bash
NODE_AZURE_ADMIN_USER=<管理者ユーザー> scripts/cluster-setup.sh aws
```

指定するのは、データベースを作ったときの名前です。後から `.env.<環境名>` だけを変えても、既存の管理者の名前は
変わりません。名前が違うと `database-create.sh` が `password authentication failed for user "..."` で止まります。
何も変更されないので、正しい名前で再実行してください。

### 手作業

`replication/nodes.env` とパスワードの export（2 章）の後、次の順に実行します。どのスクリプトも再実行して問題ありません。

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

インフラのリポジトリの次の2つの設定は、初回のデプロイの順番に関係します。インフラの構築の段階
（`npm run build-stage -- <段階>`）で有効になります：

- 段階 2、`azureSecretReady`：Azure の Container App は、参照する Key Vault のシークレットがないと起動できません。
  段階 1 でインフラを deploy し、Azure の VM からシークレットを設定してから、段階 2 で deploy します。
- 段階 3、`readinessProbe`（と変更履歴の削除ジョブ）：仮のイメージは `/` にしか応答しません。API をデプロイした後
  （手順 5）に段階 3 でインフラを deploy すると、ロードバランサーとコンテナ基盤が `/readyz`（マイグレーションを含む
  readiness）と `/healthz`（liveness）を使います。

## 5. デプロイ

環境ごとに、それぞれのブランチ（`dev`、`staging`、`prod`）からデプロイします（[operations.ja.md](operations.ja.md#リリース)）。環境のブランチにマージすると、各クラウドがイメージをビルドし（ビルドでテストを実行）、新しいリビジョンを展開します：

- AWS：CodeBuild → ECR → ECS Blue/Green（サービスが安定しなければビルドが失敗する）
- Google Cloud：Cloud Build → Artifact Registry → Cloud Run
- Azure：Azure Pipelines → ACR → Container Apps

インフラを構築した直後（destroy の後も）は、レジストリが空でコンテナは仮のイメージで動いていますが、ブランチには
マージする新しいコミットがありません。代わりに、各クラウドのパイプラインを環境のブランチで 1 回実行します（名前は
インフラの dev の既定値で、インフラの CI/CD の設定で決まります）：

```bash
# AWS（CloudShell）
aws codebuild start-build --project-name api-service-cicd --source-version dev --region ap-northeast-1
# Google Cloud（Cloud Shell）
gcloud builds triggers run github-push-trigger --region=asia-northeast1 --branch=dev
```

Azure：Azure DevOps でパイプライン `multicloud-api-deploy` を開き、**Run pipeline** でブランチ `dev` を指定します。
1 つのクラウドのビルドをやり直すとき（失敗したときなど）も同じです。結果はメールで届きます（Azure DevOps は
パイプラインを実行した人に、AWS と Google Cloud はインフラのアラートの通知先 `ALERT_EMAILS` に）。

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
