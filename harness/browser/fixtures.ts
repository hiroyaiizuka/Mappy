/**
 * The same documents `harness:prepare` places in test-vault/Fixtures: the static
 * Markdown from tests/fixtures and the generated 10/100/500/2,000 node files.
 */
import headingDocument from "../../tests/fixtures/heading-document.md?raw";
import roundtripEdgeCases from "../../tests/fixtures/roundtrip-edge-cases.md?raw";
import unevenBranches from "../../tests/fixtures/uneven-branches.md?raw";
import freeTopics from "../../tests/fixtures/free-topics.md?raw";
import sampleImage from "../../tests/fixtures/sample-image.svg?raw";
import { makePerformanceFixture, performanceFixtureMatrix } from "../../scripts/performance-fixtures.mjs";

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
