# FEATURE-PLAN: multicloud_api_apps の残課題

- 最終更新: 2026-11-23。**再開時は §2「次回やること」から。**
- このファイルには、今の状態・次にやること・残課題・今も有効な決定・手順・注意点だけを書く。終わった課題の経緯と構築ごとの詳しい記録は Git の履歴にある（2026-11-23 の整理の前の版: `git show 85886bc:docs/ai/FEATURE-PLAN.md`）。
- 関連: 運用手順（人が使うもの）は `docs/operations.md`（英・日）、設計は `docs/architecture.md`・`docs/models.md`。インフラ側の設計は cdktn の `app/docs/ai/feat01_active_active_design.md`（FEAT-01）・`feat04_environments_design.md`（FEAT-04）、構築の手順は cdktn の `app/docs/operations.md`「環境を構築する」。

## 1. 今の状態

**できていること（dev で確認済み）**

- 3 クラウドのクラスタ: 書き込みはプライマリ 1 か所、読み取りは自クラウド、コミット後に他ノード 1 つ以上の確定を待つ準同期、変更履歴と冪等キー。プライベート DNS あり・なし、VPN `haBgp`・`singleTunnel`、HTTP・HTTPS の各構成で動作。
- 切り替え: 計画的（`cluster-setup.sh --primary`）、強制（Azure の DB を止めて AWS の VM から）、旧プライマリの初期化と復帰。
- 冗長化: DB（Aurora 2 台、Cloud SQL の HA、Azure の HA）のフェイルオーバーの後もレプリケーションが続く。API のコンテナ各 2 台で、同時の書き込みと冪等キーが正しく動く。
- 運用の仕組み: 変更履歴の削除ジョブ（3 クラウド）、アラート（API のエラー、削除ジョブの失敗、5xx、応答時間、正常でないホスト、外からの死活監視）、証明書の自動発行と更新、NS の委任。
- 実測（東京の 3 リージョン）: クラウド間の往復 5〜6ms。書き込み（API の中）はプライマリと同じクラウドから 19ms、他のクラウドから 31〜38ms。

**環境とリポジトリ（2026-11-23 終了時）**

| 対象 | 状態 |
|---|---|
| dev の環境 | 2026-11-23 に destroy を実行（終了と state が空かを再開時に確認。Google の PSA の接続と Cloud Run のサブネットで止まることがある: §6） |
| アプリのリポジトリ | `dev` は `03e3791`（PR #7 まで）。**PR #9 が未マージ**（`docs/journal-prune-and-feature-plan`）: `cluster-setup.sh --status`・`--force`、`buildspec.yml`（ECS の待ち 20 分とロールバックの検出）、手順書、本ファイル |
| cdktn のリポジトリ | `main` の `42c5b7c` まで push 済み。**手元の未コミット**: `config/commonsettings.ts`（構築の構成）、`config/google/cloudsql/cloudsql.ts`（Cloud SQL の名前） |
| cdktn の dev の設定 | 3 クラウド、`topology: cluster`、VPN `singleTunnel`、`hostZones: false`（プライベート DNS なし）、`dns: true`、ロードバランサーは 3 クラウドとも HTTPS、`alerting` 有効。API の最小台数は ECS 1・Cloud Run 1（最大 2）・Container Apps 1（最大 10）。構築の段階は 1。バージョン: cdktn 0.25.1、google プロバイダー 8.12、Terraform 1.17.2 |

## 2. 次回やること

| # | 作業 | 課金 | 関連 |
|---|---|---|---|
| 0 | destroy の終了と state が空かを確認 | — | §6 |
| 1 | **API の認証の方式の検討**（API にフロントエンドからだけ届く仕組み。WAF・レート制限と Azure の入り口の再検討を含む） | なし | API-23、API-25 |
| 2 | Azure の `api-errors` の誤報を直す（段階 1〜3 の仮のイメージ〔nginx〕のログに一致して鳴る） | なし | API-20 |
| 3 | レプリケーションの遅延・停止と、スロットの WAL のたまりの監視の設計 | なし | API-20 |
| 4 | PR #9 のマージ | なし | — |
| 5 | **次の構築でまとめて確認**（下の一覧） | あり | — |

**5. 次の構築で確認すること**

