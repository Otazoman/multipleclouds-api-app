# FEATURE-PLAN: multicloud_api_apps の残課題

- 作成日: 2026-10-12（最終更新 2026-10-17）
- ステータス（2026-10-17 終了時）: アプリの実装は `feature/primary-writes-and-models` に push 済みで、どの環境のブランチにも未マージ。インフラ（cdktn）の API 用の設定（環境変数・シークレット・削除ジョブ・単体／クラスタの構成）も実装済み。クラウドは全環境とも未構築。**再開時は §8 から**（次の作業は §8.2 の 1: dev 環境の構築）。
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
| リポジトリの公開 | アプリのリポジトリは公開（2026-10-17。無料プランの非公開リポジトリではブランチ保護が使えないため）。公開前に全履歴の作成者のメールを GitHub の noreply に書き換えた。cdktn のリポジトリも公開（以前から）。2026-10-17 に履歴の作成者のメールを noreply に書き換え、流出していた秘密鍵と PFX を履歴から削除し、証明書を再発行した（cdktn の vpn_refactor_plan.md SEC-01） |
| シークレット（API-08） | 案 A'（2026-10-17）: 3 ノードで同じ `app_api` パスワードを使う。値は作業用 VM から CLI で各クラウドのシークレットストアに入れる。cdktn は入れ物とダミー値だけ（FEAT-01 §7 のまま）。Azure Key Vault は非公開のまま（§5） |
| 接続数（API-06） | アプリ側の対策（プールの縮小と他ノード用プールの分離）。マネージドの接続プーリングは使わない（2026-10-17、§6.2） |
| API の構成（topology） | 2026-10-17 決定: cdktn の `apiContainerConfig.topology` で選ぶ。`cluster`（DB のあるクラウドで1つのクラスタ。2クラウド以上なら VPN とプライベート DNS が必須で、無ければ合成エラー）、`independent`（各クラウドが自分の DB だけで単体で動く。VPN・DNS 不要）。dev は当面 `independent` で単体クラウドとして試し、最終的に VPN・DNS を有効にして `cluster` でテストする。単体から後でクラスタにすると、データが残るのは1つのクラウドだけ |
| 最初のリリース | 現在の feature ブランチは、クラウド側の準備（API-01〜04）の後に PR で `dev` へマージする |

## 3. 課題の一覧

優先度: P1 = 最初のリリース（dev）の前に必要、P2 = 本番運用の前に必要、P3 = 改善。作業の順番は §8.2。

