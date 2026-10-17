# 運用

[English](operations.md)

デプロイ済み環境での作業手順です。スクリプトは [getting-started.ja.md](getting-started.ja.md) で説明した
ホストから実行します（ノード設定は `replication/nodes.env`、パスワードはシェルで export）。
どのスクリプトも、先にローカルの compose 環境で試せます
（`docker compose run --rm tools scripts/<script>.sh`）。ローカルでは、環境変数は `-e` で渡し
（例：`-e SEED_FROM=aws`）、データベースを意図的に止めている間は `--no-deps` を付けてください。
付けないと `docker compose run` がそのデータベースを起動し直します。

## スキーマ変更（マイグレーション）

論理レプリケーションは DDL を複製しません。すべてのノードにすべてのマイグレーションを適用する必要があります。

1. モデル定義からマイグレーションを生成します（`npm run generate`、[models.ja.md](models.ja.md)）。
   生成されない変更の場合は、新しいファイル `migrations/NNNN_description.sql`（次の番号）を手で追加します。
   どこかで適用済みの可能性があるマイグレーションは絶対に編集しないでください。
2. 稼働中の API と互換性を保ちます。テーブルや、NULL 許可・既定値付きの列を先に追加し、
   それを使う API は後からデプロイします。
3. 全ノードに適用します：

   ```bash
   scripts/migrate.sh
   ```

4. テーブルを追加した場合は、API がそのテーブルに書き込む**前に**レプリケーションの対象に含めます：

   ```bash
   scripts/replication-setup.sh
   scripts/replication-status.sh
   ```

