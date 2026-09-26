/**
 * The same documents `harness:prepare` places in test-vault/Fixtures: the static
 * Markdown from tests/fixtures and the generated 10/100/500/2,000 node files.
 */
import headingDocument from "../../tests/fixtures/heading-document.md?raw";
import roundtripEdgeCases from "../../tests/fixtures/roundtrip-edge-cases.md?raw";
import unevenBranches from "../../tests/fixtures/uneven-branches.md?raw";
import freeTopics from "../../tests/fixtures/free-topics.md?raw";
import embedHost from "../../tests/fixtures/embed-host.md?raw";
import embedTimeline from "../../tests/fixtures/embed-timeline.md?raw";
import embedHierarchy from "../../tests/fixtures/embed-hierarchy.md?raw";
import embedNodes from "../../tests/fixtures/embed-nodes.md?raw";
import embedCycle from "../../tests/fixtures/embed-cycle.md?raw";
import timelineStages from "../../tests/fixtures/timeline-stages.md?raw";
import sampleImage from "../../tests/fixtures/sample-image.svg?raw";
import { makeEmbedFixture, makePerformanceFixture, performanceFixtureMatrix } from "../../scripts/performance-fixtures.mjs";

export interface HarnessFixture {
  /** Stable identifier for the `?fixture=` query and the automation API. */
  id: string;
  /** Vault path, matching test-vault/Fixtures. */
  path: string;
  label: string;
  /** What this document exercises; shown on the page. */
  covers: string;
  source: string;
  /** Generated performance documents carry their node count and shape; static fixtures do not. */
  performance?: { nodeCount: number; shape: string };
}

export const FIXTURE_DIRECTORY = "Fixtures";

export const SAMPLE_IMAGE = {
  path: `${FIXTURE_DIRECTORY}/sample-image.svg`,
  url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sampleImage)}`,
};

const staticFixtures: HarnessFixture[] = [
  {
    id: "heading-document",
    path: `${FIXTURE_DIRECTORY}/heading-document.md`,
    label: "heading-document（従来の見出し形式）",
    covers: "日本語、H1→H2→H3 の見出し階層、内部・外部・別名・見出しリンク、Wiki 形式と Markdown 形式の画像、本文の箇条書き（ノードにしない）",
    source: headingDocument,
  },
  {
    id: "roundtrip-edge-cases",
    path: `${FIXTURE_DIRECTORY}/roundtrip-edge-cases.md`,
    label: "roundtrip-edge-cases（同名見出し・コードブロック）",
    covers: "同名見出し×2、コードブロック内の偽見出し、引用内の見出し、深さを飛ばした見出し、H6、Setext、欠落画像、参照リンク、絵文字",
    source: roundtripEdgeCases,
  },
  {
    id: "uneven-branches",
    path: `${FIXTURE_DIRECTORY}/uneven-branches.md`,
    label: "uneven-branches（H2＋リスト・不均等な枝）",
    covers: "H2＋箇条書き、8 段の一列の枝、24 兄弟、長い日本語タイトル、リンク・画像・欠落画像、本文のコードブロック、同名ノード、空に近い枝",
    source: unevenBranches,
  },
  {
    id: "free-topics",
    path: `${FIXTURE_DIRECTORY}/free-topics.md`,
    label: "free-topics（本体＋フリートピック）",
    covers: "複数の H2: 最初の区画が本体、後ろの 3 区画がフリートピック。frontmatter `mappy-topics` の位置（レイアウト別、`:` を含む引用符付きキー、孤児キー）と、位置未設定の既定配置",
    source: freeTopics,
  },
  {
    id: "embed-nodes",
    path: `${FIXTURE_DIRECTORY}/embed-nodes.md`,
    label: "embed-nodes（マップの中の呼び出し: `![[…]]` だけのノード）",
    covers: "`![[マップノート]]` だけのノードが読み取り専用のマップになる（M12、E35）: タイムライン・`#見出し` の部分木・2,000 ノード・同じマップの 2 回目・循環の相手（embed-cycle）。"
      + "自分自身・文中の埋め込み・`mappy: true` のないノート・存在しないノート・ブロック参照はリンク、画像は画像のまま",
    source: embedNodes,
  },
  {
    id: "embed-cycle",
    path: `${FIXTURE_DIRECTORY}/embed-cycle.md`,
    label: "embed-cycle（embed-nodes と互いに呼び出す）",
    covers: "embed-nodes を呼び出し、embed-nodes からも呼び出される（A ↔ B）。呼び出したマップの中の呼び出しはリンクのまま描かれ、循環しても描画が止まらない。自分自身はリンク",
    source: embedCycle,
  },
  {
    id: "timeline-stages",
    path: `${FIXTURE_DIRECTORY}/timeline-stages.md`,
    label: "timeline-stages（タイムライン: 同じ側に続くステージ）",
    covers: "`mappy-layout: timeline`。下側の深い森（末端「ビジランス効果」「ポモドーロ」）の右に同じ側の次のステージの縦線が立つ間隔（LEV-205）、上側の画像つき・幅の違う枝",
    source: timelineStages,
  },
];

