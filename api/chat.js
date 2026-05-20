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
    // Lecture de l'index depuis Redis
    let index = await redis.get('notion_index');

    if (!index) {
      return res.json({
        answer: "L'index est en cours de construction, merci de réessayer dans quelques minutes. Un administrateur doit lancer la première indexation via /api/reindex.",
        sources: []
      });
    }

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
