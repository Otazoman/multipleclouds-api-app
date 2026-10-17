# FEATURE-PLAN: multicloud_api_apps の残課題

- 作成日: 2026-10-12（最終更新 2026-10-17）
- ステータス: アプリの実装（フェーズ 0a〜2、リリースの安全対策、接続数の対策）は `feature/primary-writes-and-models` に push 済みで、どの環境のブランチにも未マージ。ブランチ運用への移行は完了。クラウドは全環境とも未構築（dev は destroy 済み）。**再開時は §8 から**。
- 関連: インフラ側の設計は `cdktn_multicloud_backend/app/docs/ai/feat01_active_active_design.md`（FEAT-01）と `feat04_environments_design.md`（FEAT-04）。本ファイルはアプリ側の計画で、FEAT-01 の §7（シークレット）・§9 #5（API コンテナの設定）・§12（CI/CD 連携）と対応する。
- 運用手順（人が使うもの）は `docs/operations.md`（英・日）。リリースの手順は同ファイルの「Releases / リリース」。

## 1. 実装済みの内容（要約）

| フェーズ | 内容 | 主なファイル |
|---|---|---|
| 0a | 書き込みをプライマリ1か所に集約。読み取りは自クラウド。コミット後に他ノード1つ以上のディスク確定を待つ準同期。`switchover.sh`（初回・計画的・強制） | `src/cluster.ts`、`migrations/0002_cluster_state.sql`、`scripts/switchover.sh` |
| 0b | 変更履歴 `app.write_journal`、冪等キー、`journal-diff.sh`、`journal-prune.sh`。パブリケーションは TRUNCATE を複製しない。レプリケーション用パスワード変更時にサブスクリプションの接続文字列も更新 | `migrations/0003_write_journal.sql`、`scripts/journal-*.sh`、`scripts/replication-setup.sh` |
| 1 | YAML のモデル定義（`models/*.yaml`）から GraphQL API を起動時に生成。`npm run generate` でマイグレーションとスキーマの出力を生成 | `src/models/`、`src/data/`、`src/schema.ts`、`src/generate.ts` |
| 2 | リレーション（belongsTo / hasMany、まとめて読み込み）、条件指定の更新・削除、読み取り専用の名前付き SQL クエリ | 同上、`src/data/loaders.ts`、`src/data/queries.ts` |
| API-16 | リリースの安全対策: ビルドで `npm test`（失敗でデプロイしない）、CI がコミットを `APP_VERSION` として渡し `/`・`/healthz`・`/readyz` が返す、`/readyz` はイメージのマイグレーションがすべて適用済みのときだけ 200 | `Dockerfile`、`buildspec.yml`・`cloudbuild.yaml`・`azure-pipelines.yml`、`src/migrations.ts`、`migrations/0004_migration_status.sql`（`ops.missing_migrations`、EXECUTE は `api-role-setup.sh`） |
| API-06 | 接続数: 自クラウド用プール `DB_POOL_MAX` の既定 10 → 4、他ノード用 `DB_PEER_POOL_MAX`（既定 3）を追加 | `src/config.ts` |

設計の詳細は `docs/architecture.md`、`docs/models.md`、`docs/operations.md`。テストは 103 件。

## 2. 決定事項（ユーザー確認済み）

