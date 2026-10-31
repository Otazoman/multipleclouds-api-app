# FEATURE-PLAN: multicloud_api_apps の残課題

- 作成日: 2026-10-12（最終更新 2026-10-31）
- 表の見方: 完了したものは ID（または番号）の前に ✅ を付け、内容を取り消し線にしている
- ステータス（2026-10-31 終了時）: dev で 3 クラウドのクラスタ構成が、プライベート DNS あり・なしの 3 構成で動作（§8.5.4〜8.5.6）。**DB の冗長構成（Aurora 2 台、Cloud SQL の HA、Azure の HA）でも、各 DB のフェイルオーバーの後にレプリケーションが続き、3 クラウドを一巡する計画的な切り替えも成功**（§8.5.7）。DB の設定は単体に戻し済み。**再開時は §8 から**。
- 分担（2026-10-18 に確認）: クラウド間のデータの複製は PostgreSQL の論理レプリケーション（VPN 経由、5432／TLS）。アプリは書き込みをプライマリに集め、他ノードへの到達を待ち、変更履歴・冪等キー・プライマリの切り替えを受け持つ。HTTPS はクライアントからロードバランサーまでで、レプリケーションとは別。クラウドの中の DB の冗長化（フェイルオーバー）は各クラウドの機能で、アプリからは 1 ノードに見える。
- 関連: インフラ側の設計は `cdktn_multicloud_backend/app/docs/ai/feat01_active_active_design.md`（FEAT-01）と `feat04_environments_design.md`（FEAT-04）。本ファイルはアプリ側の計画で、FEAT-01 の §7（シークレット）・§9 #5（API コンテナの設定）・§12（CI/CD 連携）と対応する。
- 運用手順（人が使うもの）は `docs/operations.md`（英・日）。リリースの手順は同ファイルの「Releases / リリース」。

## 1. 実装済みの内容（要約）

| フェーズ | 内容 | 主なファイル |
|---|---|---|
| 0a | 書き込みをプライマリ1か所に集約。読み取りは自クラウド。コミット後に他ノード1つ以上のディスク確定を待つ準同期。`switchover.sh`（初回・計画的・強制） | `src/cluster.ts`、`migrations/0002_cluster_state.sql`、`scripts/switchover.sh` |
| 0b | 変更履歴 `app.write_journal`、冪等キー、`journal-diff.sh`、`journal-prune.sh`。パブリケーションは TRUNCATE を複製しない。レプリケーション用パスワード変更時にサブスクリプションの接続文字列も更新 | `migrations/0003_write_journal.sql`、`scripts/journal-*.sh`、`scripts/replication-setup.sh` |
| 1 | YAML のモデル定義（`models/*.yaml`）から GraphQL API を起動時に生成。`npm run generate` でマイグレーションとスキーマの出力を生成 | `src/models/`、`src/data/`、`src/schema.ts`、`src/generate.ts` |
| 2 | リレーション（belongsTo / hasMany、まとめて読み込み）、条件指定の更新・削除、読み取り専用の名前付き SQL クエリ | 同上、`src/data/loaders.ts`、`src/data/queries.ts` |
| ✅ ~~API-16~~ | リリースの安全対策: ビルドで `npm test`（失敗でデプロイしない）、CI がコミットを `APP_VERSION` として渡し `/`・`/healthz`・`/readyz` が返す、`/readyz` はイメージのマイグレーションがすべて適用済みのときだけ 200 | ~~`Dockerfile`、`buildspec.yml`・`cloudbuild.yaml`・`azure-pipelines.yml`、`src/migrations.ts`、`migrations/0004_migration_status.sql`（`ops.missing_migrations`、EXECUTE は `api-role-setup.sh`） |~~
| ✅ ~~API-06~~ | 接続数: 自クラウド用プール `DB_POOL_MAX` の既定 10 → 4、他ノード用 `DB_PEER_POOL_MAX`（既定 3）を追加 | ~~`src/config.ts` |~~

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
| シークレット（API-08） | 案 A'（2026-10-17）: 3 ノードで同じ `app_api` パスワードを使う。値は作業用 VM から CLI で各クラウドのシークレットストアに入れる。cdktn は入れ物とダミー値だけ（FEAT-01 §7 のまま）。Azure Key Vault は非公開のまま（§5）。2026-10-25: レプリケーションのパスワード（`db-repl-password`）も全ノードで同じ値に変更（クラスタのスクリプトをどれか1台の VM で、そのクラウドのシークレットストアだけで実行できるように）。値は `scripts/secrets-set.sh <cloud>` で各クラウドに入れる |
| 接続数（API-06） | アプリ側の対策（プールの縮小と他ノード用プールの分離）。マネージドの接続プーリングは使わない（2026-10-17、§6.2） |
| API の構成（topology） | 2026-10-17 決定: cdktn の `apiContainerConfig.topology` で選ぶ。`cluster`（DB のあるクラウドで1つのクラスタ。2クラウド以上なら VPN とプライベート DNS が必須で、無ければ合成エラー）、`independent`（各クラウドが自分の DB だけで単体で動く。VPN・DNS 不要）。dev は当面 `independent` で単体クラウドとして試し、最終的に VPN・DNS を有効にして `cluster` でテストする。単体から後でクラスタにすると、データが残るのは1つのクラウドだけ |
| 最初のリリース | 現在の feature ブランチは、クラウド側の準備（API-01〜04）の後に PR で `dev` へマージする |

## 3. 課題の一覧

優先度: P1 = 最初のリリース（dev）の前に必要、P2 = 本番運用の前に必要、P3 = 改善。作業の順番は §8.2。

