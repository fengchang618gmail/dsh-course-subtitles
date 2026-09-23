// Feishu output: tenant token (cached), docx create/blocks/wiki placement,
// week-node grouping, idempotent skip, force rebuild (delete old doc via drive API).
import { request, postJsonRetry } from './http.js';
import { feishuTokenFrom, feishuDomainOf } from './config.js';
import { sanitizeText } from './text.js';
import { normalizeSectionStarts } from './sections.js';

const BASE = 'https://open.feishu.cn/open-apis';

// Final gate: every string that reaches the Feishu doc is sanitized so lone
// surrogates / control chars / U+FFFD can never render as ��� in the document.
function textBlock(content) {
  return { block_type: 2, text: { elements: [{ text_run: { content: sanitizeText(content), text_element_style: {} } }], style: { align: 1 } } };
}
function headingBlock(level, content) {
  const key = `heading${level}`;
  return { block_type: 2 + level, [key]: { elements: [{ text_run: { content: sanitizeText(content), text_element_style: {} } }], style: { align: 1 } } };
}

/**
 * Feishu's docx API expects link targets to be percent-encoded; it decodes them
 * once when building the hyperlink.
 */
export function encodeLinkUrl(url) {
  return encodeURIComponent(String(url ?? '').trim());
}

/** Public wiki URL of a node (the tenant host comes from the configured parent). */
export function feishuWikiUrl(nodeToken, cfg = {}) {
  return `https://${feishuDomainOf(cfg)}/wiki/${nodeToken}`;
}

/** One styled text run; pass `link` for a clickable hyperlink. */
export function textRun(content, { link = '', bold = false } = {}) {
  const style = {};
  if (link) style.link = { url: encodeLinkUrl(link) };
  if (bold) style.bold = true;
  return { text_run: { content: sanitizeText(content), text_element_style: style } };
}

/** A block built from already-styled runs (supports links, bold, ...). */
export function richBlock(blockType, key, elements) {
  return { block_type: blockType, [key]: { elements, style: { align: 1 } } };
}

export function richTextBlock(elements) {
  return richBlock(2, 'text', elements);
}

export function bulletBlock(elements) {
  return richBlock(12, 'bullet', elements);
}

export function headingBlockFromRuns(level, elements) {
  return richBlock(2 + level, `heading${level}`, elements);
}

/**
 * Course Outline document: H1 title, H2 week/module blocks, optional H3
 * subtopics, and one bullet per video holding its title.
 *
 * Entries are PLAIN TEXT by default: the video link is dropped, so the doc
 * carries no hyperlink runs at all. Pass `links: true` (config `outlineLinks`)
 * to make each title clickable again.
 */
export function buildOutlineBlocks({ outline, docTitle, meta, links = false }) {
  const blocks = [];
  blocks.push(headingBlock(1, docTitle));
  if (meta) blocks.push(textBlock(meta));
  const videoBullet = links
    ? (entry) => bulletBlock([textRun(entry.text, { link: entry.url })])
    : (entry) => bulletBlock([textRun(entry.text)]);
  for (const group of outline.groups || []) {
    if (group.title) blocks.push(headingBlock(2, group.title));
    const children = group.children?.length
      ? group.children
      : [...(group.items || []), ...(group.subgroups || [])];
    for (const child of children) {
      if (child.kind === 'subgroup') {
        if (child.title) blocks.push(headingBlock(3, child.title));
        for (const entry of child.items || []) blocks.push(videoBullet(entry));
      } else {
        blocks.push(videoBullet(child));
      }
    }
  }
  return blocks;
}

export function buildDocBlocks({ lesson, pairs, sections, meta }) {
  const blocks = [];
  blocks.push(headingBlock(1, `${lesson.name}${lesson.zhName ? ' ' + lesson.zhName : ''}`));
  if (meta) blocks.push(textBlock(meta));
  // last line of defence: a heading is only emitted between two paragraphs when
  // the preceding paragraph finishes its sentence (never inside a sentence)
  const starts = new Map(normalizeSectionStarts(pairs, sections).map((s) => [s.start, s]));
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (!p) continue;
    const en = sanitizeText(p.en);
    const zh = sanitizeText(p.zh);
    if (!en && !zh) continue;
    const sec = starts.get(i);
    if (sec && sec.title_en && sec.title_zh) blocks.push(headingBlock(2, `${sec.title_en} ${sec.title_zh}`));
    blocks.push(textBlock(en));
    if (zh) blocks.push(textBlock(zh));
  }
  return blocks;
}

