const { Client } = require('@notionhq/client');
const { Redis } = require('@upstash/redis');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const redis = Redis.fromEnv();

const NOTION_DATABASES = [
  process.env.NOTION_DB_RH,
  process.env.NOTION_DB_MARQUES,
  process.env.NOTION_DB_PROCEDURES,
].filter(Boolean);

const NOTION_PAGES = [
  process.env.NOTION_PAGE_CONVENTION,
].filter(Boolean);

async function getPageContent(pageId) {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const propTexts = Object.entries(page.properties).map(([key, prop]) => {
      let value = '';
      if (prop.type === 'title') value = prop.title.map(t => t.plain_text).join('');
      else if (prop.type === 'rich_text') value = prop.rich_text.map(t => t.plain_text).join('');
      else if (prop.type === 'select') value = prop.select?.name || '';
      else if (prop.type === 'multi_select') value = prop.multi_select.map(s => s.name).join(', ');
      else if (prop.type === 'number') value = prop.number?.toString() || '';
      else if (prop.type === 'date') value = prop.date?.start || '';
      else if (prop.type === 'checkbox') value = prop.checkbox ? 'Oui' : 'Non';
      else if (prop.type === 'url') value = prop.url || '';
      else if (prop.type === 'email') value = prop.email || '';
      else if (prop.type === 'phone_number') value = prop.phone_number || '';
      if (value) return `${key}: ${value}`;
      return '';
    }).filter(Boolean).join('\n');

    const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 50 });
    const blockText = blocks.results
      .map(block => {
        const type = block.type;
        const content = block[type];
        if (!content?.rich_text) return '';
        return content.rich_text.map(t => t.plain_text).join('');
      })
      .filter(Boolean)
      .join('\n');

    return [propTexts, blockText].filter(Boolean).join('\n');
  } catch { return ''; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const key = req.headers['x-reindex-key'] || req.query.key;
  if (key !== process.env.REINDEX_KEY) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const dbIndex = parseInt(req.query.db || '0');
  const cursor = req.query.cursor || undefined;
  const isNew = dbIndex === 0 && !cursor;

  try {
    let index = [];
    if (!isNew) {
      const stored = await redis.get('notion_index_partial');
      if (stored) {
        index = typeof stored === 'string' ? JSON.parse(stored) : stored;
      }
    }

    if (dbIndex < NOTION_DATABASES.length) {
      const dbId = NOTION_DATABASES[dbIndex];
      const response = await notion.databases.query({
        database_id: dbId,
        page_size: 10,
        start_cursor: cursor,
      });

      for (const page of response.results) {
        const titleProp = Object.values(page.properties).find(p => p.type === 'title');
        const title = titleProp?.title?.[0]?.plain_text || 'Sans titre';
        const content = await getPageContent(page.id);
        if (content || title) {
          index.push({ title, url: page.url, content: content.slice(0, 1000) });
        }
      }

      await redis.set('notion_index_partial', JSON.stringify(index));

      if (response.has_more) {
        return res.status(200).json({
          status: 'continue',
          total: index.length,
          nextUrl: `/api/reindex?key=${key}&db=${dbIndex}&cursor=${response.next_cursor}`
        });
      } else {
        return res.status(200).json({
          status: 'continue',
          total: index.length,
          nextUrl: `/api/reindex?key=${key}&db=${dbIndex + 1}`
        });
      }
    }

    // Toutes les bases sont faites, on indexe les pages de doc
    for (const pageId of NOTION_PAGES) {
      try {
        const page = await notion.pages.retrieve({ page_id: pageId });
        const titleProp = Object.values(page.properties).find(p => p.type === 'title');
        const title = titleProp?.title?.[0]?.plain_text || 'Document';
        const content = await getPageContent(pageId);
        index.push({ title, url: page.url, content: content.slice(0, 5000) });
      } catch (e) {
        console.error('Page error:', pageId, e.message);
      }
    }

    // Sauvegarde finale
    await redis.set('notion_index', JSON.stringify(index));
    await redis.del('notion_index_partial');

    return res.status(200).json({ status: 'done', total: index.length });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