| 確認 | 見ること | 関連 |
|---|---|---|
| 3 クラウドの HTTPS のクラスタ | 証明書の発行、`https://api.<cloud>test…/readyz` が 200、死活監視が 443 で緑 | — |
| Azure の可用性テストの結果 | `AppAvailabilityResults` に 3 地点の `Success = True`（前回は結果を確かめられなかった） | API-20 |
| `cluster-setup.sh --force` をクラウドで | プライマリの DB を止めて、生きているクラウドの VM から実行 | API-09 |
| `buildspec.yml` | ECS のデプロイを 20 分まで待ち、ロールバックで失敗になる | PR #9 |
| パスワードの変更のリハーサル | `app_api` と `app_repl` を変え、API を作り直してつながる | API-09 |
| 同時の書き込みの実測 | 毎秒 700〜800 件という上限の想定（§4 の接続数） | API-05、API-06 |

構築の前に: Cloud SQL の名前を新しい日時に変える（§5）。

## 3. 残課題

優先度: P2 = 本番の前に必要、P3 = 改善。

| ID | 優先度 | 内容 | 状態と次の一手 |
|---|---|---|---|
| API-23 | P2 | API にフロントエンドからだけ届く仕組み（API キー、署名付きヘッダー、ロードバランサー・WAF での制限、OIDC など） | 未着手。方式の検討から。今は誰でも書き込める（Azure の入り口には構築の直後からスキャナーのアクセスがある） |
| API-25 | P2 | WAF・レート制限 | 未着手。API-23 と一緒に。Azure の入り口は §4 |
| API-20 | P2 | 監視の残り | (a) レプリケーションの遅延・停止とスロットの WAL のたまり、(b) Azure の `api-errors` の誤報（条件をアプリのメッセージに絞るか、API のデプロイまでアラートを作らない）、(c) 台数が上限に達した（AWS は Container Insights が必要。見送り中）、(d) Azure の可用性テストの結果の確認、(e) Google のアラートに severity がない（軽微） |
| API-09 | P2 | 運用手順のリハーサルの残り | パスワードの変更（`docs/operations.md`「Passwords」）。切り替えと復帰は完了 |
| API-05 | P2 | 同時の書き込みの実測 | 往復と書き込みの時間は実測済み（§1）。`WRITE_ACK_TIMEOUT_MS`（既定 3000ms）の調整は不要 |
| API-06 | P2 | 接続数の見直し | 最大の台数で Google か Azure がプライマリのとき、`max_connections = 100` への余裕は 10〜15 本（§4）。台数の上限を上げるときと本番の前に見直す |
| API-26 | P2 | 本番の DB の管理者パスワード | dev は公開されているサンプルの値（了承済み）。stg・prod では必ず変える。Terraform の state にも残るので、state は作業端末だけに置く |
| API-27 | P3 | API から DB への TLS の証明書の検証 | 今は `require`（暗号化のみ）。`verify-full` と CA の配布 |
| API-28 | P3 | 作業用 VM のセキュリティグループ | AWS の VM が 3 クラウドと Cloud SQL の範囲から全ポートを受け付ける。必要なポートだけに |
| ENV | P2 | stg・prod の環境 | 各アカウントの CI/CD の接続、`.env.stg`・`.env.prod`、リリース手順で `dev` → `staging` → `prod` → `main` に昇格 |
| API-10 | P3 | MySQL 対応 | MySQL の構成で、どのノードもプライマリになれる双方向の複製・確認待ち・切り替え・変更履歴ができるかの検討（3 クラウドのマネージド MySQL で PoC）から |
| API-11 | P3 | 強制切り替えで受信が少なかったノードを、初期化ではなく変更履歴から修復 | 今は `journal-diff.sh` で一覧にするだけ |
| API-12 | P3 | 名前付きクエリの SQL の検証（起動時か `npm run generate` 時） | 今は実行するまで分からない |
| INFRA | P3 | cdktn: deploy のたびに出る差分の整理、Google のアラートの部品の型から使えない比較を外す | 未着手 |
| AZ-AI | P3 | Application Insights を作ると Azure が自動で作るアクション グループ `Application Insights Smart Detection` が、destroy の後に残る（cdktn の管理外） | 2026-11-23 に判明。再発を防ぐ方法を調査中（azurerm の `features.application_insights.disable_generated_rule` で止まるか、`before-destroy` で消すか） |
| CERT | — | Azure の Let's Encrypt の自動更新（期限の 30 日前） | 環境を 60 日以上残したときだけ関係する（初回は発行から約 60 日後）。未確認 |

