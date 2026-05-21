const { Client } = require('@notionhq/client');
const { Redis } = require('@upstash/redis');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const redis = Redis.fromEnv();

async function getBlocksRecursive(blockId) {
  let text = '';
  try {
    const blocks = await notion.blocks.children.list({ block_id: blockId, page_size: 100 });
    for (const block of blocks.results) {
      const type = block.type;
      const content = block[type];
      if (content?.rich_text) {
        const blockText = content.rich_text.map(t => t.plain_text).join('');
        if (blockText) text += blockText + '\n';
      }
      // Récupère aussi le contenu des sous-blocs
      if (block.has_children) {
        text += await getBlocksRecursive(block.id);
      }
    }
  } catch (e) {
    console.error('Block error:', e.message);
  }
  return text;
}

function searchIndex(content, query) {
  const words = query.toLowerCase().split(' ').filter(w => w.length > 2);
  const lines = content.split('\n');
  const results = [];
  let currentSection = '';
  let currentText = '';

  for (const line of lines) {
    if (line.startsWith('# ') || line.startsWith('## ')) {
      if (currentSection && currentText) {
        const sectionLower = (currentSection + ' ' + currentText).toLowerCase();
        if (words.some(w => sectionLower.includes(w))) {
          results.push({ section: currentSection, text: currentText.slice(0, 1500) });
        }
      }
      currentSection = line.replace(/^#+\s/, '');
      currentText = '';
    } else {
      currentText += line + '\n';
    }
  }

  // Dernière section
  if (currentSection && currentText) {
    const sectionLower = (currentSection + ' ' + currentText).toLowerCase();
    if (words.some(w => sectionLower.includes(w))) {
      results.push({ section: currentSection, text: currentText.slice(0, 1500) });
    }
  }

  return results.slice(0, 10);
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
    // Lecture depuis Redis
    let content = await redis.get('notion_source');

    if (!content) {
      return res.json({
        answer: "L'index est en cours de construction, merci de réessayer dans quelques minutes.",
        sources: []
      });
    }

    if (typeof content !== 'string') content = JSON.stringify(content);

    const sections = searchIndex(content, question);
    const context = sections.length > 0
      ? sections.map(s => `=== ${s.section} ===\n${s.text}`).join('\n\n')
      : 'Aucune information trouvée sur ce sujet.';

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
en te basant UNIQUEMENT sur les ressources fournies. 
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

    res.json({ answer, sources: [] });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
};