| ID | 優先度 | 内容 | 状態 |
|---|---|---|---|
| ✅ ~~API-01~~ | P1 | ~~クラウドでの初回 DB セットアップ（`database-create.sh` → `migrate.sh` → `api-role-setup.sh` → `replication-setup.sh` → `switchover.sh <最初のプライマリ>`）。実行場所は §4~~ | 未着手（dev 環境の構築待ち）。**完了（2026-10-25）**: クラスタは `scripts/cluster-setup.sh`、単体は `scripts/node-setup.sh` の 1 コマンドで 3 クラウドとも成功 |
| ✅ ~~API-02~~ | P1 | ~~cdktn: 各 API コンテナの環境変数とシークレット参照（§5.2）~~ | **実装済み（2026-10-17、未 deploy）**: cdktn の `config/apicontainer.ts` ほか（FEAT-01 §9 #5）。アプリの `buildspec.yml` は `TASK_FAMILY` の最新リビジョンを元にする。deploy 時に確認すること: Container Apps がプライベートエンドポイントだけの Key Vault のシークレットを読めるか、Cloud Run の startup probe の時間。**完了（2026-10-25、3 クラウドで deploy・動作確認）** |
| ✅ ~~API-03~~ | P1 | ~~クラウドでの確認: 各コンテナ（ECS / Cloud Run / Container Apps）から他クラウドの DB（5432）へ接続できるか。設定上は可能（AWS の SG、Google の Cloud Router の広告と PSA のルート交換、Azure の NSG の `VirtualNetwork` タグ）だが、実際の経路は未確認~~ | 未着手。**2026-10-25 に確認済み**: Google の API（Cloud Run）から VPN 経由で AWS の DB に書き込めた。DB 同士の 6 方向の接続も確認（AWS の DB の SG の送信が 80/443 だけだったのを修正） |
| API-04 | P1 | マネージド DB での権限確認: 管理者ユーザーで `CREATE DATABASE` と組み込みロケール（`LOCALE_PROVIDER builtin`）を使えるか（Aurora・Cloud SQL・Azure。使えなければ `DB_CREATE_OPTIONS` で3クラウド共通の照合順序を指定）、管理者ユーザーで `pg_replication_origin_status` を読めるか（強制切り替えで使用。読めなければ `--allow-behind` が必要）、`pg_terminate_backend` を実行できるか（ノード削除の手順）、`subconninfo` を読めるか（読めなければ `replication-setup.sh` が毎回接続文字列を更新し、サブスクリプションが一瞬再起動する） | 未着手。**2026-10-25 の分かったこと**: 3 クラウドとも `CREATE DATABASE`（組み込みロケール）と `replication-setup.sh` は管理者で実行できた（Aurora は `rds_replication` の付与も可）。Cloud SQL では管理者がサブスクリプションの接続文字列を読めないため、`replication-setup.sh` は毎回 `update connection` になる（サブスクリプションが一瞬再接続するだけで問題なし）。`pg_replication_origin_status`・`pg_terminate_backend` は未確認（切り替えのリハーサルで確認） |
| API-05 | P2 | クラウド間の往復時間（RTT）と書き込み時間の実測。PoC では往復 40ms で約 85ms（別クラウドの API から）。`WRITE_ACK_TIMEOUT_MS` の調整。API-06 の想定（書き込み毎秒 700〜800 件が上限の目安）の確認 | 未着手 |
| ✅ ~~API-06~~ | P2 | ~~DB の接続数（最大約 220 で `max_connections = 100` を超え得た）~~ | **完了**（§6） |
| API-07 | P2 | 変更履歴の削除の定期実行（§4.3） | **実装済み（2026-10-17、未 deploy）: C. マネージドのジョブ**。アプリ: `src/prune.ts`（`node dist/prune.js`、`JOURNAL_RETENTION_DAYS`）、`cloudbuild.yaml`・`azure-pipelines.yml` でジョブのイメージを更新。cdktn: `apiContainerConfig.journalPrune`（既定 `false`。API のデプロイ後に `true`）で EventBridge Scheduler＋ECS、Cloud Scheduler＋Cloud Run ジョブ、Container Apps ジョブ。ローカルで別ノードから実行し、プライマリで削除され全ノードに反映されることを確認 |
| ✅ ~~API-08~~ | P2 | ~~シークレットの管理方式~~ | **決定**（A'、§5）。実装は API-02 |
| API-09 | P2 | 運用手順のクラウドでのリハーサル: 計画的な切り替え、強制切り替え（Azure 障害時に AWS / Google の VM から実行する手順を含む: §4.2）、旧プライマリの初期化と復帰、レプリケーション用パスワードの変更、`docs/operations.md` のリリース手順 | 未着手。**2026-10-31: 計画的な切り替え（aws→azure→google→aws）を `cluster-setup.sh --primary` で確認済み**。残り: 強制切り替え、旧プライマリの復帰、パスワードの変更、Azure 障害時の手順 |
| API-10 | P3 | フェーズ 3: MySQL 対応。**MySQL の構成で PostgreSQL と同じこと（どのノードもプライマリになれる双方向の複製、確認待ち、切り替え、変更履歴）ができるかの検討から**。まず3クラウドのマネージド MySQL で、レプリケーションの複製元を付け替えられるか（どのクラウドもプライマリになれるか）を PoC で確認。成り立つ場合のみ、DB 依存部分（確認待ち・切り替え・SQL の方言・DDL 生成）をアダプターに分離して実装 | 未着手 |
| API-11 | P3 | 強制切り替えで受信量が少なかったノードの修復を、初期化（再シード）ではなく変更履歴から行えるようにする（現状は `journal-diff.sh` で一覧にするだけ） | 未着手 |
| API-12 | P3 | 名前付きクエリの SQL を起動時または `npm run generate` 時に検証する（現状は実行するまで分からない） | 未着手 |
| API-13 | P3 | `compose.yaml` 冒頭のコメントがローカル環境の説明として `docs/getting-started.md` を指している（実際は README） | 未着手 |
| ✅ ~~API-14~~ | — | ~~ローカルの `main` を `origin/main` に戻す~~ | **完了**（2026-10-17） |
| ✅ ~~API-15~~ | — | ~~ブランチ運用への移行（`dev`・`staging`・`prod` の作成、cdktn の `cicdTrigger.branches`、ブランチ保護、既定のブランチ、ドキュメント）~~ | **完了**（2026-10-17。cdktn のトリガーは次の構築時に反映: §7） |
| ✅ ~~API-16~~ | — | ~~リリースを安全にする改善（ビルド時のテスト、版の確認、DB の更新漏れでトラフィックを切り替えない readiness）~~ | **完了**（2026-10-17、§1） |
| ✅ ~~API-19~~ | P1 | ~~1・2・3クラウドのどの構成でも API が動くようにする（VPN・DNS なしの単体クラウドを含む）~~ | **実装済み（2026-10-17）**: cdktn の `topology`、`DB_HOST` は自クラウドの DB の元の接続先（Aurora のエンドポイント、Cloud SQL のプライベート IP、Azure の FQDN）、`DB_<NODE>_HOST` はプライベート DNS 名。アプリ: `replication-setup.sh` は1ノードなら何もせず正常終了、`nodes.env.sample` の `NODES` は環境変数を優先、getting-started に構成の説明。ローカルで1ノード・2ノードの動作を確認。deploy 時に確認すること: Container Apps から Azure の DB の FQDN を解決できるか。**完了**: 単体（2026-10-18）とクラスタ（2026-10-25、プライベート DNS あり）で確認。プライベート DNS なしのクラスタにも対応（2026-10-25、cdktn、確認はこれから） |
| API-20 | P2 | 監視と通知 | **一部実装（2026-10-18、cdktn、未 deploy）**: 3 クラウドで API のエラーログ（`failed`）、削除ジョブの失敗、ロードバランサーの 5xx（作られている HTTP / HTTPS のほうだけ）。通知先は `.env.<env>` の `ALERT_EMAILS`（`config/notifications.ts`）。手順はインフラの operations の「アラート」とアプリの operations の「ログとアラート」。**残り**: レプリケーションの遅延・停止とスロットの WAL の蓄積（クラスタにしてから）。deploy 時に確認すること: Azure の Container Apps ジョブのログが `ContainerAppConsoleLogs` に入るか、Google のロードバランサーの 5xx の指標名、AWS の SNS の確認メール |
| ✅ ~~API-21~~ | — | ~~整理（2026-10-17 完了）: `pg_subscription` の参照を現在のデータベースに限定（`replication-setup.sh`・`replication-status.sh`・`switchover.sh`。ローカルで再実行・計画的な切り替え・強制切り替えを確認）、`architecture.md`（英・日）にクラスタと単体の説明、cdktn の Container Apps の仮の `DB_URL` を削除、使わない RDS のロググループの設定をコメントアウト、FEAT-01 §10・FEAT-04 §7.3 の古い項目を完了・取り消しに~~ | **完了** |
| ✅ ~~API-18~~ | P1 | ~~アプリ用のデータベース `appdb` がクラウドで作られない~~ | **実装済み（2026-10-17）: b 案**。`scripts/database-create.sh`（無ければ作成、全ノードの照合順序を比較し異なれば失敗。既定は組み込みロケール `C.UTF-8`、`DB_CREATE_OPTIONS` で変更可）。compose もスクリプトで作る形に変更。API-01 の最初に実行する |
| ✅ ~~API-17~~ | P1 | ~~`docs/getting-started.md`（英・日）のシークレットの手順を A' に合わせる~~ | **完了（2026-10-17）**。`docs/operations.md` のパスワードの変更手順も更新 |
| API-22 | P2 | 冗長構成の確認: API のコンテナを複数台（ECS のタスク、Cloud Run・Container Apps のインスタンス。API は状態を持たないのでアプリの変更は不要の想定）、DB の冗長化（**Aurora を 2 台以上**〔ライターとリーダー〕、**Cloud SQL の HA**〔REGIONAL〕、**Azure の HA**〔ゾーン冗長〕。接続先の名前は変わらないのでアプリの変更は不要の想定）で問題なく動くか。クラスタ構成では、クラウドの中で DB がフェイルオーバーした後も論理レプリケーションのスロットが引き継がれ、複製が続くか（クラウドごとに扱いが違う可能性があり未確認）。プライベート DNS なしのクラスタでは Azure の IP が変わるか | **DB の冗長化は完了（2026-10-31、§8.5.7）**: Aurora・Cloud SQL はそのままフェイルオーバーの後もレプリケーションが続く。Azure はスロットの同期（`sync_replication_slots`・`hot_standby_feedback`、サブスクリプションの `failover = true`）で続く。Azure の IP はフェイルオーバーで変わる（プライベート DNS ありなら追従）。**残り**: API のコンテナの複数台 |
| API-23 | P2 | API にフロントエンドからのみアクセスできるようにする仕組み（方式は未決定: API キー、署名付きヘッダー、ロードバランサー／WAF での制限、OIDC など） | 未着手（2026-10-18 追加）。方式の検討から。2026-10-25 の点検 a: 今は API に認証がなく、ロードバランサーまで誰でも届き書き込みもできる（本番では必須） |
| API-24 | P2 | セキュリティ（2026-10-25 の点検 b）: dev のロードバランサーは HTTP で通信が暗号化されない。stg・prod は HTTPS（設定はある）。**証明書（2026-10-31 に確認）**: AWS は ACM（DNS で検証、正式）。Google（`sslcerts/openssl/server.crt`）と Azure（`sslcerts/pfx/…pfx`、中身は未確認）は 2026-10-17 に作り直した**自己署名**で、ブラウザや `curl` が警告する（`config/google/cloudloadbalancing.ts` の `managedSsl` は手元のファイルをアップロードする設定で、Google が発行するものではない）。本番の前に正式な証明書へ: 案は (1) Let's Encrypt の証明書をファイルで置く（約 90 日ごとに更新）、(2) Google は Certificate Manager（DNS で検証、Google が発行・更新）、(3) Azure は Key Vault の証明書を Application Gateway が参照（自動更新は発行元しだい）。(2)(3) は cdktn の変更が必要。HTTPS にするには公開 DNS（`dns: true`）、HTTPS のロードバランサーの `build`、親ゾーンへの NS の登録も必要 | 未着手 |
| API-25 | P2 | セキュリティ（点検 c）: WAF・レート制限がない（Azure の WAF の Application Gateway の設定は削除済み）。stg・prod で検討 | 未着手 |
| API-26 | P2 | セキュリティ（点検 d）: DB の管理者パスワードが公開のサンプルの値（dev は了承済み）。stg・prod では必ず変える。Terraform の state にも残るので state は作業端末だけに置く | 未着手 |
| API-27 | P3 | セキュリティ（点検 e）: API から DB への TLS が `require`（暗号化のみで証明書を検証しない）。より厳密には `verify-full` と CA の配布 | 未着手 |
| API-28 | P3 | セキュリティ（点検 f）: AWS の作業用 VM の SG が 3 クラウドと Cloud SQL の範囲から全ポートを受け付ける。SSH など必要なポートだけに絞る | 未着手 |
| ✅ ~~API-29~~ | P2 | ~~セキュリティ（点検 1）: コンテナにロードバランサー以外から入れないようにする。AWS の ECS の SG が VPC 全体から 8080・80・443 を受け付けていた、Azure の Container App が VNet と VPN の先から入れた~~ | **完了（2026-10-25、cdktn。プライベート DNS なしの構築で確認）**: ECS の SG は ALB の SG からの 8080 だけ（`sourceSecurityGroupNames`）、ECS のタスクの公開 IP をなし（NAT 経由）、Container App の受信を Application Gateway のサブネットだけに（`allowedSourceSubnets`）。Cloud Run はもとからロードバランサーと内部だけ |

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

