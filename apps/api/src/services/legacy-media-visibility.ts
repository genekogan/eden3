import type { PgClient } from '@eden3/db';

const LEGACY_MEDIA_PATH = /^\/media\/([0-9a-f]{64})(\.[a-z0-9]{1,10})?$/;

/**
 * Fail-closed serving decision for the legacy flat content-addressed store.
 * A byte stays visible while any live, non-erasing association references it;
 * once every known association is covered by an active erasure target it is
 * hidden immediately, before asynchronous physical disposition completes.
 */
export async function legacyMediaIsPubliclyReachable(
  client: PgClient,
  requestPath: string,
): Promise<boolean> {
  const match = LEGACY_MEDIA_PATH.exec(requestPath);
  if (!match) return false;
  const sha256 = match[1]!;
  const [row] = await client<{ known: boolean; live: boolean; erasing: boolean }[]>`
    with matching_media as (
      select m.id
      from media_assets m
      where m.sha256=${sha256}
        or m.url=${requestPath}
        or right(m.local_path,length(${requestPath})-length('/media/'))=substring(${requestPath} from length('/media/')+1)
    ), matching_concepts as (
      select i.id
      from concept_images i
      where i.sha256=${sha256} or i.url=${requestPath}
    ), matching_avatars as (
      select av.id,av.agent_account_id,av.state
      from agent_avatar_assets av
      where av.sha256=${sha256} or av.url=${requestPath}
    ), erasing_media as (
      select m.id from matching_media m
      where exists (
        select 1 from account_erasure_targets t
        join account_erasure_jobs j on j.id=t.job_id
        where t.kind='legacy_media_asset' and t.resource_id=m.id and j.state<>'succeeded'
      )
    ), erasing_concepts as (
      select i.id from matching_concepts i
      where exists (
        select 1 from account_erasure_targets t
        join account_erasure_jobs j on j.id=t.job_id
        where t.kind='legacy_concept_asset' and t.resource_id=i.id and j.state<>'succeeded'
      )
    ), erasing_avatars as (
      select av.id from matching_avatars av
      where exists (
        select 1 from account_erasure_targets t
        join account_erasure_jobs j on j.id=t.job_id
        where t.kind='legacy_avatar_asset' and t.resource_id=av.id and j.state<>'succeeded'
      )
    ), live_avatars as (
      select 1 from matching_avatars av
      join accounts a on a.id=av.agent_account_id
      where av.state='current' and a.deleted=false and a.user_image=${requestPath}
        and not exists(select 1 from erasing_avatars e where e.id=av.id)
      limit 1
    ), live_avatar_pointers as (
      select 1 from accounts a
      where a.user_image=${requestPath} and a.deleted=false
      limit 1
    ), live_creations as (
      select 1
      from creations c
      left join accounts u on u.id=c.user_id
      left join accounts a on a.id=c.agent_id
      where (c.url=${requestPath} or c.thumbnail_url=${requestPath})
        and c.deleted=false
        and coalesce(u.deleted=false,a.deleted=false,false)
      limit 1
    )
    select
      (exists(select 1 from matching_media) or exists(select 1 from matching_concepts)
        or exists(select 1 from matching_avatars) or exists(select 1 from live_avatar_pointers)
        or exists(select 1 from creations where url=${requestPath} or thumbnail_url=${requestPath})) as known,
      (exists(select 1 from matching_media m where not exists(select 1 from erasing_media e where e.id=m.id))
        or exists(select 1 from matching_concepts i where not exists(select 1 from erasing_concepts e where e.id=i.id))
        or exists(select 1 from live_avatars) or exists(select 1 from live_avatar_pointers)
        or exists(select 1 from live_creations)) as live,
      (exists(select 1 from erasing_media) or exists(select 1 from erasing_concepts)
        or exists(select 1 from erasing_avatars)) as erasing
  `;
  // Unknown legacy files retain their historical behavior. A known file is
  // visible only while at least one live association remains; retired avatar
  // history is durable custody, not a public reference. A foreign live
  // association keeps a shared content address reachable.
  return row ? !row.known || row.live : false;
}

export const LEGACY_MEDIA_CANONICAL_PATH = LEGACY_MEDIA_PATH;