| ID | 優先度 | 内容 | 状態 |
|---|---|---|---|
| API-01 | P1 | クラウドでの初回 DB セットアップ（`database-create.sh` → `migrate.sh` → `api-role-setup.sh` → `replication-setup.sh` → `switchover.sh <最初のプライマリ>`）。実行場所は §4 | 未着手（dev 環境の構築待ち） |
| API-02 | P1 | cdktn: 各 API コンテナの環境変数とシークレット参照（§5.2） | **実装済み（2026-10-17、未 deploy）**: cdktn の `config/apicontainer.ts` ほか（FEAT-01 §9 #5）。アプリの `buildspec.yml` は `TASK_FAMILY` の最新リビジョンを元にする。deploy 時に確認すること: Container Apps がプライベートエンドポイントだけの Key Vault のシークレットを読めるか、Cloud Run の startup probe の時間 |
| API-03 | P1 | クラウドでの確認: 各コンテナ（ECS / Cloud Run / Container Apps）から他クラウドの DB（5432）へ接続できるか。設定上は可能（AWS の SG、Google の Cloud Router の広告と PSA のルート交換、Azure の NSG の `VirtualNetwork` タグ）だが、実際の経路は未確認 | 未着手 |
| API-04 | P1 | マネージド DB での権限確認: 管理者ユーザーで `CREATE DATABASE` と組み込みロケール（`LOCALE_PROVIDER builtin`）を使えるか（Aurora・Cloud SQL・Azure。使えなければ `DB_CREATE_OPTIONS` で3クラウド共通の照合順序を指定）、管理者ユーザーで `pg_replication_origin_status` を読めるか（強制切り替えで使用。読めなければ `--allow-behind` が必要）、`pg_terminate_backend` を実行できるか（ノード削除の手順）、`subconninfo` を読めるか（読めなければ `replication-setup.sh` が毎回接続文字列を更新し、サブスクリプションが一瞬再起動する） | 未着手 |
| API-05 | P2 | クラウド間の往復時間（RTT）と書き込み時間の実測。PoC では往復 40ms で約 85ms（別クラウドの API から）。`WRITE_ACK_TIMEOUT_MS` の調整。API-06 の想定（書き込み毎秒 700〜800 件が上限の目安）の確認 | 未着手 |
| API-06 | P2 | DB の接続数（最大約 220 で `max_connections = 100` を超え得た） | **完了**（§6） |
| API-07 | P2 | 変更履歴の削除の定期実行（§4.3） | **実装済み（2026-10-17、未 deploy）: C. マネージドのジョブ**。アプリ: `src/prune.ts`（`node dist/prune.js`、`JOURNAL_RETENTION_DAYS`）、`cloudbuild.yaml`・`azure-pipelines.yml` でジョブのイメージを更新。cdktn: `apiContainerConfig.journalPrune`（既定 `false`。API のデプロイ後に `true`）で EventBridge Scheduler＋ECS、Cloud Scheduler＋Cloud Run ジョブ、Container Apps ジョブ。ローカルで別ノードから実行し、プライマリで削除され全ノードに反映されることを確認 |
| API-08 | P2 | シークレットの管理方式 | **決定**（A'、§5）。実装は API-02 |
| API-09 | P2 | 運用手順のクラウドでのリハーサル: 計画的な切り替え、強制切り替え（Azure 障害時に AWS / Google の VM から実行する手順を含む: §4.2）、旧プライマリの初期化と復帰、レプリケーション用パスワードの変更、`docs/operations.md` のリリース手順 | 未着手 |
| API-10 | P3 | フェーズ 3: MySQL 対応。まず3クラウドのマネージド MySQL で、レプリケーションの複製元を付け替えられるか（どのクラウドもプライマリになれるか）を PoC で確認。成り立つ場合のみ、DB 依存部分（確認待ち・切り替え・SQL の方言・DDL 生成）をアダプターに分離して実装 | 未着手 |
| API-11 | P3 | 強制切り替えで受信量が少なかったノードの修復を、初期化（再シード）ではなく変更履歴から行えるようにする（現状は `journal-diff.sh` で一覧にするだけ） | 未着手 |
| API-12 | P3 | 名前付きクエリの SQL を起動時または `npm run generate` 時に検証する（現状は実行するまで分からない） | 未着手 |
| API-13 | P3 | `compose.yaml` 冒頭のコメントがローカル環境の説明として `docs/getting-started.md` を指している（実際は README） | 未着手 |
| API-14 | — | ローカルの `main` を `origin/main` に戻す | **完了**（2026-10-17） |
| API-15 | — | ブランチ運用への移行（`dev`・`staging`・`prod` の作成、cdktn の `cicdTrigger.branches`、ブランチ保護、既定のブランチ、ドキュメント） | **完了**（2026-10-17。cdktn のトリガーは次の構築時に反映: §7） |
| API-16 | — | リリースを安全にする改善（ビルド時のテスト、版の確認、DB の更新漏れでトラフィックを切り替えない readiness） | **完了**（2026-10-17、§1） |
| API-19 | P1 | 1・2・3クラウドのどの構成でも API が動くようにする（VPN・DNS なしの単体クラウドを含む） | **実装済み（2026-10-17）**: cdktn の `topology`、`DB_HOST` は自クラウドの DB の元の接続先（Aurora のエンドポイント、Cloud SQL のプライベート IP、Azure の FQDN）、`DB_<NODE>_HOST` はプライベート DNS 名。アプリ: `replication-setup.sh` は1ノードなら何もせず正常終了、`nodes.env.sample` の `NODES` は環境変数を優先、getting-started に構成の説明。ローカルで1ノード・2ノードの動作を確認。deploy 時に確認すること: Container Apps から Azure の DB の FQDN を解決できるか |
| API-20 | P2 | 監視と通知: 削除ジョブの失敗、レプリケーションの遅延・停止、スロットの WAL の蓄積を通知する（cdktn の FEAT-03 と合わせて設計。FEAT-01 §8 で「設計中」のまま） | 未着手（本番前までに） |
| API-21 | — | 整理（2026-10-17 完了）: `pg_subscription` の参照を現在のデータベースに限定（`replication-setup.sh`・`replication-status.sh`・`switchover.sh`。ローカルで再実行・計画的な切り替え・強制切り替えを確認）、`architecture.md`（英・日）にクラスタと単体の説明、cdktn の Container Apps の仮の `DB_URL` を削除、使わない RDS のロググループの設定をコメントアウト、FEAT-01 §10・FEAT-04 §7.3 の古い項目を完了・取り消しに | **完了** |
| API-18 | P1 | アプリ用のデータベース `appdb` がクラウドで作られない | **実装済み（2026-10-17）: b 案**。`scripts/database-create.sh`（無ければ作成、全ノードの照合順序を比較し異なれば失敗。既定は組み込みロケール `C.UTF-8`、`DB_CREATE_OPTIONS` で変更可）。compose もスクリプトで作る形に変更。API-01 の最初に実行する |
| API-17 | P1 | `docs/getting-started.md`（英・日）のシークレットの手順を A' に合わせる | **完了（2026-10-17）**。`docs/operations.md` のパスワードの変更手順も更新 |

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
| `DB_HOST` | 自クラウドの DB の元の接続先（Aurora のクラスタのエンドポイント、Cloud SQL のプライベート IP、Azure の FQDN）。プライベート DNS が無くても使える |
| `DB_NAME`、`DB_USER`（`app_api`）、`DB_SSLMODE` | 自クラウドの DB |
| `DB_PASSWORD` | 自クラウドのストアの `db-api-password`（シークレット参照） |
| `PEER_NODES` | 他のノード（例: 3クラウドのクラスタの AWS では `google,azure`。`independent` や1クラウドだけなら空） |
| `DB_<NODE>_HOST` | 他ノードの DB のプライベート DNS 名（VPN 経由。クラスタのみ） |
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
| cdktn のトリガー | `config/cicd.ts` の `cicdTrigger.branches` = dev `dev`、stg `staging`、prod `prod`（cdktn `d328234`）。dev 環境は destroy 済みのため、次の構築時に反映される |
| メール | 公開前に全履歴の作成者とコミッターを `3047545+Otazoman@users.noreply.github.com` に書き換え（内容は同一）。このリポジトリの git の `user.email` も noreply。他の clone は取り直しが必要 |

