const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const NOTION_DATABASES = [
  process.env.NOTION_DB_RH,
  process.env.NOTION_DB_MARQUES,
  process.env.NOTION_DB_PROCEDURES,
].filter(Boolean);

const NOTION_PAGES = [
  process.env.NOTION_PAGE_CONVENTION,
].filter(Boolean);

// Cache en mémoire
let cache = {
  data: [],
  lastUpdated: null,
};

const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 heures

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

async function buildIndex() {
  console.log('Construction de l\'index Notion...');
  const index = [];

  // Indexation des bases de données
  for (const dbId of NOTION_DATABASES) {
    try {
      let cursor = undefined;
      do {
        const response = await notion.databases.query({
          database_id: dbId,
          page_size: 100,
          start_cursor: cursor,
        });

        for (const page of response.results) {
          const titleProp = Object.values(page.properties).find(p => p.type === 'title');
          const title = titleProp?.title?.[0]?.plain_text || 'Sans titre';
          const content = await getPageContent(page.id);
          if (content || title) {
            index.push({ title, url: page.url, content: content.slice(0, 2000) });
          }
        }

        cursor = response.has_more ? response.next_cursor : undefined;
      } while (cursor);
    } catch (e) {
      console.error('DB error:', dbId, e.message);
    }
  }

  // Indexation des pages de documentation
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

  cache.data = index;
  cache.lastUpdated = Date.now();
  console.log(`Index construit : ${index.length} entrées`);
  return index;
}

async function getIndex() {
  const now = Date.now();
  if (!cache.lastUpdated || now - cache.lastUpdated > CACHE_DURATION) {
    await buildIndex();
  }
  return cache.data;
}

function searchIndex(index, query) {
  const words = query.toLowerCase().split(' ').filter(w => w.length > 2);
  return index.filter(entry => {
    const text = (entry.title + ' ' + entry.content).toLowerCase();
    return words.some(word => text.includes(word));
  }).slice(0, 15);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'Question manquante' });

  try {
    const index = await getIndex();
    const sources = searchIndex(index, question);

    const context = sources.length > 0
      ? sources.map(s => `=== ${s.title} ===\n${s.content}`).join('\n\n')
      : 'Aucune ressource trouvée.';

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: `Tu es l'assistant interne de l'entreprise. Tu réponds aux questions des salariés 
en te basant UNIQUEMENT sur les ressources Notion fournies. 
Tu cherches dans TOUTES les ressources disponibles pour trouver la meilleure réponse.
Si l'information n'est pas dans les ressources, dis-le clairement.
Réponds en français, de façon concise et professionnelle.`,
        messages: [
          {
            role: 'user',
            content: `Ressources disponibles :\n\n${context}\n\n---\n\nQuestion : ${question}`
          }
        ]
      }),
    });

    const data = await claudeRes.json();
    const answer = data.content?.[0]?.text || 'Impossible de générer une réponse.';

    res.json({ answer, sources: sources.map(s => ({ title: s.title, url: s.url })) });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
};
