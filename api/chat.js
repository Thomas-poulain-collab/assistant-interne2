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

async function searchNotion(query) {
  const results = [];

  for (const dbId of NOTION_DATABASES) {
    try {
      const response = await notion.databases.query({
        database_id: dbId,
        filter: {
          or: [
            { property: 'Name', title: { contains: query.split(' ')[0] } },
            { property: 'Name', title: { contains: query.split(' ').slice(-1)[0] } },
          ]
        },
        page_size: 3,
      });

      for (const page of response.results) {
        const title = page.properties?.Name?.title?.[0]?.plain_text ||
                      page.properties?.Titre?.title?.[0]?.plain_text || 'Sans titre';
        const content = await getPageContent(page.id);
        results.push({
          title,
          url: page.url,
          content: content.slice(0, 1500),
        });
      }
    } catch (e) {
      console.error('DB error:', dbId, e.message);
    }
  }

  for (const pageId of NOTION_PAGES) {
    try {
      const page = await notion.pages.retrieve({ page_id: pageId });
      const title = page.properties?.title?.title?.[0]?.plain_text || 'Document';
      const content = await getPageContent(pageId);
      results.push({
        title,
        url: page.url,
        content: content.slice(0, 2000),
      });
    } catch (e) {
      console.error('Page error:', pageId, e.message);
    }
  }

  return results;
}

async function getPageContent(pageId) {
  try {
    const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 50 });
    return blocks.results
      .map(block => {
        const type = block.type;
        const content = block[type];
        if (!content?.rich_text) return '';
        return content.rich_text.map(t => t.plain_text).join('');
      })
      .filter(Boolean)
      .join('\n');
  } catch { return ''; }
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
Si l'information n'est pas dans les ressources, dis-le clairement.
Réponds en français, de façon concise et professionnelle.`,
        messages: [
          {
            role: 'user',
            content: `Ressources disponibles :\n\n${context}\n\n---\n\nQuestion du salarié : ${question}`
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