5. API をデプロイします（[リリース](#リリース)）。API が呼ぶ関数を追加した場合は、先に
   `scripts/api-role-setup.sh` を実行します。新しい API は、マイグレーションが足りないノードでは
   準備完了になりません（`/readyz` が `503`）。

順番が重要な理由：まだ存在しないテーブルや列への変更を受け取ると、そのノードでは適用に失敗し、
マイグレーションが適用されるまでそのサブスクリプションが止まります。

列の削除やリネーム：先にその列を使わない API をデプロイし、その後で全ノードにマイグレーションを適用します。

## リリース

コードは、ローカルの feature ブランチから各環境へ、プルリクエストで進めます。環境ごとに、それぞれのブランチから
デプロイします（トリガーはインフラのリポジトリが設定します）：

| ブランチ | デプロイ先 | 更新の方法 |
| --- | --- | --- |
| `feature/*`、`hotfix/*` | なし | 自分で push |
| `dev` | dev 環境 | `feature/*` からのプルリクエスト |
| `staging` | stg 環境 | `dev` からのプルリクエスト |
| `prod` | prod 環境 | `staging`（または `hotfix/*`）からのプルリクエスト |
| `main` | なし。prod にリリースしたコード | `prod` からのプルリクエスト |

```
feature/* --PR--> dev --PR--> staging --PR--> prod --PR--> main
（ローカル）      dev 環境     stg 環境        prod 環境    （記録）
```

GitHub のブランチのルールで、`dev`・`staging`・`prod`・`main` はプルリクエストが必須で、強制 push と削除は
拒否されます。`staging`・`prod`・`main` で使えるマージ方法は **Create a merge commit** だけです。squash や
rebase ではブランチの履歴が別々になり、次の昇格で衝突します。マージコミットはブランチごとに違うため、
`/healthz` の `version` は環境ごとに違います。同じ環境の中では、すべてのクラウドで同じでなければなりません。

例では GitHub CLI（`gh`）を使います。github.com の画面でも同じことができます。

### 1. ローカルで開発する

```bash
git switch dev && git pull
git switch -c feature/<name>
# ... コード / models/*.yaml / migrations を変更 ...
npm run generate               # models/*.yaml を変更したとき（docs/models.ja.md）
npm run typecheck && npm test
```

続けて、ローカルの compose 環境で変更を確認します（README の「ローカルテスト」）。API を再ビルドし、
新しいマイグレーションを適用し、変更に必要なスクリプトを実行します：

```bash
docker compose up -d --build
docker compose run --rm tools scripts/migrate.sh
docker compose run --rm tools scripts/replication-setup.sh   # テーブルを追加したとき
docker compose run --rm tools scripts/api-role-setup.sh      # API 用の関数を追加したとき
curl localhost:8081/readyz                                   # すべての API（8081〜8083）で 200
```

書き込み、SQL、マイグレーション、スクリプトの変更では、プライマリ以外の API からの書き込みも確認します。
書き込みの経路を変えた場合は切り替えも試します（README）。

push して、`dev` へのプルリクエストを作ります：

```bash
git push -u origin feature/<name>
gh pr create --base dev --title "<変更内容>" --body "<理由、マイグレーション、実行するスクリプト>"
```

プルリクエストには、リリースに必要なデータベースの作業（新しいマイグレーション、`replication-setup.sh`、
`api-role-setup.sh`）を書きます。どの環境でも、ブランチを進める前に行う必要があります。

### 2. 環境にリリースする（dev、stg、prod）

どの環境でも同じ手順を、dev（feature のプルリクエストをマージ）→ stg（`dev` → `staging`）→ prod
（`staging` → `prod`）の順に行います。

1. **先にその環境のデータベースを更新します。** リリースにマイグレーションが含まれる場合、その環境の
   スクリプト用ホスト（[getting-started.ja.md](getting-started.ja.md)）から実行します：

   ```bash
   git fetch && git switch --detach origin/<リリースするブランチ>   # 例：stg のリリースの前なら origin/dev
   scripts/migrate.sh
   scripts/replication-setup.sh && scripts/replication-status.sh   # テーブルを追加したとき
   scripts/api-role-setup.sh                                       # API 用の関数を追加したとき
   ```

   API は起動時にモデルから SQL を組み立てるため、新しいテーブルや列を使う版はこの前には動きません。
   忘れた場合、新しい版の `/readyz` は `503` のままで、コンテナ基盤は古い版でサービスを続けます。
   マイグレーションは追加のみなので、稼働中の版はこの手順の後も動きます。

2. **その環境のプルリクエストをマージします：**

   ```bash
   # dev：feature のプルリクエストをマージ
   gh pr merge <番号> --merge --delete-branch
   # stg / prod：昇格のプルリクエストを作ってマージ
   gh pr create --base staging --head dev --title "Release to stg" --body ""
   gh pr create --base prod --head staging --title "Release to prod" --body ""
   gh pr merge <番号> --merge
   ```

   各クラウドがイメージをビルドし（ビルドでテストを実行し、失敗すれば止まる）、デプロイします：
   AWS CodeBuild → ECS、Cloud Build → Cloud Run、Azure Pipelines → Container Apps。

3. **その環境のすべてのクラウドで確認します：**

   ```bash
   curl https://<endpoint>/healthz   # 3 クラウドで同じ "version"
   curl https://<endpoint>/readyz    # 200
   ```

   プライマリ以外のクラウドの API からの書き込みも確認します（README の「API を確認する」）。

4. 一部のクラウドだけ失敗した場合は、原因を直してそのクラウドのビルドを再実行します（CodeBuild、
   Cloud Build のトリガー、Azure Pipelines）。マイグレーションが追加のみの間は、新旧の版が混在しても動きます。

5. 次の環境に進む前に、この環境で変更を十分に確認します（機能、性能、ログ）。

### 3. リリースを `main` に記録する

prod の確認が済んだら：

```bash
gh pr create --base main --head prod --title "Released to prod" --body ""
gh pr merge <番号> --merge
git fetch && git tag vX.Y.Z origin/main && git push origin vX.Y.Z   # 任意
```

`main` はビルドを起動しません。prod に入っているものを示します。

### 列やテーブルの削除

削除は、その列やテーブルを使わない版をすべての環境に出した**次の**リリースで、手書きのマイグレーションとして
行います（[models.ja.md](models.ja.md)）。そうしないと、マイグレーションを適用した時点で稼働中の版が失敗します。

### 戻すとき

環境のブランチで、プルリクエストで revert します。前の版が再デプロイされます：

```bash
git switch -c revert/<name> origin/<ブランチ>
git revert -m 1 <マージコミット>     # そのリリースのマージコミット
git push -u origin revert/<name>
gh pr create --base <ブランチ> --title "Revert <リリース>" --body ""
```

データベースの変更はそのまま残します（追加のみで、前の版は無視します）。前のブランチ（例：`dev`）には
変更が残っているので、そこで直して通常どおり昇格します。revert はその環境のブランチに残るため、後で同じ変更を
もう一度リリースするときは、`dev` で revert を revert して昇格します。

### 緊急の修正（hotfix）

```
prod --> hotfix/* --PR--> prod --PR--> main
                            \--PR--> staging --PR--> dev
```

```bash
git switch -c hotfix/<name> origin/prod
# ... 修正、npm run typecheck && npm test、ローカルで確認 ...
git push -u origin hotfix/<name>
gh pr create --base prod --title "Hotfix: <内容>" --body ""
```

先に stg で確認する場合は、`prod` の前に `staging` にマージします。データベースの作業はリリースと同じです
（手順 2 の 1）。リリースの後、次の昇格で修正が消えないよう、修正を戻します：

```bash
gh pr create --base staging --head prod --title "Back-merge hotfix" --body ""
gh pr create --base dev --head staging --title "Back-merge hotfix" --body ""
```

これらもマージコミットでマージし、prod を `main` に記録します（3）。

## レプリケーションの監視

```bash
scripts/replication-status.sh
```

| 項目 | 正常 | 注意すべき状態 |
| --- | --- | --- |
| cluster state | 全ノードで `primary_node` と `epoch` が同じ | 世代番号が小さいノードがある：`scripts/switchover.sh <現在のプライマリ>` を実行 |
| subscriptions | `enabled = t`、`latest_end_time` が最近 | `latest_end_time` が古い：パブリッシャーに接続できないか、適用ワーカーが失敗を繰り返している |
| replication slots | `active = t`、`retained_wal` が小さい | `active = f` で `retained_wal` が増え続ける：サブスクライバーが停止しており、このノードに WAL が溜まっている |
| apply errors | `0` | 件数が増えている：「適用エラー」を参照 |

他のノードが停止している間、すべてのノードで `retained_wal` が増えます。長時間の障害中はデータベースのディスク使用量を監視してください。

## 適用エラー

受け取った変更を適用できない場合（テーブルや列がない、制約違反など）、サブスクリプションの適用ワーカーは
停止・再起動して同じ変更を再試行します。そのノードでは、それ以降の変更も適用されません。

1. サブスクライバー側データベースのログ（各クラウドのログサービス）でエラーを確認します。
2. 原因を取り除きます。テーブルや列がない場合は、そのノードで `scripts/migrate.sh` を実行します。
3. ワーカーは次の再試行で自動的に再開します。

変更のスキップ（`ALTER SUBSCRIPTION ... SKIP`）は、そのノードでその変更を失い、データベース間に差異が残ります。
データの修復方法を決めてから行ってください。

## クラウド障害

**セカンダリ（プライマリ以外）の障害**

- そのクラウドの API は読み取りができなくなります（`/readyz` が失敗）。他のクラウドは読み書きを
  継続します。書き込みの確認は、残ったセカンダリが行います。
- 他のノードは障害ノード向けの WAL を保持し続けます（`retained_wal`）。ディスク使用量を監視してください。
- ノードが復旧すると、サブスクリプションは自動で再接続し、遅れを取り戻します。その間に切り替えが
  あった場合は、`scripts/switchover.sh <現在のプライマリ>` を実行して現在の状態を反映します。

**プライマリの障害**

- 書き込みは `PRIMARY_UNAVAILABLE` で失敗します（リクエストごとに最大 5 秒の接続タイムアウトの後）。
  読み取りは他のクラウドで継続します。
- 強制切り替え（後述）でプライマリを移します。`PRIMARY_REFRESH_INTERVAL_MS` 以内に書き込みが再開します。

障害が長引き、保持している WAL で他のデータベースのディスクが逼迫しそうな場合は、障害ノードを
レプリケーションから外し（後述）、後で戻します（「外したノードを戻す」を参照）。

## 切り替え

プライマリは書き込みを受け付けるノードです（[architecture.ja.md](architecture.ja.md#書き込み)）。
`scripts/replication-status.sh` で、各ノードから見たプライマリ（cluster state）を確認できます。

### 初回設定

`replication-setup.sh` の後、すべてのノードに接続できる状態で実行します：

```bash
scripts/switchover.sh <node>
```

### 計画的な切り替え

現在のプライマリが稼働している場合（メンテナンス、利用者に近いクラウドへの移動、リハーサルなど）：

```bash
scripts/switchover.sh <target>
```

まず旧プライマリが書き込みの受け付けを止め、次に切り替え先がすべてを確定するのを待ち
（最大 `CATCHUP_TIMEOUT`、既定 60 秒）、その後で他のノードが新しい状態になります。書き込みが
`PRIMARY_UNAVAILABLE` で失敗するのは 1 秒程度です。待ちがタイムアウトした場合は、どのノードも
書き込みを受け付けない状態になります。スクリプトを再実行するか、旧プライマリが使えないなら `--force` を使います。

### 強制切り替え

現在のプライマリが停止している、または他のデータベースから切り離されていて計画的な切り替えが完了しない
場合です。スクリプトを実行するホストから旧プライマリに接続できる場合は、スクリプトが先にその書き込みを
止めます。接続できない場合は、本当に停止または切り離されていることを確認してから（どちらの場合も書き込みの
確認はできませんが、そのクラウドの API からは接続できている可能性があります）、実行します：

```bash
scripts/switchover.sh --force <target>
```

- スクリプトは、接続できる各ノードが旧プライマリから受け取った量を表示します。切り替え先は最も多く
  受け取ったノードでなければならず、そうでなければ停止します（他のノードだけが確認した書き込みが
  欠けるため）。`--allow-behind` でこのチェックを無視できます。
- 接続できる各ノードで、旧プライマリからのサブスクリプションを無効にします（旧プライマリの未確認の
  書き込みが後から届いて、新しいデータを上書きしないように）。そのうえで新しい状態を設定します。
- 「切り替え先より受け取った量が少ないノードがある」と警告された場合、そのノードには旧プライマリの
  書き込みの一部が永久に欠けています（ノード間で変更は転送されません）。欠けている書き込みは
  `scripts/journal-diff.sh <切り替え先> <遅れているノード>` で一覧にできます。そのノードを初期化してください
  （「ノードの削除」→「外したノードを戻す」）。

### 強制切り替えの後

旧プライマリをそのまま戻してはいけません。確認されなかった書き込み（クライアントには
`COMMIT_UNCONFIRMED` が返ったか、応答がなかったもの）を持っている可能性があります。復旧したら：

1. 他のノードに届かなかった書き込みを、引数と結果つきで一覧にし、出力を保存します：

   ```bash
   SINCE='<障害より前の時刻>' scripts/journal-diff.sh <旧プライマリ> <現在のプライマリ>
   ```

   これらの書き込みについて、クライアントには `COMMIT_UNCONFIRMED`（または応答なし）が返っています。
   同じ冪等キーで再送したものは、新しいプライマリで書き込み済みです。それ以外は内容を確認し、
   必要なら API から再度送ります。
2. 外して（「ノードの削除」）、戻します（「外したノードを戻す」）。これでデータが初期化されます。

### 切り替え中に接続できなかったノード

新しい状態を受け取るまでは古い状態のままです：

```bash
scripts/switchover.sh <現在のプライマリ>
```

その間も API は誤りません。見えている中で最も大きい世代番号を使うためです。

## 変更履歴（ジャーナル）

`app.write_journal` は書き込み1件につき1行ずつ増えます。古い行を定期的に削除してください
（例：スクリプト用ホストで毎日実行するジョブ）：

```bash
DAYS=30 scripts/journal-prune.sh
```

削除はプライマリでのみ実行されます（削除は他ノードに複製されます）。`DAYS` は冪等キーの有効期間でもあります。
クライアントが再送する可能性のある期間より長くしてください。

## ノードの追加

1. `replication/nodes.env` の `NODES` にノードを追加し、`NODE_<N>_*` を設定します。
2. 新しいノードにマイグレーションを適用し、API ロールを作成します：

   ```bash
   scripts/migrate.sh <new>
   scripts/api-role-setup.sh <new>
   ```

3. **全ノードで書き込みを止めます**（API サービスを停止）。止めないと、コピー中に書き込まれた行が新しいノードに入らないことがあります。
4. 既存ノードの1つから既存の行をコピーしつつ、サブスクリプションを作成します：

   ```bash
   SEED_FROM=<existing> scripts/replication-setup.sh
   scripts/replication-status.sh
   ```

5. 新しいノードに現在のプライマリを設定します：

   ```bash
   scripts/switchover.sh <現在のプライマリ>
   ```

6. 新しいノードにデータが入るのを待ってから（初期コピーはバックグラウンドで実行されます）、新しいノードを含めて API を再開します。
7. クラスタにとって新しいノード（戻したノードではない）の場合は、他のすべての API の `PEER_NODES` と
   `DB_<NODE>_*` にそのノードを追加し、そのノードの API も他のノードを `PEER_NODES` に入れてデプロイします。

## ノードの削除

専用のスクリプトはありません。プライマリは削除しないでください（先に切り替えます）。

1. 削除するノードに接続できる場合は、先にそのノード自身のサブスクリプションを削除します
   （他ノード上の対応するスロットも削除されます）：

   ```sql
   DROP SUBSCRIPTION mc_sub_<other>_to_<removed>;   -- 他の各ノードについて
   ```

2. **残る各ノード**で、管理者ユーザーとして実行します：

   ```sql
   -- 削除するノードからの受信を止める。
   -- 削除するノードに接続できない場合は、先にスロットを切り離す：
   ALTER SUBSCRIPTION mc_sub_<removed>_to_<this> DISABLE;
   ALTER SUBSCRIPTION mc_sub_<removed>_to_<this> SET (slot_name = NONE);
   DROP SUBSCRIPTION mc_sub_<removed>_to_<this>;

   -- 削除するノード向けの WAL の保持をやめる（手順 1 で削除済みなら不要）。
   -- 切り離されたノードは wal_sender_timeout（1 分）の間スロットを使用中のまま
   -- にしていることがあるので、先にその接続を終了する。
   SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots
    WHERE slot_name = 'mc_sub_<this>_to_<removed>' AND active;
   SELECT pg_drop_replication_slot('mc_sub_<this>_to_<removed>');
   ```

3. `NODES` からノードを外します。

## 外したノードを戻す

外したノードのデータは古く、古いサブスクリプションも残っています。初期化してから、新しいノードとして追加します。

1. 外したノードで、管理者ユーザーとして実行します（他ノード側の古いスロットは削除済みなので、切り離してから削除します）：

   ```sql
   SELECT format('ALTER SUBSCRIPTION %I DISABLE', subname)
     FROM pg_subscription WHERE subname LIKE 'mc\_sub\_%' \gexec
   SELECT format('ALTER SUBSCRIPTION %I SET (slot_name = NONE)', subname)
     FROM pg_subscription WHERE subname LIKE 'mc\_sub\_%' \gexec
   SELECT format('DROP SUBSCRIPTION %I', subname)
     FROM pg_subscription WHERE subname LIKE 'mc\_sub\_%' \gexec
   SELECT pg_drop_replication_slot(slot_name)
     FROM pg_replication_slots WHERE slot_name LIKE 'mc\_sub\_%';
   -- パブリケーションは TRUNCATE を公開しないが、パブリケーションも削除して
   -- このノードから他ノードに何も届かないようにする（replication-setup.sh が作り直す）
   DROP PUBLICATION IF EXISTS mc_pub;
   TRUNCATE app.items, app.write_journal;   -- スキーマ "app" のすべてのテーブル
   ```

   このノードで書き込まれ、他ノードに届いていなかった行はこの手順で失われます。必要なら先にエクスポートしてください。

2. 「ノードの追加」の手順 1 から実施します。

## パスワード

- **API ロール：** 全ノードの `app_api` は同じパスワードで、すべてのクラウドのシークレット `db-api-password` に
  あります（[getting-started.ja.md](getting-started.ja.md)）。新しいパスワードをすべての `NODE_<N>_API_PASSWORD` に
  設定して `scripts/api-role-setup.sh` を実行し、すべてのクラウドのシークレットストアの `db-api-password` を
  更新してから、すべての API を再起動します（新しいデプロイ。コンテナ基盤はコンテナの起動時にシークレットを
  読みます）。再起動までは既存の接続は使えますが、新しい接続は失敗します。利用の少ない時間に、手順の間を
  空けずに行ってください。
- **レプリケーションロール：** `NODE_<N>_REPL_PASSWORD` を変更して `scripts/replication-setup.sh` を
  実行します。ロールのパスワードを更新し、それを使うサブスクリプションの接続文字列も更新します。
  この2つの間は該当するサブスクリプションが再接続できないため、他に確認できるノードがなければ
  書き込みが `COMMIT_UNCONFIRMED` になることがあります。

## ローカル環境のリセット

```bash
docker compose down -v
docker compose up -d --build
```

その後、データベースのセットアップを再度行います（README の「ローカルテスト」）。