流れ: `feature/*` --PR--> `dev` --PR--> `staging` --PR--> `prod` --PR--> `main`。各環境では、ブランチを進める前にその環境の DB を更新する（`migrate.sh`、必要なら `replication-setup.sh`・`api-role-setup.sh`）。戻すときは環境のブランチで revert（DB の変更は戻さない）。hotfix は `prod` から作り、`prod` → `staging` → `dev` に戻す。

GitHub 上の確認（CI のチェック）はない。テストは各クラウドのビルドで実行され、失敗するとデプロイされない。PR の前のテストとローカルでの確認は手順で求める。

## 8. 再開時にやること（2026-10-17 終了時）

### 8.1 現在の状態

| 対象 | 状態 |
|---|---|
| アプリのリポジトリ | **公開**。`feature/primary-writes-and-models` の `5fe6027` まで push 済み（MIT ライセンスを含む）。`dev`・`staging`・`prod`・`main` は最初のコミット群のまま（`cfe7426`）。既定のブランチは `dev`。ルールセット: 4 ブランチとも PR 必須、`staging`・`prod`・`main` はマージコミットのみ。未コミットの変更なし |
| cdktn のリポジトリ | **公開**。`main` の `3d2f013` まで push 済み（MIT ライセンスを含む）。**未コミット（2026-10-18）**: サンプル 2 つ（ECS `worker-service`、Cloud Run `web-service-standalone`）を `build: false`、それに合わせたテストの修正、ALB の Blue/Green のルールの `ignore_changes: ["action"]`、手順書（Google の `roles/secretmanager.admin`、VM のサインインの注意点、API のパスワードは全クラウド同じ値）。jest 197 件成功 |
| cdktn の設定 | 3 クラウドとも `dbs`・`containers`・`cicd`・`vms` が有効、`useVpn`・`hostZones` は無効。`apiContainerConfig`: `topology` は dev `independent`（各クラウドが単体）、`azureSecretReady`・`readinessProbe`・`journalPrune.enabled` は `false`。AWS の DB は Aurora（RDS は `build: false`） |
| クラウド | 2026-10-18 に dev を構築（246 リソース）して一部を検証した後、**ユーザーが destroy する**（§8.5）。次回はもう一度構築から |
| ローカル | compose の 3 ノードが起動中（プライマリ aws）。検証用イメージ `nicolaka/netshoot:v0.13` が残っている。退避した古い証明書（流出した鍵）が `/tmp/claude-1000/-mnt-dev-data-multicloud-dev-src/8ef6c963-6b3f-4a26-a463-117173986007/scratchpad/old-certs` にある（§8.4） |