## 8. 再開時にやること（2026-10-25 終了時）

### 8.0 再開時の要点（まずここを読む）

- **できていること**: dev で 3 クラウドのクラスタ（論理レプリケーション）が、プライベート DNS あり（haBgp・HTTPS、singleTunnel・HTTP）となしの 3 構成で動作。構築は手順書どおりに一通り通る（§8.5.4〜8.5.6）。
- **クラウド**: 最後の構築（§8.5.6）の後、ユーザーが destroy（再開時に残りがないか確認。Google のサブネットは 1〜2 時間後の再実行が必要なことがある）。
- **未マージ**: アプリの PR #7（`cluster-setup.sh` の CLI のエラー表示、本ファイル）。destroy の後なら、マージしてもビルドは動かない。
- **次の候補**: §8.2 の「次に dev で確認」の上から。どれも課金を伴う構築が必要なので、まとめて 1 回の構築で確認するのがよい。

**構築の手順（毎回同じ）**: cdktn の `docs/operations.md`「環境を構築する」の手順 1〜8（プライベート DNS なしは同じページの「プライベート DNS の無いクラスタ」）。アプリ側は `docs/getting-started.md` の 2〜3 章。

| # | どこで | コマンド |
|---|---|---|
| 0 | 設定ファイル | Cloud SQL の名前を新しい日時に（`config/google/cloudsql/cloudsql.ts`）。必要なら `hostZones` などを切り替え |
| 1 | cdktn のコンテナ | `npm run build-stage`（段階 1 を確認）→ `cdktn diff` → `cdktn deploy` |
| 2 | 3 クラウド（Azure は AWS の VM から SSH で Azure の VM へ） | `scripts/secrets-set.sh aws\|google\|azure` |
| 3 | cdktn のコンテナ | `npm run build-stage -- 2`（プライベート DNS なし: `-- 2 --azure-db-ip <IP>`）→ `cdktn deploy` |
| 4 | AWS の VM | `scripts/cluster-setup.sh aws`（プライベート DNS なし: deploy の出力 `cluster-setup-hosts` の 1 行を前に付ける） |
| 5 | GitHub / 各クラウド | アプリの PR を `dev` にマージ、またはパイプラインを手で実行（ビルドの結果はメールで届く） |
| 6 | cdktn のコンテナ | `npm run build-stage -- 3` → `cdktn deploy`（出力 `api-health-urls` に確認用の URL） |
| 7 | 自分の端末 | `/healthz`・`/readyz`、各クラウドで書き込み 3 クラウドから読む総当たり |
| 後片付け | cdktn のコンテナ | `npm run before-destroy` → `cdktn destroy`（Google のサブネットで止まったら AWS・Azure を `terraform destroy -target` で先に） |