**完了**: API-01〜04、06（プールの縮小）〜08、13〜19、21、22、24、29。

## 4. 決定事項（今も有効なもの）

| 項目 | 決定 |
|---|---|
| 書き込みの方式 | プライマリに集約。障害時は数分以内の切り替えを許容。各 API がプライマリの DB に VPN 経由で直接接続（内部 LB なし）。マネージド DB は同期レプリケーションを設定できないので、アプリ側の準同期で代替 |
| 分担 | クラウド間の複製は PostgreSQL の論理レプリケーション（VPN、5432、TLS）。アプリは書き込みの集約、確認待ち、変更履歴、冪等キー、切り替えを受け持つ。HTTPS はクライアントからロードバランサーまで。クラウドの中の DB の冗長化は各クラウドの機能 |
| API の構成 | cdktn の `apiContainerConfig.topology`: `cluster`（DB のあるクラウドで 1 つのクラスタ。2 クラウド以上は VPN が必要）か `independent`（各クラウドが単体）。単体から後でクラスタにすると、データが残るのは 1 つのクラウドだけ |
| キュー | トランザクションのデータには使わない。後続の処理（通知など）だけ |
| シークレット（A'） | `app_api` と `app_repl` のパスワードは、それぞれ全ノードで同じ値。`scripts/secrets-set.sh <cloud>` で各クラウドのシークレットストアに入れる。cdktn は入れ物とダミーの値だけ。Azure Key Vault は公開しない（VNet の中の VM から入れる）。管理者のパスワードは cdktn の `.env` と state |
| 接続数 | `DB_POOL_MAX` 4（自クラウド）、`DB_PEER_POOL_MAX` 3（他ノードごと）。プライマリへの API の接続は最大約 76 本（ECS 10 × 4 ＋ Container Apps 10 × 3 ＋ Cloud Run 2 × 3）。マネージドの接続プーリングは使わない（確認待ちの間も接続を占有するため）。上限を超えた書き込みはプールで待ち、5 秒で `PRIMARY_UNAVAILABLE`（冪等キーで再試行できる）。`max_connections` は Aurora 401、Cloud SQL 100、Azure B1ms 100 |
| 変更履歴の削除 | マネージドのジョブ（`src/prune.ts`、各クラウドのスケジュール実行、既定 30 日）。cdktn が構築の段階 3 で作る。`scripts/journal-prune.sh` は手動用 |
| ブランチと環境 | `dev` → dev、`staging` → stg、`prod` → prod。`main` は prod に出したコードの記録（デプロイしない）。昇格はすべて PR。`staging`・`prod`・`main` はマージコミットのみ。4 ブランチとも PR 必須（ルールセット）。hotfix は `prod` から作って `staging`・`dev` に戻す。各環境では、ブランチを進める前に DB を更新する |
| リポジトリ | 両リポジトリとも公開。作成者のメールは GitHub の noreply（`3047545+Otazoman@users.noreply.github.com`）。アカウント ID などはコミットしない |
| Azure の入り口 | Front Door は保留し、Application Gateway のまま Let's Encrypt を自動更新（2026-11-01）。理由: Front Door は転送先の自己署名証明書を受け付けない、Container Apps の IP 制限はサービスタグを使えない、Private Link 経由の送信元 IP が公式に不明で、「Application Gateway だけ許可」の制限を組めるか確定できない。WAF の強化（API-25）が必要になったら、送信元 IP の扱いを確かめてから再検討（Premium は月約 340 ドル、今の Application Gateway は約 200 ドル。目安） |

## 5. 構築と確認の手順

**構築（cdktn の `docs/operations.md`「環境を構築する」と同じ。アプリ側は `docs/getting-started.md` の 2〜3 章）**

