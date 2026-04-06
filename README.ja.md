[English](README.md) | [中文](README.zh.md) | **日本語**

# Obsidian LLM Wiki

[![CI](https://github.com/2233admin/obsidian-llm-wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/2233admin/obsidian-llm-wiki/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json) [![Python](https://img.shields.io/badge/python-%3E%3D3.11-brightgreen.svg)](kb_meta.py)

**AIがあなたのObsidianノートを読み、検索し、それらの上に構築できるようにします。**

[KarpathyのLLM Wiki](https://www.youtube.com/watch?v=zisonDtp3GQ)にインスピレーションを受けています。でも、今すぐインストールできます。

```
  .obsidian/vault/          MCP stdio           Claude Code
  +-----------------+      +----------+        +-----------+
  | notes/          | <--> | connector| <----> |  agent    |
  | daily/          |      |    .js   |        |           |
  | projects/       |  WS  +----------+        +-----------+
  | [[wikilinks]]   | <-->  Obsidian             Cursor
  +-----------------+       Plugin               Windsurf
```

```
あなた:    「先月分散コンセンサスについて書いたことは？」
Claude: *あなたのボルトを検索し、3つのノートを読み、[[バックリンク]]で答えを合成する*
```

Vault BridgeはあなたのObsidianボルトをMCPサーバーに変えます。任意のAIエージェント（Claude Code、Cursor、Windsurf）が接続できます。読み書き、検索、知識をコンパイル — あなたのノートを真実の源として使用します。

---

## クイックスタート

```bash
git clone https://github.com/2233admin/obsidian-llm-wiki.git
cd obsidian-llm-wiki && npm install && npm run build
node setup.js
```

`setup.js`は自動的にあなたのObsidianボルトを検出し、プラグインをインストールし、Claude CodeのMCPを設定します — すべて一度に。その後、Claudeに質問します：

```
「私のノートからReact Server Componentsについて検索して」
```

それだけです。

<details>
<summary>手動インストール（setup.jsが機能しない場合）</summary>

### 1. プラグインをインストール

`main.js`、`manifest.json`、`styles.css`をボルトの`.obsidian/plugins/vault-bridge/`にコピーし、Obsidian Settings > Community Pluginsで有効にします。

### 2. エージェントを接続

`~/.claude/settings.json`（または`.cursor/mcp.json`）に追加します：

```json
{
  "mcpServers": {
    "vault-bridge": {
      "command": "node",
      "args": ["/path/to/obsidian-llm-wiki/connector.js", "/path/to/your/vault"]
    }
  }
}
```

### 3. 確認

```bash
node demo.js
```

</details>

---

## エージェントは何ができるのか？

| 機能 | 例 |
|-----------|---------|
| **任意のノートを読む** | 「my notes/architecture-decisions.mdを読んで」 |
| **全文検索** | 「'auth middleware'を言及しているすべてのノートを見つけて」 |
| **タグで検索** | 「#project-xでタグ付けされたノートを表示して」 |
| **フロントマターをクエリ** | 「status が'in-progress'のノートをリストして」 |
| **グラフをたどる** | 「[[API Design]]にリンクしているノートは何ですか？」 |
| **ノートを作成** | 「このPRの要約をボルトに作成して」 |
| **ノートを編集** | 「今日のスタンドアップノートを日次ノートに追加して」 |
| **知識をコンパイル** | 「この論文を取り込んで私のナレッジウィキを更新して」 |
| **ヘルスチェック** | 「ボルト内の孤立したノートと壊れたリンクを見つけて」 |

すべての書き込みはデフォルトで**ドライランモード**です。エージェントが何かを変更するために明示的にオプトインする必要があります。あなたのノートは安全です。

---

## なぜVault Bridgeなのか？

|  | Vault Bridge | [obsidian-claude-code-mcp](https://github.com/iansinnott/obsidian-claude-code-mcp) | [obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api) |
|--|-------------|------------------------|------------------------|
| プロトコル | MCP + WebSocket | MCP + WebSocket | REST (HTTPS) |
| Obsidianなしで動作 | はい（ファイルシステムフォールバック） | いいえ | いいえ |
| 検索 | 全文 + タグ + フロントマター + 正規表現 | 基本的な | コンテンツ検索 |
| 知識コンパイル | 組み込み（取り込み → コンパイル → ウィキ） | いいえ | いいえ |
| グラフクエリ | リンクグラフ + バックリンク + 孤立検出 | いいえ | いいえ |
| 書き込み安全性 | デフォルトではドライラン | ガード機構なし | ガード機構なし |
| ボルトヘルス | リント（壊れたリンク、孤立、欠けたフロントマター） | いいえ | いいえ |
| バッチ操作 | はい | いいえ | いいえ |
| リアルタイムイベント | ファイル変更時にWebSocketプッシュ | いいえ | いいえ |
| 認証 | トークン + タイミング安全な比較 | トークン | APIキー + HTTPS |

---

## ナレッジコンパイルワークフロー

これは[Karpathy LLM Wiki](https://www.youtube.com/watch?v=zisonDtp3GQ)の考えを実現したものです：

```
生のソース（論文、記事、ノート）
    |
    v  [vault.init] トピックをスキャフォルド
    |
    v  ソースをraw/にドロップ
    |
    v  [kb_meta.py diff] 新しいソースを検出
    |
    v  LLMが概念、要約、関係を抽出
    |
    v  [kb_meta.py update-hash] コンパイル済みとしてマーク
    |
    v  [kb_meta.py update-index] ウィキインデックスを再構築
    |
    v  [kb_meta.py check-links] 整合性を検証
    |
[[wikilinks]]、フロントマター、カバレッジタグ付きのコンパイル済みウィキ
```

エージェントが抽出を行います。`kb_meta.py`は記簿（差分抽出、ハッシング、インデックス作成）を処理します。 — 依存関係なし、純粋Python。

---

## どのように機能するのか

```
AIエージェント  <--MCP stdio-->  connector.js  <--WebSocket-->  Obsidianプラグイン
                               |
                          (Obsidianが閉じている場合のファイルシステムフォールバック)
```

- **プラグイン**は Obsidian内でWebSocketサーバーを実行します（JSON-RPC 2.0、localhostのみ）
- **connector.js**はWebSocketにプロキシするMCPサーバーです。Obsidianが閉じている場合はボルトを直接読み込みます
- `~/.obsidian-ws-port`経由で自動検出 — 手動ポート設定は不要です

---

## APIリファレンス

MCP経由で20個のツールが利用可能です。すべてJSON-RPC 2.0を使用します。

<details>
<summary>読み取り操作</summary>

| メソッド | パラメータ | 説明 |
|--------|--------|-------------|
| `vault.read` | `path` | ノートのコンテンツを読み取る |
| `vault.list` | `path?` | ファイルとフォルダをリスト |
| `vault.stat` | `path` | ファイル/フォルダメタデータ（サイズ、日付） |
| `vault.exists` | `path` | パスが存在するかチェック |
| `vault.getMetadata` | `path` | 解析されたフロントマター、リンク、タグ、見出し |

</details>

<details>
<summary>書き込み操作（デフォルトではドライラン）</summary>

| メソッド | パラメータ | 説明 |
|--------|--------|-------------|
| `vault.create` | `path, content?, dryRun?` | 新しいノートを作成 |
| `vault.modify` | `path, content, dryRun?` | 既存ノートを上書き |
| `vault.append` | `path, content, dryRun?` | ノートに追加 |
| `vault.delete` | `path, force?, dryRun?` | ノートまたはフォルダを削除 |
| `vault.rename` | `from, to, dryRun?` | ファイルを移動/名前変更 |
| `vault.mkdir` | `path, dryRun?` | ディレクトリを作成 |

</details>

<details>
<summary>検索とグラフ</summary>

| メソッド | パラメータ | 説明 |
|--------|--------|-------------|
| `vault.search` | `query, regex?, caseSensitive?, maxResults?, glob?` | 全文検索 |
| `vault.searchByTag` | `tag` | タグ付きのノートを見つける |
| `vault.searchByFrontmatter` | `key, value?, op?` | フロントマターフィールドでクエリ |
| `vault.graph` | `type?` | リンクグラフ（ノード、エッジ、孤立） |
| `vault.backlinks` | `path` | ノートにリンクしているノートを見つける |

</details>

<details>
<summary>バッチとヘルス</summary>

| メソッド | パラメータ | 説明 |
|--------|--------|-------------|
| `vault.batch` | `operations, dryRun?` | 1回の呼び出しで複数の操作 |
| `vault.lint` | `requiredFrontmatter?` | ボルトヘルスチェック |
| `vault.init` | `topic` | ナレッジベース構造をスキャフォルド |

</details>

---

## セキュリティ

- **localhostのみ** — WebSocketは127.0.0.1にバインド、ネットワーク公開なし
- **トークン認証** — タイミング安全な比較、5秒認証タイムアウト、自動生成256ビットトークン
- **デフォルトではドライラン** — 書き込みは`dryRun: false`を渡さない限りノーオペレーション
- **パストラバーサルをブロック** — `..`セグメントは拒否、`.obsidian/`は書き込みから保護
- **接続制限** — 最大20クライアント、10MBペイロード上限、ReDoS安全正規表現
- **ファイルシステムフォールバック** — Obsidianが閉じている場合も同じセキュリティモデル

---

## Pythonコンパニオン（オプション）

| ファイル | 用途 | 依存関係 |
|------|---------|-------------|
| `kb_meta.py` | 決定論的KB操作：差分、ハッシュ、インデックス、リント、健全性 | 標準ライブラリのみ |
| `vault_bridge.py` | 非同期Python WebSocketクライアント | `websockets` |
| `mcp_server.py` | Python MCPサーバー（connector.jsの代替） | `mcp`、`websockets` |

---

## ライセンス

MIT
