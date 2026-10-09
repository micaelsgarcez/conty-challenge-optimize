import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string; raw_payload?: string };
type CreatorRow = { id: string; name: string; niches_json: string };
type ReachRow = { creator_id: string; reach: number };
type CountRow = { creator_id: string; n: number };

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT * FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  const creators = await all<CreatorRow>(db, "SELECT id, name, niches_json FROM creators");
  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const scored: CreatorMatch[] = [];

  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;

    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: 0,
      deliveries_90d: 0,
    });
  }

  if (scored.length > 0) {
    const reaches = await all<ReachRow>(
      db,
      `WITH latest AS (
         SELECT a.creator_id, m.views,
           ROW_NUMBER() OVER (PARTITION BY m.account_id ORDER BY m.captured_at DESC, m.id DESC) AS rn
         FROM social_accounts a
         JOIN metrics m ON m.account_id = a.id
         WHERE a.creator_id IN (SELECT value FROM json_each(?))
       )
       SELECT creator_id, SUM(views) AS reach FROM latest WHERE rn = 1 GROUP BY creator_id`,
      JSON.stringify(scored.map((creator) => creator.id)),
    );
    const reachById = new Map(reaches.map((row) => [row.creator_id, row.reach]));
    for (const creator of scored) creator.latest_reach = reachById.get(creator.id) ?? 0;
  }

  scored.sort(compareCreators);
  const page = scored.slice(input.offset, input.offset + input.limit);

  if (page.length > 0) {
    const counts = await all<CountRow>(
      db,
      `SELECT creator_id, COUNT(*) AS n FROM deliveries
       WHERE creator_id IN (SELECT value FROM json_each(?)) AND delivered_at >= ?
       GROUP BY creator_id`,
      JSON.stringify(page.map((creator) => creator.id)),
      deliveriesSince(),
    );
    const countById = new Map(counts.map((row) => [row.creator_id, row.n]));
    for (const creator of page) creator.deliveries_90d = countById.get(creator.id) ?? 0;
  }

  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: page,
  };
}