export function makeFeishuClient(cfg, { tokenCache } = {}) {
  let cached = tokenCache || { token: null, expiresAt: 0 };

  async function tenantToken() {
    if (cached.token && Date.now() < cached.expiresAt) return cached.token;
    const j = await postJsonRetry(`${BASE}/auth/v3/tenant_access_token/internal`, {
      app_id: cfg.feishuAppId,
      app_secret: cfg.feishuAppSecret,
    });
    if (j.code !== 0) throw new Error(`feishu auth failed: ${j.msg}`);
    cached.token = j.tenant_access_token;
    cached.expiresAt = Date.now() + (j.expire - 60) * 1000;
    return cached.token;
  }

  async function api(method, path, body) {
    const token = await tenantToken();
    const r = await request(method, `${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      body: body !== undefined ? body : undefined,
      timeoutMs: 90000,
    });
    let j;
    try {
      j = JSON.parse(r.body);
    } catch {
      throw new Error(`feishu ${method} ${path} -> ${r.status}: ${r.body.slice(0, 200)}`);
    }
    if (process.env.CS_DEBUG) console.log(`[cs-debug] ${method} ${path} -> ${r.status} ${r.body.slice(0, 400)}`);
    if (j.code !== 0) {
      // transient retry for 99991400 (rate limit) etc.
      if (j.code === 99991400) {
        await new Promise((res) => setTimeout(res, 2000));
        return api(method, path, body);
      }
      throw new Error(`feishu ${method} ${path}: ${j.msg} (${j.code})`);
    }
    return j.data;
  }

  async function listChildren(parentToken) {
    const items = [];
    let pageToken = '';
    do {
      const d = await api('GET', `/wiki/v2/spaces/${cfg.feishuSpaceId || ''}/nodes?parent_node_token=${parentToken}&page_size=50${pageToken ? '&page_token=' + pageToken : ''}`);
      items.push(...(d.items || []));
      pageToken = d.page_token;
    } while (pageToken);
    return items;
  }

  async function createDoc(title) {
    const d = await api('POST', '/docx/v1/documents', { title });
    return d.document.document_id;
  }

  async function addBlocks(docId, blocks) {
    const url = `/docx/v1/documents/${docId}/blocks/${docId}/children?document_revision_id=-1`;
    let added = 0;
    for (let i = 0; i < blocks.length; i += 30) {
      const chunk = blocks.slice(i, i + 30);
      try {
        await api('POST', url, { children: chunk });
        added += chunk.length;
      } catch (e) {
        // fall back one-by-one
        for (const b of chunk) {
          try {
            await api('POST', url, { children: [b] });
            added++;
          } catch (e2) {
            console.log(`  block fail: ${e2.message}`);
          }
          await new Promise((res) => setTimeout(res, 120));
        }
      }
      await new Promise((res) => setTimeout(res, 150));
    }
    return added;
  }

  async function moveToWiki(docId, parentNodeToken, title) {
    const d = await api('POST', `/wiki/v2/spaces/${cfg.feishuSpaceId || ''}/nodes/move_docs_to_wiki`, {
      parent_wiki_token: parentNodeToken,
      obj_type: 'docx',
      obj_token: docId,
    });
    if (d.wiki_token) return d.wiki_token;
    // async move: poll the parent's children until the doc's node settles
    for (let i = 0; i < 24; i++) {
      await new Promise((res) => setTimeout(res, 500));
      const kids = await listChildren(parentNodeToken);
      const hit = kids.find((k) => k.obj_token === docId) || (title ? kids.find((k) => k.title === title) : null);
      if (hit) return hit.node_token;
    }
    throw new Error(`async move did not settle in time: ${JSON.stringify(d).slice(0, 200)}`);
  }

  async function listBlockChildren(docId, blockId = docId) {
    const out = [];
    let pageToken = '';
    do {
      const q = `page_size=500${pageToken ? '&page_token=' + encodeURIComponent(pageToken) : ''}`;
      const d = await api('GET', `/docx/v1/documents/${docId}/blocks/${blockId}/children?${q}&document_revision_id=-1`);
      out.push(...(d.items || []));
      pageToken = d.has_more ? d.page_token : '';
    } while (pageToken);
    return out;
  }

  async function deleteBlockRange(docId, blockId, from, to) {
    await api('DELETE', `/docx/v1/documents/${docId}/blocks/${blockId}/children/batch_delete?document_revision_id=-1`, {
      start_index: from,
      end_index: to,
    });
  }

  /**
   * Replace the whole body of an existing doc in place — the doc keeps its
   * wiki node token, so every previously shared link keeps working.
   */
  async function replaceBlocks(docId, blocks) {
    let count = (await listBlockChildren(docId)).length;
    while (count > 0) {
      const n = Math.min(count, 500);
      await deleteBlockRange(docId, docId, 0, n);
      count -= n;
    }
    return addBlocks(docId, blocks);
  }

  /** Rename a wiki node (used when only whitespace in the title changed). */
  async function updateNodeTitle(nodeToken, title) {
    await api('POST', `/wiki/v2/spaces/${cfg.feishuSpaceId || ''}/nodes/${encodeURIComponent(nodeToken)}/update_title`, { title });
  }

  async function deleteDoc(docId) {
    await api('DELETE', `/drive/v1/files/${docId}?type=docx`);
  }

  return { tenantToken, listChildren, createDoc, addBlocks, listBlockChildren, replaceBlocks, moveToWiki, updateNodeTitle, deleteDoc, api };
}

/** Resolve the space id from a parent node once (cached). */
export async function resolveSpaceId(cfg, client) {
  if (cfg.feishuSpaceId) return cfg.feishuSpaceId;
  const parent = feishuTokenFrom(cfg.feishuParent);
  const d = await client.api('GET', `/wiki/v2/spaces/get_node?token=${parent}`);
  return d.node.space_id;
}