### 8.1 現在の状態

| 対象 | 状態 |
|---|---|
| アプリのリポジトリ | 公開。`dev` は `8313c5f`（PR #6 まで）。`feature/primary-writes-and-models` は `f6ed1df`（PR #7、未マージ）。`staging`・`prod`・`main` は最初のコミット群のまま。ルールセット: 4 ブランチとも PR 必須 |
| cdktn のリポジトリ | 公開。`main` の `66d0bea` まで push 済み。未コミットの変更なし |
| cdktn の dev の設定 | 3 クラウドとも `dbs`・`containers`・`cicd`・`vms`・`alerting` が有効、`dns` は無効。`useVpn` 有効、`vpnMode` は `singleTunnel`、**`hostZones` は無効（プライベート DNS なし）**。`topology` は `cluster`。ロードバランサーは HTTP。Azure の Bastion は無効。構築の段階は `state/dev/build-stage.json`（`before-destroy` で 1 に戻る） |
| 事前準備（済み） | `.env.dev`（`ALERT_EMAILS`、`AZURE_KEYVAULT_SECRETS_OFFICER_IDS` を含む）、cdktn の IAM ユーザーに `AmazonEventBridgeSchedulerFullAccess`・`AmazonEventBridgeFullAccess`、Google の Cloud Scheduler API。AWS の SNS の購読は承認済み |
| ローカル | compose の 3 ノード（プライマリ aws、epoch 3） |

### 8.2 残作業

**次に dev で確認（1 回の構築でまとめて）**

| # | 作業 | 承認・判断 | 関連 |
|---|---|---|---|
| 6 | 変更履歴の削除ジョブが 3 クラウドで実際に動くか。一晩残さず、段階 3 の deploy の後に手で起動して確認する（下の「削除ジョブの確認の手順」）。成功するとログに `Deleted N journal rows older than 30 days on <primary> (epoch N)`（件数 0 でも成功）。あわせてアラートが鳴るか（わざとエラーを出す。方法は試すときに決める） | 課金（構築の間だけ） | API-07、API-20 |
| 3 | マネージド DB の権限の残り: `pg_replication_origin_status`（強制切り替え）、`pg_terminate_backend`（ノードの削除）を管理者で使えるか | クラウドの DB への実行 | API-04 |
| 9 | 運用手順のリハーサル: ~~計画的な切り替え~~ **完了（2026-10-31）**。残り: 強制切り替え、旧プライマリの復帰、パスワードの変更、Azure 障害時に AWS / Google の VM から切り替える手順 | クラウドの DB への実行 | API-09 |
| 7 | 往復時間と書き込み時間、同時書き込みの実測。`WRITE_ACK_TIMEOUT_MS` の調整 | — | API-05、API-06 |
| 8b | 冗長構成: ~~DB の冗長化（Aurora 2 台、Cloud SQL の HA、Azure の HA）とフェイルオーバーの後のレプリケーション~~ **完了（2026-10-31、§8.5.7）**。残り: API のコンテナの複数台 | 課金 | API-22 |