const performanceFixtures: HarnessFixture[] = performanceFixtureMatrix().map(({ id, nodeCount, shape }) => {
  const [filename, source] = makePerformanceFixture(nodeCount, shape.id);
  return {
    id,
    path: `${FIXTURE_DIRECTORY}/${filename}`,
    label: `${id}（${nodeCount.toLocaleString("ja-JP")} ノード、${shape.label}）`,
    covers: `${shape.covers}。scripts/performance-fixtures.mjs が生成する ${nodeCount} ノード`,
    source,
    performance: { nodeCount, shape: shape.id },
  };
});

export const FIXTURES: readonly HarnessFixture[] = [...staticFixtures, ...performanceFixtures];

export function findFixture(id: string | null | undefined): HarnessFixture | undefined {
  return FIXTURES.find(fixture => fixture.id === id);
}

/**
 * A note that embeds maps (§5 M10), shown on the page as a rendered note instead of
 * a map view. `reading` renders the host's own sections and lets the post processor
 * replace the `![[…]]` placeholders (reading view, hover preview); `live` renders each
 * embedded note inside an Obsidian-like embed container first and hands those
 * sections to the processor (live preview); `live-late` does the same the way Obsidian
 * 1.6.7 opens a note: the sections reach the processor before the container is on
 * the document, the container joins a few frames later (or, for the last two embeds,
 * below the fold, about 1.5 s later), and a first rendering of each embed is discarded
 * without ever joining (LEV-91).
 */
export interface HarnessHost {
  id: string;
  path: string;
  label: string;
  covers: string;
  source: string;
  mode: "reading" | "live" | "live-late";
}

const [embed2000Filename, embed2000Source] = makeEmbedFixture();

/** Map notes the host embeds that are not fixtures of the map view themselves; `harness:prepare` writes the same files. */
export const EMBED_TARGETS: readonly { path: string; source: string }[] = [
  { path: `${FIXTURE_DIRECTORY}/embed-timeline.md`, source: embedTimeline },
  { path: `${FIXTURE_DIRECTORY}/embed-hierarchy.md`, source: embedHierarchy },
  { path: `${FIXTURE_DIRECTORY}/${embed2000Filename}`, source: embed2000Source },
];

const HOST_COVERS = "通常マップ（uneven-branches）・タイムライン・階層図・`#見出し` の部分木（同名見出しの最初の一致）・2,000 ノード（embed-2000）を埋め込み、"
  + "`mappy: true` のないノート・存在しないノート・ブロック参照は通常の埋め込みのまま";

export const EMBED_HOSTS: readonly HarnessHost[] = [
  {
    id: "embed-host",
    path: `${FIXTURE_DIRECTORY}/embed-host.md`,
    label: "embed-host（閲覧モード: ホストの区画を差し替え）",
    covers: `${HOST_COVERS}。閲覧モードと同じく、ホストの区画にある placeholder の span を post-processor が差し替える`,
    source: embedHost,
    mode: "reading",
  },
  {
    id: "embed-host-live",
    path: `${FIXTURE_DIRECTORY}/embed-host.md`,
    label: "embed-host-live（ライブプレビュー相当: 埋め込み内容側で差し替え）",
    covers: `${HOST_COVERS}。ライブプレビューと同じく、Obsidian が埋め込み先を描いた後にその区画から post-processor が容器を差し替える`,
    source: embedHost,
    mode: "live",
  },
  {
    id: "embed-host-live-late",
    path: `${FIXTURE_DIRECTORY}/embed-host.md`,
    label: "embed-host-live-late（ライブプレビュー相当: 容器の接続が数フレーム遅れる）",
    covers: `${HOST_COVERS}。Obsidian 1.6.7 がノートを開くときと同じく、区画は容器が document に付く前に post-processor へ届き、容器は数フレーム後（画面の下の 2 つは約 1.5 s 後）に付く。各埋め込みの 1 回目の描画は捨てられ、接続されない`,
    source: embedHost,
    mode: "live-late",
  },
];

export function findHost(id: string | null | undefined): HarnessHost | undefined {
  return EMBED_HOSTS.find(host => host.id === id);
}