| # | どこで | すること |
|---|---|---|
| 0 | 設定ファイル | Cloud SQL の名前を新しい日時に（`config/google/cloudsql/cloudsql.ts`） |
| 1 | cdktn のコンテナ | `npm run build-stage`（段階 1）→ `cdktn diff` → `cdktn deploy` |
| 2 | 3 クラウド | `scripts/secrets-set.sh aws\|google\|azure`（Azure は AWS の VM から SSH で Azure の VM へ） |
| 3 | cdktn のコンテナ | `npm run build-stage -- 2 --azure-db-ip <IP>`（プライベート DNS なし。IP の調べ方は cdktn の operations）→ `cdktn deploy` |
| 4 | AWS の VM | deploy の出力 `cluster-setup-hosts` の 1 行を前に付けて `scripts/cluster-setup.sh aws` |
| 5 | 各クラウド | パイプラインを手で 1 回実行（構築の直後はマージするものがない） |
| 6 | cdktn のコンテナ | `npm run build-stage -- 3` → `cdktn deploy`（死活監視もここで作られる。us-east-1 の SNS の購読の確認メールを承認） |
| 7 | 自分の端末 | `cdktn output` の `api-health-urls` で当日の URL を確認し、`/healthz`・`/readyz`、各クラウドで書き込み 3 クラウドから読む |
| 後片付け | cdktn のコンテナ | `npm run before-destroy` → `cdktn destroy` |

**確認のコマンド**

- 削除ジョブ（一晩残すと約 20 ドルかかるので手で起動する）:

  ```bash
  # Google（Cloud Shell）
  gcloud scheduler jobs run multicloud-google-journal-prune --location=asia-northeast1
  gcloud logging read 'resource.type="cloud_run_job" AND textPayload:"journal"' --freshness=15m --limit=5 --format='value(textPayload)'
  # Azure
  az containerapp job start -g rg_multicloud -n multicloud-azure-journal-prune
  az containerapp job execution list -g rg_multicloud -n multicloud-azure-journal-prune --query '[0].{name:name,status:properties.status}' -o table
  # AWS（EventBridge Scheduler には今すぐ実行がない。一時的に 5 分ごとにし、確認後 cron(0 3 * * ? *) に戻す）
  aws scheduler get-schedule --region ap-northeast-1 --name multicloud-aws-journal-prune --output json \
    | jq '{Name, GroupName, ScheduleExpression: "rate(5 minutes)", ScheduleExpressionTimezone, FlexibleTimeWindow, Target, State}' > /tmp/prune.json
  aws scheduler update-schedule --region ap-northeast-1 --cli-input-json file:///tmp/prune.json
  aws logs filter-log-events --region ap-northeast-1 --log-group-name /aws/ecs/api-service \
    --filter-pattern '"journal rows"' --start-time $(( ($(date +%s) - 900) * 1000 )) --query 'events[].message' --output text
  ```

  成功すると `Deleted N journal rows older than 30 days on <primary> (epoch N)`（0 件でも成功）。
- アラートを鳴らす: Google は `gcloud run jobs execute multicloud-google-journal-prune --region=asia-northeast1 --update-env-vars=JOURNAL_RETENTION_DAYS=invalid`。AWS はロググループ `/aws/ecs/api-service` に `aws logs put-log-events` で `Journal pruning failed: alert test` を 1 行書く（`api-errors` も鳴る）。Azure は §6 の注意のとおり `job start` の上書きでは試せない。
- 死活監視: AWS `aws route53 get-health-check-status --health-check-id <id>`、`aws cloudwatch describe-alarms --region us-east-1`。Google `gcloud monitoring uptime list-configs`（コンソールで各地域が緑か）。Azure は Log Analytics で `AppAvailabilityResults | where TimeGenerated > ago(1h) | summarize count() by Location, Success`。
- 複数台: 台数（`aws ecs describe-services`、Cloud Run の起動ログの `Primary:` の数、`az containerapp replica list`）、各クラウドへ同時に書き込み、同じ冪等キーで 3 クラウドから同時に送って id が 1 つになるか。
- DB の状態: `scripts/cluster-setup.sh <cloud> --status`。強制切り替えと復帰の手順は `docs/operations.md`「Switchover」「Removing a node」「Adding a removed node back」。

## 6. 運用で分かった注意点

**構築・destroy**