**削除ジョブの確認の手順（§8.2 の 6。一晩残すと約 20 ドルかかるため、手で起動する）**

```bash
# Google（Cloud Shell）: Cloud Scheduler から今すぐ起動（Scheduler からの起動の権限も確認できる）
gcloud scheduler jobs run multicloud-google-journal-prune --location=asia-northeast1
gcloud run jobs executions list --job=multicloud-google-journal-prune --region=asia-northeast1 --limit=1
gcloud logging read 'resource.type="cloud_run_job" AND textPayload:"journal"' --freshness=15m --limit=5 --format='value(textPayload)'

# Azure: 今すぐ起動して実行の状態（Succeeded）を見る
az containerapp job start -g rg_multicloud -n multicloud-azure-journal-prune
az containerapp job execution list -g rg_multicloud -n multicloud-azure-journal-prune --query '[0].{name:name,status:properties.status}' -o table

# AWS（CloudShell）: EventBridge Scheduler には「今すぐ実行」がないので、一時的に 5 分ごとにする
# （リビジョンなしのタスク定義で最新のリビジョンが動くかの確認。次の cdktn deploy で毎日 3 時に戻る）
aws scheduler get-schedule --region ap-northeast-1 --name multicloud-aws-journal-prune --output json \
  | jq '{Name, GroupName, ScheduleExpression: "rate(5 minutes)", ScheduleExpressionTimezone, FlexibleTimeWindow, Target, State}' > /tmp/prune.json
aws scheduler update-schedule --region ap-northeast-1 --cli-input-json file:///tmp/prune.json
# 5〜6 分後
aws logs filter-log-events --region ap-northeast-1 --log-group-name /aws/ecs/api-service \
  --filter-pattern '"journal rows"' --start-time $(( ($(date +%s) - 900) * 1000 )) --query 'events[].message' --output text
```

**stg・prod の前に**

| # | 作業 | 承認・判断 | 関連 |
|---|---|---|---|
| 13 | API の認証（フロントエンドからのみアクセスできる仕組み。方式の検討から） | 設計 | API-23 |
| 15 | セキュリティ: HTTPS、WAF・レート制限、本番の DB のパスワード、DB の TLS の検証、作業用 VM の SG | 実施 | API-24〜28 |
| 10 | 監視の残り: レプリケーションの遅延・停止、スロットの WAL の蓄積 | 設計 | API-20 |
| 11 | stg・prod の環境を用意（各アカウントの CI/CD の接続、`.env.stg` / `.env.prod`）し、リリース手順で昇格（`dev` → `staging` → `prod` → `main`） | 環境ごと | — |

**改善（任意・P3）**

| # | 作業 | 関連 |
|---|---|---|
| 12 | MySQL の構成で PostgreSQL と同じことができるかの検討、変更履歴からの修復、名前付きクエリの検証、`compose.yaml` のコメント | API-10〜13 |
| 14 | cdktn: deploy のたびに出る差分の整理（§8.5）、Google のアラートの部品の型から使えない比較を外す | — |

**完了（記録）**: 1・2・4・5（単体構成のリリース、2026-10-18）、8・8a・8c・16（クラスタ構成: haBgp・HTTPS、singleTunnel・HTTP、プライベート DNS なし、2026-10-25）、14 の一部（作成待ちとサブネットの順番の修正、構築の段階、ビルドの結果のメール、`before-destroy`）。詳細は §8.5〜8.5.6。

### 8.3 deploy のときに確認すること（未検証の前提）

| 対象 | 確認すること | 状態 |
|---|---|---|
| Azure | Container Apps から、プライベートエンドポイントだけの Key Vault のシークレットを読めるか。Container Apps の環境から Azure の DB の FQDN を解決できるか | ✅ ~~確認済み（2026-10-18）~~ |
| Google | Cloud Run の startup probe の待ち時間（最大 2 分）で足りるか | ✅ ~~確認済み（段階 3 で `/readyz` が 200）~~ |
| Google | `roles/run.invoker` で Cloud Run ジョブを実行できるか（削除ジョブ） | 未確認（§8.2 の 6） |
| AWS | EventBridge Scheduler が、リビジョンなしのタスク定義 ARN で最新のリビジョンを実行するか（削除ジョブ） | 未確認（§8.2 の 6） |
| 3 クラウド | 新しい証明書（Google のロードバランサー、Azure の Application Gateway の PFX）が受け付けられるか | ✅ ~~確認済み（2026-10-25、HTTPS で応答）~~ |
| Azure | Cloud SQL・Aurora から Azure の DB へ、プライベート DNS の名前で接続できるか（ピアリングされた DNS ドメイン） | ✅ ~~確認済み（2026-10-25）~~ |

### 8.4 ユーザーの作業（任意・後片付け）