| 項目 | 決定 |
|---|---|
| 書き込みの方式 | プライマリ集約（C 案）。障害時は数分以内の切り替えを許容 |
| 書き込みの経路 | 各 API がプライマリの DB に VPN 経由で直接接続する（内部 LB は使わない） |
| 孤立したプライマリ対策 | 同期レプリケーションはマネージド DB で設定できないため、アプリ側の準同期で代替 |
| API 用の環境変数 | 全ノードの接続先・ID・パスワードを各 API に持たせてよい |
| キュー（SQS 等） | トランザクションデータには使わない。後続処理（通知など）に限る |
| ブランチと環境 | `dev` → dev 環境、`staging` → stg 環境、`prod` → prod 環境。`main` は prod にリリースしたコードの記録で、デプロイは起動しない（2026-10-12） |
| 昇格の方法 | すべて PR。`staging`・`prod`・`main` はマージコミットのみ（2026-10-17。当初は fast-forward のみだったが、GitHub の PR は fast-forward でマージできないため、全ブランチ PR 必須を優先した）。環境には同じ内容が入るが、コミット ID と `/healthz` の版は環境ごとに異なる |
| リポジトリの公開 | アプリのリポジトリは公開（2026-10-17。無料プランの非公開リポジトリではブランチ保護が使えないため）。公開前に全履歴の作成者のメールを GitHub の noreply に書き換えた。cdktn のリポジトリは非公開のまま |
| シークレット（API-08） | 案 A'（2026-10-17）: 3 ノードで同じ `app_api` パスワードを使う。値は作業用 VM から CLI で各クラウドのシークレットストアに入れる。cdktn は入れ物とダミー値だけ（FEAT-01 §7 のまま）。Azure Key Vault は非公開のまま（§5） |
| 接続数（API-06） | アプリ側の対策（プールの縮小と他ノード用プールの分離）。マネージドの接続プーリングは使わない（2026-10-17、§6.2） |
| 最初のリリース | 現在の feature ブランチは、クラウド側の準備（API-01〜04）の後に PR で `dev` へマージする |

## 3. 課題の一覧

優先度: P1 = 最初のリリース（dev）の前に必要、P2 = 本番運用の前に必要、P3 = 改善。作業の順番は §8.2。

| ID | 優先度 | 内容 | 状態 |
|---|---|---|---|
| API-01 | P1 | クラウドでの初回 DB セットアップ（`migrate.sh` → `api-role-setup.sh` → `replication-setup.sh` → `switchover.sh <最初のプライマリ>`）。実行場所は §4 | 未着手（dev 環境の構築待ち） |
| API-02 | P1 | cdktn: 各 API コンテナの環境変数とシークレット参照（§5.2） | **実装済み（2026-10-17、未コミット・未 deploy）**: cdktn の `config/apicontainer.ts` ほか（FEAT-01 §9 #5）。アプリの `buildspec.yml` は `TASK_FAMILY` の最新リビジョンを元にする。deploy 時に確認すること: Container Apps がプライベートエンドポイントだけの Key Vault のシークレットを読めるか、Cloud Run の startup probe の時間 |
| API-03 | P1 | クラウドでの確認: 各コンテナ（ECS / Cloud Run / Container Apps）から他クラウドの DB（5432）へ接続できるか。設定上は可能（AWS の SG、Google の Cloud Router の広告と PSA のルート交換、Azure の NSG の `VirtualNetwork` タグ）だが、実際の経路は未確認 | 未着手 |
| API-04 | P1 | マネージド DB での権限確認: 管理者ユーザーで `pg_replication_origin_status` を読めるか（強制切り替えで使用。読めなければ `--allow-behind` が必要）、`pg_terminate_backend` を実行できるか（ノード削除の手順）、`subconninfo` を読めるか（読めなければ `replication-setup.sh` が毎回接続文字列を更新し、サブスクリプションが一瞬再起動する） | 未着手 |
| API-05 | P2 | クラウド間の往復時間（RTT）と書き込み時間の実測。PoC では往復 40ms で約 85ms（別クラウドの API から）。`WRITE_ACK_TIMEOUT_MS` の調整。API-06 の想定（書き込み毎秒 700〜800 件が上限の目安）の確認 | 未着手 |
| API-06 | P2 | DB の接続数（最大約 220 で `max_connections = 100` を超え得た） | **完了**（§6） |
| API-07 | P2 | `journal-prune.sh` の定期実行の方法（§4.3） | **決定（2026-10-17）: C. マネージドのジョブ**（ECS Scheduled Task / Cloud Run Jobs + Cloud Scheduler / Container Apps Jobs）。設計は未着手（§4.3 の課題: ジョブのイメージの更新を CI/CD に追加、`psql` のないイメージでの実行方法） |
| API-08 | P2 | シークレットの管理方式 | **決定**（A'、§5）。実装は API-02 |
| API-09 | P2 | 運用手順のクラウドでのリハーサル: 計画的な切り替え、強制切り替え（Azure 障害時に AWS / Google の VM から実行する手順を含む: §4.2）、旧プライマリの初期化と復帰、レプリケーション用パスワードの変更、`docs/operations.md` のリリース手順 | 未着手 |
| API-10 | P3 | フェーズ 3: MySQL 対応。まず3クラウドのマネージド MySQL で、レプリケーションの複製元を付け替えられるか（どのクラウドもプライマリになれるか）を PoC で確認。成り立つ場合のみ、DB 依存部分（確認待ち・切り替え・SQL の方言・DDL 生成）をアダプターに分離して実装 | 未着手 |
| API-11 | P3 | 強制切り替えで受信量が少なかったノードの修復を、初期化（再シード）ではなく変更履歴から行えるようにする（現状は `journal-diff.sh` で一覧にするだけ） | 未着手 |
| API-12 | P3 | 名前付きクエリの SQL を起動時または `npm run generate` 時に検証する（現状は実行するまで分からない） | 未着手 |
| API-13 | P3 | `compose.yaml` 冒頭のコメントがローカル環境の説明として `docs/getting-started.md` を指している（実際は README） | 未着手 |
| API-14 | — | ローカルの `main` を `origin/main` に戻す | **完了**（2026-10-17） |
| API-15 | — | ブランチ運用への移行（`dev`・`staging`・`prod` の作成、cdktn の `cicdTrigger.branches`、ブランチ保護、既定のブランチ、ドキュメント） | **完了**（2026-10-17。cdktn のトリガーは次の構築時に反映: §7） |
| API-16 | — | リリースを安全にする改善（ビルド時のテスト、版の確認、DB の更新漏れでトラフィックを切り替えない readiness） | **完了**（2026-10-17、§1） |
| API-18 | P1 | アプリ用のデータベース `appdb` がクラウドで作られない。cdktn は Google に `postgres_db` を作り、AWS・Azure には作らない。アプリのスクリプトと API は全ノードで同じ `DB_NAME` を使う前提 | 未決定（cdktn で3クラウドに作るか、API-01 の手順で `CREATE DATABASE` するか） |
| API-17 | P1 | `docs/getting-started.md`（英・日）のシークレットの手順を A' に合わせる | **完了（2026-10-17、未コミット）**。`docs/operations.md` のパスワードの変更手順も更新 |