### 8.2 残作業（順番）

| # | 作業 | 場所 | 承認・判断 | 関連 |
|---|---|---|---|---|
| 1 | **dev 環境を構築**: `cdktn diff` で内容を確認 → `cdktn deploy`。設定は §8.1 のまま（単体構成、VPN・DNS なし）。2026-10-18 に一度構築済み（§8.5）。次回の前に、cdktn の未コミットの変更（ALB の修正を含む）をコミットしておく。Google の cdktn のサービスアカウントには `roles/secretmanager.admin` を付与済み | cdktn | 課金を伴うインフラ変更の承認 | FEAT-04 §7 |
| 2 | シークレットの値を入れる（`db-api-password` は 3 クラウドとも同じ値。手順は cdktn の operations.md「Secrets」）。AWS と Google は Cloud Shell からでも入れられる（2026-10-18 に確認）。Azure の Key Vault は VNet からしか接続できないため、Azure の VM（Bastion を有効にして接続）から入れる。その後 `azureSecretReady: true` にして cdktn を deploy | VM・Cloud Shell・cdktn | — | API-08 |
| 3 | マネージド DB の権限を確認（`CREATE DATABASE`、組み込みロケール `C.UTF-8`、`pg_replication_origin_status`、`pg_terminate_backend`、`subconninfo`） | VM | クラウドの DB への実行の承認 | API-04 |
| 4 | DB の初回セットアップを、単体のクラウドごとに `NODES=<cloud>` で実行: `database-create.sh` → `migrate.sh` → `api-role-setup.sh` → `switchover.sh <cloud>`（`replication-setup.sh` は単体では何もしない） | VM | クラウドの DB への実行の承認 | API-01、API-18 |
| 5 | **最初のリリース**: feature ブランチを PR で `dev` にマージ（`docs/operations.md` のリリース手順の初回）。3 クラウドで `/healthz`（同じ版）・`/readyz`・ログ（`Primary: <cloud> (epoch 1)`）・読み書きを確認 | GitHub・クラウド | マージの承認 | §2 |
| 6 | `readinessProbe: true` と `journalPrune.enabled: true` にして cdktn を deploy。3 クラウドで削除ジョブの実行を確認 | cdktn・クラウド | deploy の承認 | API-16、API-07 |
| 7 | 書き込み時間・同時書き込みの実測（単体構成で可能な範囲） | dev | — | API-05、API-06 |
| 8 | **クラスタとしてテスト**: `useVpn`・`hostZones` を有効にし、他クラウドの DB への接続を確認（API-03）、`topology` を `cluster` にして deploy。データを残すクラウドを1つ決め、他のノードはリセットしてから `replication-setup.sh`。往復時間と書き込み時間を実測（API-05） | cdktn・VM | 課金を伴うインフラ変更の承認 | API-19、API-03、API-05 |
| 9 | 運用手順のリハーサル（計画的な切り替え、強制切り替え、旧プライマリの復帰、パスワード変更、Azure 障害時に AWS / Google の VM から切り替える手順） | dev | クラウドの DB への実行の承認 | API-09 |
| 10 | 監視と通知（削除ジョブの失敗、レプリケーションの遅延・停止、スロットの WAL 蓄積）。cdktn の FEAT-03 と合わせて設計 | cdktn・アプリ | 設計の承認 | API-20 |
| 11 | stg・prod の環境を用意（FEAT-04 §6 #5 の値、各アカウントの CI/CD の接続）し、リリース手順で昇格（`dev` → `staging` → `prod` → `main`） | cdktn・GitHub | 環境ごとの承認 | FEAT-04 |
| 12 | P3 の課題（MySQL 対応、変更履歴からの修復、名前付きクエリの検証、`compose.yaml` のコメント） | アプリ | 実施の判断 | API-10〜13 |

### 8.3 deploy のときに確認すること（未検証の前提）