| 内容 | コマンド・場所 |
|---|---|
| ✅ ~~退避した古い証明書（流出した鍵）の削除~~ | 削除済み（2026-10-25 に確認） |
| ✅ ~~検証用イメージの削除~~ | 削除済み（2026-10-25 に確認） |
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
| AWS の 503 の原因（見立て） | ECS の Blue/Green が書き換えた ALB の優先度 1 のルールの転送先を、2 回目の deploy で Terraform が最初のターゲットグループに戻した。**修正（`f489037`）**: `constructs/loadbalancer/awsalb.ts` で、このルールに `ignore_changes: ["action"]`。ターゲットグループの状態での確認はできていない（次回の構築で、修正後に deploy を 2 回行っても 503 にならないことを確認する） |
| シークレット | AWS と Google は Cloud Shell から入れた（VM ではサインインの手順でつまずいた: AWS は `--remote` が必要、Google は VM の既定のサービスアカウントのスコープ不足。cdktn の operations.md に注意点を追記）。Azure は Bastion を有効にしてから。destroy でシークレットの値も消えるので、次回の構築後に入れ直す |
| 手順書の不備（修正済み） | cdktn の operations.md「Secrets」が、各 VM で別々のパスワードを作る手順になっていた（API のパスワードは全クラウド同じ値、の決定と不一致）。最初の VM で作り、他の VM には同じ値を入れる手順に修正 |
| その他 | この環境には AWS・Google・Azure の CLI がない。クラウドの状態の確認は、ユーザーの Cloud Shell や VM で行う |

### 8.5.1 2026-10-18 の再構築とリリースの記録

| 項目 | 内容 |
|---|---|
| 構築 | ユーザーが Cloud SQL の名前を変えて deploy。1 回目は AWS の CodeBuild のプロジェクトの作成で `OAuthProviderException`（GitHub 接続の権限。直前に作られたサービスロールの権限が IAM に反映される前と推定）、再実行で成功。再発するなら `time_sleep` で待つ案（未実施） |
| シークレット | AWS・Google は Cloud Shell、Azure は VM から。Azure は Key Vault の書き込み権限がなく `ForbiddenByRbac`。cdktn が `.env.<env>` の `AZURE_KEYVAULT_SECRETS_OFFICER_IDS`（オブジェクト ID、カンマ区切り）から権限を付けるように変更（コンテナの起動時に読むので、値を足したらコンテナを作り直す。環境の準備の段階で一度書けばよい）。今回は Cloud Shell で手作業で付与（Key Vault と一緒に削除される） |
| `azureSecretReady` | dev だけ `true` にして deploy（2 回目）。**AWS の ALB は 2 回目の deploy の後も 200: ALB の修正の効果を確認**。その後、次回の構築に備えて `false` に戻した |
| DB のセットアップ | 手作業（`nodes.env` と 5 つのスクリプト）が複雑だったため、`scripts/node-setup.sh <cloud>` を追加（クラウドの CLI から接続先・管理者・API のパスワードを読み、足りない値だけ聞いて 5 つのスクリプトを実行）。あわせて `lib.sh` の不具合を修正（`SSLMODE`・`PORT` の既定値が空の値に効かず、`invalid sslmode value: ""`。手作業の手順でも VM で起きていた）。3 クラウドとも成功 |
| リリース | PR #1（feature → `dev`）をマージ（`41c07e6`）。約 5 分で 3 クラウドとも新しい版に切り替わった（ビルド時のテストも通過） |
| 確認 | 3 クラウドで `/healthz`（同じ版）・`/readyz`（200）・書き込み・読み取り・冪等キーの再送（同じ ID）。各クラウドに `dev-check-<cloud>` を 1 件。**確認できた前提**: Container Apps がプライベートエンドポイントの Key Vault のシークレットを読める、Container Apps の環境から Azure の DB の FQDN を解決できる |
| 手順書の整理 | cdktn の operations.md に「環境を構築する」（インフラだけ。Azure の 2 回 deploy の理由を含む）。DB のスクリプトの手順（クラスタのパスワードの集め方）はアプリの getting-started に移した。アプリの getting-started に「全体の流れ」と `node-setup.sh` の説明 |
| 次回 | 手順 6（`readinessProbe`・`journalPrune.enabled` を `true`、削除ジョブの確認。Google は Cloud Scheduler API の有効化を確認）、実測、クラスタ化（§8.2） |

### 8.5.2 2026-10-18 の設定の整理と監視（cdktn）

| 項目 | 内容 |
|---|---|
| 設定ファイルの整理 | 使っていないサンプル（ECS の worker、Cloud Run の standalone、RDS インスタンス、2 台目の VM、2 つ目のストレージ、Container Apps の frontend、コメントアウトした例）を削除。Google のグローバルの HTTPS ロードバランサーと Azure の WAF の Application Gateway を削除。ロードバランサーは HTTP と HTTPS の組を残す。ストレージは各クラウド 1 つだけ残して `build: false`。合成結果の比較で、差は worker のロググループと（全機能有効時の）ストレージだけ。テストはサンプルに頼らないよう、必要な例をテストの中で作る形に変更 |
| 監視 | API-20 の一部（上の表）。Azure のメトリクスのアラートにディメンションと Application Gateway の指定を追加、AWS は ALB の名前から `LoadBalancer` のディメンションを解決 |
| destroy の不具合 | Cloud SQL の `root` が `appdb` を所有しているため、destroy でユーザーを削除できない。今回は `terraform state rm` で回避、`google_sql_user` に `deletion_policy = "ABANDON"` を追加して再発防止。Cloud Run のサブネットは既知の問題（1〜2 時間後に再実行） |
| 設定（ユーザー） | `useVpn`・`hostZones` を有効にした（クラスタのテストは監視などの確認の後）。`ALERT_EMAILS` は `.env.dev` に追記済み（Git の管理外）。コンテナの作り直しは destroy の後にユーザーが行う |

### 8.5.3 2026-10-18 の 3 回目の構築の記録