## 4. スクリプトの実行場所（API-01、API-07）

### 4.1 方針

cdktn でインフラを作成した後、**作業用 VM 上でスクリプトを実行する**。これは FEAT-01 §2・§7 の決定（作業用 VM からのシェルスクリプト、全クラウドのパスワードが必要なため Key Vault を読める Azure の VM で3クラウドにログインして実行）と一致する。

- VM は cdktn が3クラウドに作成する（`config/aws/ec2.ts`、`config/google/gce.ts`、`config/azure/vm.ts`）。
- `scripts/vm_init.sh`（cdktn）が PostgreSQL の公式リポジトリから `postgresql-client` を入れるため、スクリプトが必要とする `psql` 15 以上を満たす。
- VM にはこのリポジトリを clone し、`replication/nodes.env` を作る（git 管理外）。パスワードはファイルに書かず、実行直前にシークレットストアから読み出して export する。
- DB 同士・VM から各 DB への通信は、cdktn の SG・NSG で VPC/VNet の範囲から許可されている。

### 4.2 注意点

1. **Azure の障害時の強制切り替え**: Azure の VM でしか実行できないと、Azure 障害中に `switchover.sh --force` を実行できない。`switchover.sh` が必要とするのは接続できるノードの**管理者パスワードだけ**なので、AWS または Google の VM から、生き残ったノードの管理者パスワードだけを使って実行できるよう、手順を用意しておく（API-09）。
2. **作業者のログイン**: FEAT-01 §7 では VM に権限を付けず、作業者が自分のアカウントでログインする。手動実行の手順（API-01、切り替え、リリースの DB 更新）はこれで問題ない。
3. **定期実行（API-07）**: `journal-prune.sh` を VM の cron で動かすには、VM に資格情報を常駐させる必要があり、FEAT-01 §7 の「VM に権限を付けない」と矛盾する。