- ALB の DNS 名は構築のたびに変わる。確認には `cdktn output` の `api-health-urls` を使う。Cloud SQL の IP も構築ごとに変わる（`.3`・`.5` など）。Azure の DB はふだん `10.2.32.4`、HA のフェイルオーバーで `.5` に変わる（プライベート DNS なしでは記録し直す）。
- 段階 3 の deploy は API のビルドの後に行う。先に行うと、仮のイメージが `/readyz` に落ちて AWS のデプロイが待ちきれず、ビルドが失敗扱いになる。
- 最初の deploy で CodeBuild の `OAuthProviderException` が出ることがある（再実行で通る）。
- Google の destroy は、PSA の接続（Cloud SQL を消した後も使用中とされる）と Cloud Run のサブネット（内部 IP の解放に 1〜2 時間）で止まる。PSA の接続と VPC ピアリングを手で消し、時間をおいて再実行する。実物を手で消したリソースが state に残ったら `terraform state rm`。
- Azure の DB のパラメータは `npm run before-destroy` が state から外す（論理レプリケーションのスロットがあると `wal_level` を戻せず destroy が止まるため）。
- 段階 3 でしか作らないリソースのプロバイダー（AWS の us-east-1）は、段階 1 でも定義しておく必要がある（destroy は段階 1 で合成するため）。

**シークレット・作業用 VM**

- AWS の VM では `aws login` に `--remote` が必要。Google の VM では自分のアカウントで `gcloud auth login`（VM の既定のサービスアカウントは権限が足りない）。Cloud Shell では先に `gcloud config set project`。
- `cluster-setup.sh` は、export 済みの `NODE_<N>_ADMIN_PASSWORD` をそのまま使う（打ち間違いを export するとログインに失敗し続ける）。作業の後は unset し、CLI からサインアウトする。
- SNS の購読は確認のメールを承認するまで届かない。死活監視のアラームは us-east-1 の別のトピックで、確認のメールも別に届く。

**DB・レプリケーション**

- 管理者ユーザー: Aurora `root`、Cloud SQL `root`、Azure `azuredbadmin`。どれもスーパーユーザーではないが、`pg_signal_backend` のメンバーで `pg_terminate_backend` を使え、`pg_replication_origin_status` を読める。
- **Cloud SQL と Azure の管理者はレプリケーションのスロットを削除できない**（Aurora はできる）。`app_repl` で削除する。
- Cloud SQL の管理者はサブスクリプションの接続文字列を読めないので、`replication-setup.sh` は毎回 `update connection` になる（一瞬の再接続だけで問題なし）。
- `journal-diff.sh` は、書き込みを止めてから実行する（止めないと、届いている行を「欠けている」と表示する）。`SINCE` は日付とタイムゾーンつき（`2026-11-23 15:20+09`）。
- 戻したノードの状態は `cluster-setup.sh` では配り直されない（プライマリが変わらないため）。最後に `switchover.sh <現在のプライマリ>`。
- 戻すときの `copy_data` の WARNING（別の origin のデータをコピーするかもしれない）は想定内。
- Azure の HA でスロットを引き継ぐには、`sync_replication_slots`・`hot_standby_feedback` とサブスクリプションの `failover = true`（cdktn とアプリで常に有効）。

**監視**

- Application Insights を作ると、Azure がアクション グループ `Application Insights Smart Detection`（グローバル）を自動で作り、destroy で消えない。消すには `az monitor action-group delete -g rg_multicloud -n "Application Insights Smart Detection"`。自動で作られたリソースを探すときは、種類の名前で絞らずに `az resource list -g rg_multicloud` を見る。
- Azure の `az containerapp job start --image --env-vars` は、その実行のコンテナの定義をまるごと置き換える（コマンドと他の環境変数が消える）。
- Log Analytics の `has` は空白を含む文字列でも一致する。ログが届くまで数分かかる。
- Azure の可用性テストの地点は、Microsoft の推奨が 5 地点以上・`locationCount - 2` 地点の失敗で通知（cdktn の `uptimeCheck.locationCount` で変えられる。dev は 3 地点・2 地点）。
- Azure の Let's Encrypt は、同じ名前の証明書が 7 日に 5 枚まで（作り直すたびに 1 枚使う）。