| 項目 | 内容 |
|---|---|
| state の残骸 | 前回の destroy が途中で止まり、削除済みの旧 Cloud SQL のインスタンスとユーザーが state に残っていた。deploy の refresh で `instanceDoesNotExist`（404）。ユーザーが `terraform state rm` で 2 件を外して解消（network と subnetwork は state に残ったまま引き継ぎ） |
| コンテナ | ユーザーが `DEPLOY_ENV=dev docker compose -p cdktn-dev up -d --force-recreate` で作り直し、`ALERT_EMAILS`・`AZURE_KEYVAULT_SECRETS_OFFICER_IDS` を読み込んだ。あわせて Docker のビルドキャッシュ（4.0GB）と未使用のボリューム（246MB）を削除（イメージは残す） |
| deploy のエラー | (1) AWS の CodeBuild の `OAuthProviderException`（前回と同じ。再実行で成功）。(2) Google のロードバランサーの 5xx のアラートで `COMPARISON_GE` が使えない（しきい値の条件は GT と LT だけ）→ `COMPARISON_GT`・しきい値 9 に修正。(3) 手順 6 で、AWS の IAM ユーザーに EventBridge Scheduler の権限がない（ユーザーが `AmazonEventBridgeSchedulerFullAccess` を付与）、Google の Cloud Scheduler API が無効（有効化）。cdktn の getting-started に事前準備として追記 |
| 確認できたこと | 3 クラウドの DB のセットアップ（`node-setup.sh`）、アプリのビルド（構築直後はマージするものがないので、パイプラインを手で実行）、アラートの作成（AWS: アラーム 4・SNS、Google: ログベースの指標 2・ポリシー 3・通知チャネル、Azure: ログ検索のアラート 2・メトリックのアラート 1・アクション グループ）、削除ジョブの作成 |
| 手順書 | deploy が 3 回であること（1 回目: 全部 `false`、2 回目: `azureSecretReady`、3 回目: `readinessProbe`・`journalPrune.enabled`）と理由を両リポジトリに明記。3 回目が必須なのは `readinessProbe` だけで、削除ジョブは前倒しも可能だが、API のデプロイ前にスケジュールの時刻が来ると失敗するため一緒に作る（ユーザー判断で 3 回のまま） |
| 終了時 | ユーザーが destroy。`apiContainerConfig` の 3 つのフラグは `false` に戻し済み。次回は Cloud SQL の名前を変える |

### 8.5.4 2026-10-25 のクラスタ構成の構築と確認

| 項目 | 内容 |
|---|---|
| 構成 | dev、`topology: cluster`、VPN `haBgp`、プライベート DNS、HTTPS のロードバランサー、公開 DNS あり |
| deploy | 1 回目: CodeBuild の `OAuthProviderException`、Azure DevOps のプールの作成失敗（サブネットが更新中）とパイプラインの `Agent pool ... was not found`。再実行で成功。**原因**: CodeBuild のプロジェクトがサービスロールのポリシーを、パイプラインがプールを待っていなかった（依存関係の抜け）→ 作成待ちを追加（cdktn） |
| シークレット | 新しい `scripts/secrets-set.sh <cloud>` で 3 クラウドに入れた。レプリケーションのパスワードも全ノード共通に変更（§3 の決定） |
| DB のセットアップ | AWS の VM 1 台から手作業（`nodes.env` と 6 本のスクリプト）。つまずき: (1) Azure の管理者ユーザーは `root` ではなく `azuredbadmin`（Azure は `root` を使えない）。(2) `replication-setup.sh` がタイムアウトなしで止まった: AWS の DB の SG の送信が 80/443 だけで、Aurora から他の DB の 5432 に接続できなかった → SG を修正。(3) Cloud SQL が `aurora-postgres.aws.inner` を引けない（`could not translate host name`） |
| Cloud SQL と DNS | Cloud SQL は Google のサービス提供側の VPC にあり、この VPC のプライベートゾーンを使えない（公開 DNS だけ）。Aurora のエンドポイントは公開 DNS でプライベート IP を返すので引けるが、Azure の DB の名前は公開 DNS では `privatelink` の別名までで IP が返らない。Aurora と Azure の DB はプライベート DNS を引ける。Service Networking のピアリングされた DNS ドメイン（`aws.inner.`、`azure.inner.`）を手で追加したところ、Cloud SQL も名前で接続できた（Google のドキュメントでは Cloud SQL は対象外とされているが、PostgreSQL の論理レプリケーションで動作）→ cdktn に追加、`cluster-setup.sh` はすべてプライベート DNS の名前で接続 |
| レプリケーション | 6 つのサブスクリプションが有効、スロットはすべて active、遅れなし、エラー 0。プライマリ aws（epoch 1） |
| 動作確認 | 3 クラウドで `/healthz`（同じ版）と `/readyz`（200）。Google の API で書き込み（AWS の DB で実行）、Azure と AWS の API から読めた |
| 手順の改善 | DB のセットアップを `scripts/cluster-setup.sh <cloud>` の 1 コマンドに（ローカルの 3 ノードで、再実行・プライマリの切り替えと戻し・届かない DB で 6 秒で停止・シークレットストアからの読み込みを確認）。接続のタイムアウト（`PGCONNECT_TIMEOUT`、サブスクリプションの `connect_timeout`）を追加。手順書の deploy が 3 回であることを明記 |
| destroy | Azure の DB のパラメータ（`wal_level`）の destroy が 2 回 `InternalServerError`（パラメータの destroy はサーバーの値を戻す操作で、論理レプリケーションのスロットがあると `wal_level` を戻す再起動が成功しないためと推定）。Google のサブネット（既知の問題）と同時に止まり、Azure のリソースが残った。パラメータを state から外し、Azure だけ `terraform destroy -target` で先に削除。**対策**: cdktn に `npm run before-destroy`（`scripts/before-destroy.sh`、パラメータを state から外す）を追加し、operations の destroy の手順に、待ちのあるクラウドを残して他を先に削除する方法を追加 |
| 終了時 | ユーザーが destroy（手で追加したピアリングされた DNS ドメインは先に削除）。設定は HTTP・singleTunnel・3 つのフラグ `false` に戻した（`topology` は `cluster` のまま） |

### 8.5.5 2026-10-25 の singleTunnel・HTTP での再確認