### 4.3 `journal-prune.sh` の定期実行（API-07、未決定）

必要な理由: `app.write_journal` は書き込みのたびに1行増え、引数と結果（レコードの内容）を JSON で保存する。削除しないと (1) 削除したレコードの内容がジャーナルに残り続ける（個人データを扱う場合に問題）、(2) 本体より速く容量が増える、(3) ノードの再シード（テーブルの全コピー）が遅くなる。削除して失うのは、保持期間（既定 30 日）より古い冪等キーと差分調査の材料だけ。

| 案 | 内容 | 新しい資格情報 | インフラの追加 | 備考 |
|---|---|---|---|---|
| A. 手動 | 作業者が月1回などログインして実行 | なし | なし | 当面はこれ |
| B. VM の cron | 1台の VM に資格情報を置く | 必要 | なし | FEAT-01 §7 と矛盾。その VM のクラウドの障害中は止まる |
| C. コンテナのスケジュール実行 | ECS Scheduled Task / Cloud Run Jobs + Cloud Scheduler / Container Apps Jobs | なし（`app_api` で実行できる: `app` の DELETE と `ops.assert_primary` の権限を持つ） | 3クラウドにジョブとスケジューラ | 今のイメージに `psql` がないため、Node.js で書き直すか別イメージが必要 |
| D. API に組み込む | プライマリの API が定期的に少量ずつ削除 | なし | なし | 複数インスタンスで動いても結果は同じ。AGENTS.md の書き込みのルール（`PrimaryWriter` と `WriteMeta`）との整合に設計が要る |

推奨（提案のみ）: 当面 A、本番前に D か C。

## 5. シークレット（API-08、決定: 案 A'）

### 5.1 決定内容（2026-10-17）

- `app_api` のパスワードは **3 ノード共通の1つの値**。各 API は全ノードのパスワードを持つため（書き込みはプライマリへ送り、プライマリはどのクラウドにもなり得る）、ノードごとに分けても漏洩時の影響は変わらない。共通にすると、各クラウドのストアに置く値が 9 か所から 3 か所になる。
- cdktn は入れ物とダミー値だけを作り（AWS・Google は `CHANGE_ME`、Azure Key Vault は入れ物も作らない）、本当の値は作業用 VM から CLI で入れる（FEAT-01 §7 のまま）。値は Terraform の state に残らない。
- Azure Key Vault はパブリックアクセスなしのまま（VNet の外の cdktn からは書き込めないため、VM から入れる）。
- `app_repl`（レプリケーション）は API が使わないので、従来どおり各クラウドのストアに置き、`replication-setup.sh` で使う。管理者パスワードは cdktn の `config/.env` と state（SEC-04、許容済み）。

検討した他の案（不採用）: B（cdktn が `random_password` で生成して配布。Azure Key Vault に書き込めない）、C（B と VM の併用。手順が2系統）、D（IAM / Entra ID 認証。他クラウドの ID 連携が重く、レプリケーション用のユーザーには使えない）。Container Apps の secret に値を直接入れる案（Key Vault を使わない）も検討したが、Azure の制限は変えない方針とした。

### 5.2 API-02 で設定するもの（cdktn）

各クラウドの API コンテナ:

| 環境変数 | 値 |
|---|---|
| `CLOUD_ID` | `aws` / `google` / `azure` |
| `DB_HOST`、`DB_NAME`、`DB_USER`（`app_api`）、`DB_SSLMODE` | 自クラウドの DB |
| `DB_PASSWORD` | 自クラウドのストアの `db-api-password`（シークレット参照） |
| `PEER_NODES` | 他の2ノード（例: AWS では `google,azure`） |
| `DB_<NODE>_HOST` | 他ノードの DB の、このクラウドから到達できるアドレス（プライベート） |
| `DB_<NODE>_PASSWORD` | **自クラウドのストアの同じ `db-api-password`**（A' により共通）。新しいシークレットの入れ物は不要 |