| 対象 | 確認すること | 関連 |
|---|---|---|
| Azure | Container Apps から、プライベートエンドポイントだけの Key Vault のシークレットを読めるか。Container Apps の環境から Azure の DB の FQDN を解決できるか | API-02、API-19 |
| Google | Cloud Run の startup probe の待ち時間（最大 2 分）で足りるか。`roles/run.invoker` で Cloud Run ジョブを実行できるか | API-02、API-07 |
| AWS | EventBridge Scheduler が、リビジョンなしのタスク定義 ARN で最新のリビジョンを実行するか | API-07 |
| 3 クラウド | 新しい証明書（Google のロードバランサー、Azure の Application Gateway の PFX）が受け付けられるか | — |

### 8.4 ユーザーの作業（任意・後片付け）

| 内容 | コマンド・場所 |
|---|---|
| 退避した古い証明書（流出した鍵）の削除 | `rm -rf /tmp/claude-1000/-mnt-dev-data-multicloud-dev-src/8ef6c963-6b3f-4a26-a463-117173986007/scratchpad/old-certs` |
| 検証用イメージの削除 | `docker rmi nicolaka/netshoot:v0.13` |
| ローカルの compose 環境の停止 | `cd /mnt/dev_data/multicloud_dev/src/multicloud_api_apps && docker compose down -v` |
| GitHub のメールアドレスの保護（設定済みなら不要） | https://github.com/settings/emails の「Keep my email addresses private」「Block command line pushes that expose my email」 |
| 他の環境の git の設定 | `git config --global user.email "3047545+Otazoman@users.noreply.github.com"`。書き換え前に clone した環境（両リポジトリ）は取り直す |

### 8.5 2026-10-18 の dev 構築の記録

| 項目 | 内容 |
|---|---|
| 構築 | `cdktn diff`（253 → サンプル 2 つを外して 246 リソース）→ `cdktn deploy`。DB の管理者パスワードは公開されているサンプルの値と同じだが、検証用としてそのまま使う（ユーザー判断） |
| 1 回目のエラー | Google: `Permission 'secretmanager.secrets.setIamPolicy' denied`（Cloud Run の実行用のサービスアカウントにシークレットの読み取り権限を付けるところ）。cdktn のサービスアカウントに `roles/secretmanager.admin` が必要だった。ユーザーが付与し、cdktn の getting-started（英・日）の権限の一覧に追記 |
| 2 回目 | 成功（6 追加、9 変更、1 作り直し）。変更は、ALB のリスナーのルール、Azure の Container Apps・サブネット・DevOps のプール・パイプライン、Google の VM など、deploy のたびに差分が出る設定（クラウド側が補う値と cdktn の設定のずれ）。データへの影響はない。毎回出る差分の整理は未対応 |
| 入口の応答 | Google（`34.104.187.13`）と Azure（`20.222.21.118`）は仮のイメージが 200。**AWS の ALB は 503** |
| AWS の 503 の原因（見立て） | ECS の Blue/Green が書き換えた ALB の優先度 1 のルールの転送先を、2 回目の deploy で Terraform が最初のターゲットグループに戻した。**修正（未コミット）**: `constructs/loadbalancer/awsalb.ts` で、このルールに `ignore_changes: ["action"]`。ターゲットグループの状態での確認はできていない（次回の構築で、修正後に deploy を 2 回行っても 503 にならないことを確認する） |
| シークレット | AWS と Google は Cloud Shell から入れた（VM ではサインインの手順でつまずいた: AWS は `--remote` が必要、Google は VM の既定のサービスアカウントのスコープ不足。cdktn の operations.md に注意点を追記）。Azure は Bastion を有効にしてから。destroy でシークレットの値も消えるので、次回の構築後に入れ直す |
| 手順書の不備（修正済み・未コミット） | cdktn の operations.md「Secrets」が、各 VM で別々のパスワードを作る手順になっていた（API のパスワードは全クラウド同じ値、の決定と不一致）。最初の VM で作り、他の VM には同じ値を入れる手順に修正 |
| その他 | この環境には AWS・Google・Azure の CLI がない。クラウドの状態の確認は、ユーザーの Cloud Shell や VM で行う |

### 8.6 ユーザーの回答待ち

| # | 内容 |
|---|---|
| 1 | cdktn の未コミットの変更（ALB の修正など）と、このファイルの追記のコミット・push |
| 2 | 次回の dev の構築の時期（Azure は Bastion を有効にしてシークレットを入れる）。課金を伴う |
