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

async function searchNotion(query) {
  const results = [];

  const dbPromises = NOTION_DATABASES.map(async (dbId) => {
    try {
      const response = await notion.databases.query({
        database_id: dbId,
        page_size: 10,
      });

      const pagePromises = response.results.map(async (page) => {
        const titleProp = Object.values(page.properties).find(p => p.type === 'title');
        const title = titleProp?.title?.[0]?.plain_text || 'Sans titre';
        const content = await getPageContent(page.id);
        if (content) {
          return { title, url: page.url, content: content.slice(0, 1500) };
        }
        return null;
      });

      const pages = await Promise.all(pagePromises);
      return pages.filter(Boolean);
    } catch (e) {
      console.error('DB error:', dbId, e.message);
      return [];
    }
  });

  const pagePromises = NOTION_PAGES.map(async (pageId) => {
    try {
      const page = await notion.pages.retrieve({ page_id: pageId });
      const titleProp = Object.values(page.properties).find(p => p.type === 'title');
      const title = titleProp?.title?.[0]?.plain_text || 'Document';
      const content = await getPageContent(pageId);
      return { title, url: page.url, content: content.slice(0, 2000) };
    } catch (e) {
      console.error('Page error:', pageId, e.message);
      return null;
    }
  });

  const [dbResults, pageResults] = await Promise.all([
    Promise.all(dbPromises),
    Promise.all(pagePromises),
  ]);

  dbResults.forEach(r => results.push(...r));
  pageResults.filter(Boolean).forEach(r => results.push(r));

  return results;
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
    const sources = await searchNotion(question);
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

    res.json({
      answer,
      sources: sources.map(s => ({ title: s.title, url: s.url })),
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
};