あわせて、ヘルスチェックに `/readyz` を使うか（ECS のターゲットグループ、Cloud Run の startup / readiness probe、Container Apps の readiness probe）を決める。`/readyz` を使えば、DB の更新漏れでトラフィックを切り替えない対策（API-16）がクラウド側でも効く。FEAT-01 §7・§9 #5 も更新する。

## 6. 接続数（API-06、完了）

### 6.1 実装内容

| 設定 | 既定 | 用途 |
|---|---|---|
| `DB_POOL_MAX` | 4（以前は 10） | 自クラウドの DB（読み取りと、プライマリのときの書き込み） |
| `DB_PEER_POOL_MAX` | 3（新規） | 他ノードごと（書き込みだけ） |

プライマリへの接続は最大約 76（例: プライマリが AWS の場合、ECS 10 台 × 4 ＋ Container Apps 10 台 × 3 ＋ Cloud Run 2 台 × 3）で、`max_connections = 100` に収まる。

### 6.2 スパイク時の動き（見積もり）

- 書き込み1件は他クラウドの確認待ちを含めて約 85ms（PoC）→ 接続1本あたり毎秒約 12 件、全体の上限の目安は毎秒 700〜800 件。
- 上限を超えた書き込みはアプリ内のプールで順番待ちし、5 秒（`connectionTimeoutMillis`）で `PRIMARY_UNAVAILABLE` になる（冪等キーで安全に再試行できる）。DB が接続を拒否する状態にはならない。
- マネージドの接続プーリング（RDS Proxy 等）は、書き込みが確認待ちの間も接続を占有するため効果が小さく、採用しない。毎秒数百件を超える需要が見込まれる場合は、プライマリの DB のサイズや書き込みの往復の削減を検討する。
- ローカルの compose で、プライマリ以外のノードから 20 件同時の書き込みがすべて成功し、プライマリへの接続が 3 に収まることを確認済み。クラウドでの実測は API-05。

## 7. ブランチ運用（API-15、完了）

運用の手順は `docs/operations.md` の「Releases」（日本語版は「リリース」）。ここには決定の経緯と設定だけを記録する。

| 対象 | 設定 |
|---|---|
| ブランチ | `dev`・`staging`・`prod` を作成（起点は当時の `origin/main`）。既定のブランチは `dev` |
| ルールセット | 「dev: pull requests only」: `dev` は PR 必須（承認 0 件）、強制 push と削除を禁止。「staging/prod/main: pull requests only」: 同じルールに加えて、マージ方法はマージコミットのみ |
| cdktn のトリガー | `config/cicd.ts` の `cicdTrigger.branches` = dev `dev`、stg `staging`、prod `prod`（cdktn `0680628`）。dev 環境は destroy 済みのため、次の構築時に反映される |
| メール | 公開前に全履歴の作成者とコミッターを `3047545+Otazoman@users.noreply.github.com` に書き換え（内容は同一）。このリポジトリの git の `user.email` も noreply。他の clone は取り直しが必要 |

流れ: `feature/*` --PR--> `dev` --PR--> `staging` --PR--> `prod` --PR--> `main`。各環境では、ブランチを進める前にその環境の DB を更新する（`migrate.sh`、必要なら `replication-setup.sh`・`api-role-setup.sh`）。戻すときは環境のブランチで revert（DB の変更は戻さない）。hotfix は `prod` から作り、`prod` → `staging` → `dev` に戻す。

GitHub 上の確認（CI のチェック）はない。テストは各クラウドのビルドで実行され、失敗するとデプロイされない。PR の前のテストとローカルでの確認は手順で求める。

## 8. 再開時にやること（2026-10-17 時点）

### 8.1 現在の状態

