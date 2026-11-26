import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { db, resetSchema, migrate } from '../db/client.js'
import { putText, sha256hex } from '../archive/store.js'
import { tokenize, toTsv } from '../domain/tokenize.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(HERE, 'data')

/** 合并所有 data/*.js 导出的数据集 */
async function loadDatasets() {
  let files = []
  try {
    files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.js')).sort()
  } catch {
    return { sources: [], places: [], persons: [], events: [], relations: [], tech: [], boundaries: [], dynasties: [], files: [] }
  }

  const merged = { sources: [], places: [], persons: [], events: [], relations: [], tech: [], boundaries: [], dynasties: [], files: [] }

  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(DATA_DIR, f)).href)
    const ds = mod.default && typeof mod.default === 'object' ? mod.default : mod
    for (const key of ['sources', 'places', 'persons', 'events', 'relations', 'tech', 'boundaries', 'dynasties']) {
      if (Array.isArray(ds[key])) merged[key].push(...ds[key])
    }
    merged.files.push(f)
  }
  return merged
}

const uniqBy = (arr, key) => {
  const map = new Map()
  for (const item of arr) if (item && item[key] != null) map.set(item[key], item)
  return [...map.values()]
}

function searchTextOf(ev) {
  return [ev.title, ev.summary, ev.category, ev.discipline, ev.place_slug]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/**
 * 全文检索列的词串（见 domain/tokenize.js）。
 *
 * 字段集合与 `searchTextOf()` **保持一致**（title + summary + category + discipline +
 * place_slug），这样 `search_tsv @@ tsquery` 与 `search_text LIKE '%q%'` 的命中集合
 * 才对得上；若只索引 title/summary，按 category/discipline 检索会大面积失效
 * （实测：q=科技 211→2、q=军事 198→13、q=灾难 11→0）。
 */
function searchTsvOf(ev) {
  return toTsv(tokenize(
    [ev.title, ev.summary, ev.category, ev.discipline, ev.place_slug]
      .filter(Boolean)
      .join(' '),
  ))
}

/**
 * 重建并灌入种子数据。
 * @param {{ reset?: boolean }} [opts]
 */
export async function seed({ reset = true } = {}) {
  const t0 = Date.now()
  if (reset) await resetSchema()
  else await migrate()

  const ds = await loadDatasets()
  const stats = { files: ds.files.length, sources: 0, places: 0, persons: 0, events: 0, claims: 0, quotes: 0, relations: 0, tech: 0, boundaries: 0, dynasties: 0 }

  // ---- sources ----
  const sources = uniqBy(ds.sources, 'slug')
  for (const s of sources) {
    await db.query(
      `INSERT INTO source (slug, title, author, era, kind, license, retrieved_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (slug) DO NOTHING`,
      [s.slug, s.title, s.author ?? null, s.era ?? null, s.kind ?? 'text', s.license ?? null, s.retrieved_url ?? null],
    )
    stats.sources++
  }

  // ---- places ----
  for (const p of uniqBy(ds.places, 'slug')) {
    await db.query(
      `INSERT INTO place (slug, name, aliases, lat, lon, admin_level, parent_slug, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (slug) DO NOTHING`,
      [p.slug, p.name, p.aliases ?? [], p.lat ?? null, p.lon ?? null, p.admin_level ?? null, p.parent_slug ?? null, p.note ?? null],
    )
    stats.places++
  }

  // ---- persons ----
  const personIdBySlug = new Map()
  for (const p of uniqBy(ds.persons, 'slug')) {
    const { rows } = await db.query(
      `INSERT INTO person (slug, name, aliases, birth_year, death_year, dynasty, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [p.slug, p.name, p.aliases ?? [], p.birth_year ?? null, p.death_year ?? null, p.dynasty ?? null, p.note ?? null],
    )
    personIdBySlug.set(p.slug, rows[0].id)
    stats.persons++
  }

  // ---- events ----
  for (const ev of uniqBy(ds.events, 'slug')) {
    const { rows } = await db.query(
      `INSERT INTO event (slug, title, track, category, discipline,
                          t_start_year, t_start_month, t_start_day,
                          t_end_year, t_end_month, t_end_day,
                          t_precision, t_certainty,
                          place_slug, lat, lon, summary, search_text, search_tsv, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,to_tsvector('simple', $19::text),'published')
       RETURNING id`,
      [
        ev.slug, ev.title, ev.track, ev.category, ev.discipline ?? null,
        ev.t_start_year, ev.t_start_month ?? null, ev.t_start_day ?? null,
        ev.t_end_year ?? null, ev.t_end_month ?? null, ev.t_end_day ?? null,
        ev.t_precision ?? 'year', ev.t_certainty ?? 'certain',
        ev.place_slug ?? null, ev.lat ?? null, ev.lon ?? null,
        ev.summary ?? null, searchTextOf(ev), searchTsvOf(ev),
      ],
    )
    const eventId = rows[0].id
    stats.events++

    // claims
    const claimIdByIndex = []
    const claims = ev.claims ?? []
    for (let i = 0; i < claims.length; i++) {
      const c = claims[i]
      const { rows: cr } = await db.query(
        `INSERT INTO event_claim (event_id, statement, evidence_level, confidence, disputed_group, adopted, rationale, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [eventId, c.statement, c.evidence_level ?? 'C', c.confidence ?? null,
         c.disputed_group ?? null, c.adopted ?? false, c.rationale ?? null, i],
      )
      claimIdByIndex.push(cr[0].id)
      stats.claims++
    }

    // sources / quotes
    for (const s of ev.sources ?? []) {
      let quoteSha = null
      if (s.quote) {
        const put = await putText(s.quote)
        quoteSha = put.sha256
        stats.quotes++
        await db.query(
          `INSERT INTO archive_blob (sha256, size, mime, storage_key)
           VALUES ($1,$2,'text/plain',$3) ON CONFLICT (sha256) DO NOTHING`,
          [put.sha256, put.size, put.key],
        )
      }
      const claimId = s.claim_index != null ? claimIdByIndex[s.claim_index] : null
      await db.query(
        `INSERT INTO event_source (event_id, claim_id, source_slug, locator, quote, quote_sha256, verified_status, verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [eventId, claimId, s.source_slug, s.locator ?? null, s.quote ?? null, quoteSha,
         quoteSha ? 'verified' : 'unverified', quoteSha ? new Date() : null],
      )
    }

    // persons
    for (const p of ev.persons ?? []) {
      const pid = personIdBySlug.get(p.slug)
      if (!pid) continue
      await db.query(
        `INSERT INTO event_person (event_id, person_id, role) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [eventId, pid, p.role ?? null],
      )
    }
  }

  // ---- relations ----
  for (const r of ds.relations) {
    await db.query(
      `INSERT INTO person_relation (from_slug, to_slug, type, t_start_year, t_end_year, source_slug)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [r.from_slug, r.to_slug, r.type, r.t_start_year ?? null, r.t_end_year ?? null, r.source_slug ?? null],
    )
    stats.relations++
  }

  // ---- tech ----
  for (const t of uniqBy(ds.tech, 'slug')) {
    await db.query(
      `INSERT INTO tech (slug, name, category, first_attested_year, region, place_slug, source_slug, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (slug) DO NOTHING`,
      [t.slug, t.name, t.category, t.first_attested_year ?? null, t.region ?? null,
       t.place_slug ?? null, t.source_slug ?? null, t.note ?? null],
    )
    stats.tech++
  }

  // ---- boundaries ----
  for (const b of ds.boundaries) {
    await db.query(
      `INSERT INTO boundary_slice (year, name, geojson, note) VALUES ($1,$2,$3,$4)`,
      [b.year, b.name, JSON.stringify(b.geojson), b.note ?? '示意边界，非学术精度'],
    )
    stats.boundaries++
  }

  // ---- dynasties（时间轴底色带）----
  for (const d of uniqBy(ds.dynasties, 'slug')) {
    await db.query(
      `INSERT INTO dynasty (slug, name, name_en, start_year, end_year, era_group, color, certainty, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (slug) DO NOTHING`,
      [d.slug, d.name, d.name_en ?? null, d.start_year, d.end_year,
       d.era_group ?? 'other', d.color ?? '#888888', d.certainty ?? 'certain', d.note ?? null],
    )
    stats.dynasties++
  }

  stats.elapsed_ms = Date.now() - t0
  return stats
}

export { loadDatasets }