| 項目 | 内容 |
|---|---|
| 構成 | dev、`topology: cluster`、VPN `singleTunnel`、プライベート DNS、HTTP のロードバランサー、公開 DNS なし（`dns: false`） |
| deploy | 1 回目: Azure の DevOps のプール（サブネットが更新中）と DNS リゾルバーの受信用エンドポイント（同）で失敗、再実行で成功。**原因**: 同じ VNet のサブネットへの変更（NSG・NAT ゲートウェイの割り当て、DNS リゾルバーの 2 つのサブネット）を待たずに作っていた → 作成の順番を修正（cdktn）。2 回目（`azureSecretReady`）は再実行と兼ねた |
| シークレットと DB | `secrets-set.sh`（3 クラウド）、`cluster-setup.sh aws`（AWS の VM）が 1 回で成功。Cloud SQL を含め DB 同士はすべてプライベート DNS の名前で接続（cdktn で作ったピアリングされた DNS ドメイン）。6 つのサブスクリプション、プライマリ aws（epoch 1）、エラー 0 |
| アプリのビルド | PR #4 のマージがインフラの作り直しの前だったため自動では動かず、3 クラウドで手で実行。3 回目の deploy をビルドの前に行ったが、ビルドの後に正常になった |
| 動作確認 | 3 クラウドで `/healthz`（同じ版 `79a1f9a`）と `/readyz`（200）。Azure の API で書き込み、Google・AWS・Azure の API から読めた |
| 改善 | 手で書き換えていた 3 つのフラグを構築の段階に（`npm run build-stage -- <1・2・3>`、`state/<env>/build-stage.json`、`before-destroy` が 1 に戻す。テストは段階 1 に固定）。AWS と Google のビルドの結果のメール（成功・失敗）。手順書の「環境を構築する」を手順 1〜8 の 1 つの表に |
| 設定 | 3 つのフラグは構築の段階で決まるので、設定ファイルの書き換えは不要に。dev の `topology` は `cluster`、`dns` は `false` のまま（ユーザーの設定） |

### 8.5.6 2026-10-25 のプライベート DNS なしのクラスタの確認

| 項目 | 内容 |
|---|---|
| 構成 | dev、`topology: cluster`、`hostZones: false`、VPN `singleTunnel`、HTTP のロードバランサー、Azure の Bastion なし（Azure の VM には AWS の VM から VPN 経由で SSH） |
| cdktn の変更（この構築の前） | プライベート DNS なしでもクラスタを作れるように（AWS は Aurora のエンドポイント、Google は Cloud SQL の IP、Azure は `npm run build-stage -- 2 --azure-db-ip` で記録した IP。`.env` はコンテナの起動時にしか読まれないため、段階のファイルに記録）。deploy の最後に `cluster-setup-hosts` と `api-health-urls` を表示。コンテナへの接続をロードバランサーだけに（API-29）。`build-stage` で Azure の IP の付け忘れを注意 |
| つまずき | (1) 段階 2 を `--azure-db-ip` なしで設定し、合成が止まった（想定どおりの停止。注意の表示を追加）。(2) `cluster-setup.sh` が AWS のシークレットを読めなかった（CLI のサインイン切れ。CLI のエラーを表示するよう修正）。(3) Azure の DB への管理者のログインが 1 回失敗（パスワードを明示的に入力して再実行で成功、原因は不明） |
| DB のセットアップ | `NODE_AWS_HOST=<Aurora のエンドポイント> NODE_GOOGLE_HOST=<Cloud SQL の IP> NODE_AZURE_HOST=<Azure の IP> scripts/cluster-setup.sh aws` で成功 |
| 動作確認 | 3 クラウドで `/healthz`（同じ版 `8313c5f`）と `/readyz`（200）。各クラウドで書き込み、3 クラウドから読む総当たりの 9 通りすべて成功。ビルドの結果のメールが AWS・Google・Azure とも届いた |

### 8.5.7 2026-10-31 の DB の冗長構成の確認

| 項目 | 内容 |
|---|---|
| 構成 | dev、`topology: cluster`、プライベート DNS あり、HTTP。DB を冗長に: Aurora 2 台（ライター・リーダー）、Cloud SQL `REGIONAL`、Azure `GP_Standard_D2ds_v5` の `ZoneRedundant`（Burstable は HA 不可） |
| 事前の対策 | Azure は PostgreSQL 17 以降、`sync_replication_slots`・`hot_standby_feedback` があり、`failover` を有効にして作ったスロットだけが待機系に同期される（Microsoft のドキュメント）。cdktn の Azure のパラメータに 2 つを追加、アプリの `replication-setup.sh` はサブスクリプションを `failover = true` で作る（既存は切り替える）。どちらも冗長化していなくても害がないので常に有効 |
| フェイルオーバー | `aws rds failover-db-cluster`、`gcloud sql instances failover`、`az postgres flexible-server restart --failover Forced` を 1 クラウドずつ。各回の後、6 本のサブスクリプションの時刻が今、スロットはすべて active、総当たりの 9 通りが成功。Azure の送り出しのスロットは `synced = t` で新しいプライマリに引き継がれた。受け取る側に接続のエラーが 1 回ずつ（自動で再接続、統計の累計） |
| Azure の IP | フェイルオーバーで `10.2.32.5` に（これまでの構築ではいつも `.4`）。プライベート DNS ありなら名前が追従、なしなら記録し直しが必要 |
| 計画的な切り替え | `cluster-setup.sh aws --primary azure` → `google` → `aws`（epoch 2→3→4）。毎回、書き込みが新しいプライマリで行われ、他の 2 つに届いた（フェイルオーバーで引き継がれたスロットが実際にデータを運べることも確認）。同じ切り替えの繰り返しは何もしない |
| つまずき | 段階 3 をビルドの前に deploy し、仮のイメージが `/readyz` に落ちて AWS のデプロイが 10 分を超え、ビルドが失敗扱い（デプロイは 30 秒後に完了）。→ `build-stage` の段階 3 で注意を表示、`buildspec.yml` の待ちを 20 分にしロールバックを検出。Cloud SQL への管理者のログインが 1 回失敗（再実行で成功。DB 側の一時的なものと判断） |
| 改善 | `cluster-setup.sh --status`（状態だけを表示）、`buildspec.yml`（待ち 20 分、ロールバックで失敗に） |
| 終了時 | DB の設定を単体に戻した（Aurora 1 台、Cloud SQL `ZONAL`、Azure `B_Standard_B1ms`）。ユーザーが destroy |

### 8.6 ユーザーの回答待ち

| # | 内容 |
|---|---|
| 1 | アプリの PR #7 の `dev` へのマージ |
| 2 | 次の dev の構築の時期と範囲（§8.2 の「次に dev で確認」。削除ジョブの確認には一晩残す必要がある）。課金を伴う |