| 対象 | 状態 |
|---|---|
| アプリのリポジトリ | **公開**。`feature/primary-writes-and-models`（`f54c6e3`）に全実装を push 済み。2026-10-17 の追加（このファイル、operations のリリース手順、README、`buildspec.yml`、getting-started・operations のシークレット）は未コミット。`dev`・`staging`・`prod`・`main` は最初のコミット群のまま（`cfe7426`、リリース済みのコードだけ）。ローカルの `main` は `origin/main` と一致 |
| cdktn のリポジトリ | 非公開。`main`（`6508539`）。**未コミット**: API-02 の実装、ログのテストの修正（バケット名を設定から求める）、古いスナップショットのテスト `app-test.ts` の削除（README の注記も）。jest は 190 件すべて成功 |
| クラウド | **全環境とも未構築**（dev は 2026-10-12 に destroy、state のリソース数 0）。次の dev の deploy では VM・DB・コンテナ・CI/CD が作られる（課金あり） |
| ローカルの compose 環境 | 3 ノードで起動中（プライマリは aws、検証用のデータあり）。不要なら `docker compose down -v` |
| その他 | ローカルに検証用のイメージ `nicolaka/netshoot:v0.13` が残っている（不要なら削除してよい） |

### 8.2 残作業（順番）

| # | 作業 | 場所 | 承認・判断 | 関連 |
|---|---|---|---|---|
| 1 | ~~API コンテナの環境変数とシークレット参照~~ 実装済み（未コミット） | cdktn | — | API-02 |
| 2 | ~~getting-started のシークレットの手順~~ 完了（未コミット） | アプリ | — | API-17 |
| 3 | ~~cdktn の失敗しているテスト~~ 修正済み（未コミット） | cdktn | — | — |
| 3a | アプリ用のデータベース `appdb` の作り方を決めて実装 | cdktn または VM | ユーザーの判断 | API-18 |
| 4 | dev 環境を構築（`cdktn diff` → `cdktn deploy`。`azureSecretReady`・`readinessProbe` は `false`）。Azure の DevOpsInfrastructure のオブジェクト ID（`.env.dev`）が設定済みか確認 | cdktn | 課金を伴うインフラ変更の承認 | FEAT-04 §7 |
| 5 | 作業用 VM からシークレットの値を入れる（`app_api` は 3 ストアに同じ値、`app_repl`）。その後 `azureSecretReady: true` で cdktn を deploy | VM・cdktn | — | API-08 |
| 6 | コンテナから他クラウドの DB への接続と、マネージド DB の権限を確認 | VM・クラウド | クラウドの DB への実行の承認 | API-03、API-04 |
| 7 | DB の初回セットアップ（`migrate.sh` → `api-role-setup.sh` → `replication-setup.sh` → `switchover.sh <最初のプライマリ>`） | VM | クラウドの DB への実行の承認 | API-01 |
| 8 | 最初のリリース（その後 `readinessProbe: true` で cdktn を deploy）: feature ブランチを PR で `dev` にマージし、3クラウドで `/healthz`（同じ版）・`/readyz`・ログ（`Primary: <node> (epoch N)`）・プライマリ以外からの書き込みを確認（`docs/operations.md` のリリース手順の初回の実施） | GitHub・クラウド | マージの承認 | §2 |
| 9 | RTT と書き込み時間、同時書き込みの実測。`WRITE_ACK_TIMEOUT_MS` と接続数の想定を確認 | dev | — | API-05、API-06 |
| 10 | 運用手順のリハーサル（切り替え、強制切り替え、旧プライマリの復帰、パスワード変更、Azure 障害時の手順） | dev | クラウドの DB への実行の承認 | API-09 |
| 11 | `journal-prune.sh` の定期実行をマネージドのジョブ（C）で設計・実装 | アプリ・cdktn | 設計の承認 | API-07 |
| 12 | stg・prod の環境を用意（FEAT-04 §6 #5 の値、各アカウントの CI/CD の接続）し、リリース手順で昇格（`dev` → `staging` → `prod` → `main`） | cdktn・GitHub | 環境ごとの承認 | FEAT-04 |
| 13 | P3 の課題 | アプリ | 実施の判断 | API-10〜13 |

### 8.3 ユーザーの回答待ち

| # | 内容 | 関連 |
|---|---|---|
| 1 | 未コミットの変更のコミット（アプリ: feature ブランチ、cdktn: `main`） | — |
| 2 | アプリ用のデータベース `appdb` の作り方 | API-18 |
| 3 | API-07（マネージドのジョブ）の設計に着手してよいか | API-07 |
